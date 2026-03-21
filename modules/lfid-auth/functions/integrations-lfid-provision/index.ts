import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * LFID Provision Edge Function
 *
 * Looks up or creates an LFID (Linux Foundation ID) for a person.
 * Called after event registration (e.g. Luma webhook) to ensure every
 * registrant has an LFID linked to their Gatewaze person record.
 *
 * Endpoints:
 *   POST /functions/v1/integrations-lfid-provision
 *     body: { person_id: number, email: string, first_name?: string, last_name?: string }
 *
 *   POST /functions/v1/integrations-lfid-provision/lookup
 *     body: { email: string }
 *     Returns whether an LFID exists for the given email (no provisioning)
 *
 * Requires Auth0 Management API credentials in module config:
 *   AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET
 */

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

// CORS headers for edge function
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// --------------------------------------------------------------------------
// Auth0 Management API helpers
// --------------------------------------------------------------------------

interface Auth0Config {
  domain: string
  mgmtClientId: string
  mgmtClientSecret: string
}

let mgmtTokenCache: { token: string; expiresAt: number } | null = null

async function getAuth0MgmtToken(config: Auth0Config): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (mgmtTokenCache && Date.now() < mgmtTokenCache.expiresAt - 60_000) {
    return mgmtTokenCache.token
  }

  const res = await fetch(`https://${config.domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.mgmtClientId,
      client_secret: config.mgmtClientSecret,
      audience: `https://${config.domain}/api/v2/`,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Auth0 token request failed (${res.status}): ${body}`)
  }

  const data = await res.json()
  mgmtTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
  return data.access_token
}

interface Auth0User {
  user_id: string
  email: string
  name?: string
  username?: string
  picture?: string
  created_at?: string
}

async function lookupAuth0User(config: Auth0Config, email: string): Promise<Auth0User | null> {
  const token = await getAuth0MgmtToken(config)
  const encodedEmail = encodeURIComponent(email.toLowerCase())

  const res = await fetch(
    `https://${config.domain}/api/v2/users-by-email?email=${encodedEmail}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Auth0 user lookup failed (${res.status}): ${body}`)
  }

  const users: Auth0User[] = await res.json()
  return users.length > 0 ? users[0] : null
}

async function createAuth0User(
  config: Auth0Config,
  email: string,
  firstName?: string,
  lastName?: string,
): Promise<Auth0User> {
  const token = await getAuth0MgmtToken(config)
  const name = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0]

  const res = await fetch(`https://${config.domain}/api/v2/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      connection: 'Username-Password-Authentication',
      email: email.toLowerCase(),
      name,
      // Generate a random password — the user will use "Forgot Password" or
      // social login to set their own password on first use
      password: crypto.randomUUID() + crypto.randomUUID().toUpperCase() + '!',
      email_verified: false,
      verify_email: true,
      user_metadata: {
        first_name: firstName,
        last_name: lastName,
        provisioned_by: 'gatewaze',
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Auth0 user creation failed (${res.status}): ${body}`)
  }

  return await res.json()
}

// --------------------------------------------------------------------------
// Module config loader
// --------------------------------------------------------------------------

async function getModuleConfig(): Promise<Auth0Config | null> {
  const { data } = await supabase
    .from('installed_modules')
    .select('config')
    .eq('id', 'lfid-auth')
    .eq('status', 'enabled')
    .single()

  if (!data?.config) return null

  const config = data.config as Record<string, string>
  const domain = config.AUTH0_DOMAIN
  const mgmtClientId = config.AUTH0_MGMT_CLIENT_ID
  const mgmtClientSecret = config.AUTH0_MGMT_CLIENT_SECRET

  if (!domain || !mgmtClientId || !mgmtClientSecret) return null

  return { domain, mgmtClientId, mgmtClientSecret }
}

// --------------------------------------------------------------------------
// Main handler
// --------------------------------------------------------------------------

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const isLookupOnly = url.pathname.endsWith('/lookup')

    const body = await req.json()
    const { person_id, email, first_name, last_name } = body

    if (!email) {
      return new Response(
        JSON.stringify({ error: 'email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Load Auth0 Management API config
    const auth0Config = await getModuleConfig()
    if (!auth0Config) {
      return new Response(
        JSON.stringify({ error: 'LFID auth module not configured — set Auth0 Management API credentials' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Check if we already have a mapping
    const { data: existingMapping } = await supabase
      .from('integrations_lfid_mappings')
      .select('*')
      .eq('person_email', email.toLowerCase())
      .maybeSingle()

    if (existingMapping) {
      return new Response(
        JSON.stringify({
          status: 'exists',
          auth0_user_id: existingMapping.auth0_user_id,
          lfid_username: existingMapping.lfid_username,
          provisioned_by: existingMapping.provisioned_by,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Look up user in Auth0
    const auth0User = await lookupAuth0User(auth0Config, email)

    if (auth0User) {
      // User exists in Auth0 — create mapping
      if (!isLookupOnly && person_id) {
        await supabase.from('integrations_lfid_mappings').upsert({
          person_id,
          person_email: email.toLowerCase(),
          auth0_user_id: auth0User.user_id,
          lfid_username: auth0User.username || null,
          provisioned_by: 'registration',
        }, { onConflict: 'brand_id,person_id' })
      }

      return new Response(
        JSON.stringify({
          status: 'found',
          auth0_user_id: auth0User.user_id,
          lfid_username: auth0User.username || null,
          created: false,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // User does not exist in Auth0
    if (isLookupOnly) {
      return new Response(
        JSON.stringify({ status: 'not_found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Check if provisioning is enabled
    const moduleConfig = await supabase
      .from('installed_modules')
      .select('config')
      .eq('id', 'lfid-auth')
      .single()
    const provisionEnabled = moduleConfig.data?.config?.LFID_PROVISION_ON_REGISTRATION !== 'false'

    if (!provisionEnabled) {
      return new Response(
        JSON.stringify({ status: 'not_found', provisioning_disabled: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Create user in Auth0
    const newUser = await createAuth0User(auth0Config, email, first_name, last_name)

    // Create mapping
    if (person_id) {
      await supabase.from('integrations_lfid_mappings').upsert({
        person_id,
        person_email: email.toLowerCase(),
        auth0_user_id: newUser.user_id,
        lfid_username: newUser.username || null,
        provisioned_by: 'registration',
      }, { onConflict: 'brand_id,person_id' })
    }

    console.log(`[lfid-provision] Created LFID for ${email}: ${newUser.user_id}`)

    return new Response(
      JSON.stringify({
        status: 'created',
        auth0_user_id: newUser.user_id,
        lfid_username: newUser.username || null,
        created: true,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[lfid-provision] Error:', err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
