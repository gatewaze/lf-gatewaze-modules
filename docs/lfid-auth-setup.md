# LFID Authentication Setup Guide

## Overview

The `lfid-auth` module integrates Linux Foundation ID (LFID) authentication into Gatewaze using Supabase's Auth0 third-party provider. This replaces the default magic link sign-in with LFID SSO for both the portal and admin UI.

## Architecture

```
User clicks "Sign in with LFID"
  → Supabase Auth redirects to LF Auth0 tenant
  → User authenticates with LFID (username/password, social, etc.)
  → Auth0 redirects back to Supabase callback URL
  → Supabase creates/links the auth session
  → App picks up session via onAuthStateChange
```

For LFID provisioning on event registration:
```
Person registers via Luma → Luma webhook fires
  → Registration processed → Person record created
  → lfid-provision edge function called
  → Looks up email in Auth0 Management API
  → If found: creates mapping in integrations_lfid_mappings
  → If not found: creates Auth0 user + sends verification email + creates mapping
```

---

## Step 1: Request Auth0 Client from LF Team

Create a Jira ticket at: https://jira.linuxfoundation.org/plugins/servlet/desk/portal/3/create/100

### Ticket Details

**Summary:** New Auth0 client for Gatewaze (AAIF) — Supabase Auth0 integration

**Description:**

We need a Regular Web Application client registered in the LF Auth0 tenant for the AAIF meetup and content management platform (built on Gatewaze/Supabase).

**Application Details:**
- **Application Name:** Gatewaze AAIF (dev) / Gatewaze AAIF (prod)
- **Application Type:** Regular Web Application
- **Framework:** Supabase Auth (third-party Auth0 provider)

**Callback URLs (dev):**
```
https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback
```

**Callback URLs (prod):**
```
https://<PROD_SUPABASE_URL>/auth/v1/callback
```

**Allowed Logout URLs:**
```
https://aaif.gatewaze.com
https://admin.aaif.gatewaze.com
http://localhost:3000
http://localhost:5173
```

**Allowed Web Origins:**
```
https://aaif.gatewaze.com
https://admin.aaif.gatewaze.com
http://localhost:3000
http://localhost:5173
```

**Required Scopes:**
```
openid profile email
```

**Group/Role Claim:**

Supabase uses custom JWT claims to determine user roles for Row Level Security (RLS). We need a custom claim added to the ID token via an Auth0 post-login action:

- **Claim name:** `https://gatewaze.com/roles`
- **Claim value:** Array of role strings, e.g. `["admin"]`, `["editor"]`, or `[]`
- Roles should map from Auth0 roles or group membership

Example post-login action:
```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://gatewaze.com/';
  const roles = event.authorization?.roles || [];
  api.idToken.setCustomClaim(namespace + 'roles', roles);
  api.accessToken.setCustomClaim(namespace + 'roles', roles);
};
```

**Management API Access (optional but recommended):**

For auto-provisioning LFIDs when people register for events, we also need a Machine-to-Machine application with:
- **Scopes:** `read:users`, `create:users`
- **Audience:** `https://linuxfoundation.auth0.com/api/v2/`

This allows us to:
1. Look up if a registrant already has an LFID by email
2. Create an LFID for new registrants (sends verification email)

If M2M access isn't possible, the provisioning feature can be disabled and only SSO login will be active.

---

## Step 2: Configure Supabase Auth0 Provider

In the Supabase Dashboard (or via API):

1. Go to **Authentication → Providers → Auth0**
2. Enable the Auth0 provider
3. Enter:
   - **Auth0 Domain:** `linuxfoundation.auth0.com` (or the domain provided by LF team)
   - **Client ID:** (from the LF-registered client)
   - **Client Secret:** (from the LF-registered client)

Or via Supabase Management API:
```bash
curl -X PATCH "https://api.supabase.com/v1/projects/<ref>/config/auth" \
  -H "Authorization: Bearer <service_role_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "EXTERNAL_AUTH0_ENABLED": true,
    "EXTERNAL_AUTH0_CLIENT_ID": "<client_id>",
    "EXTERNAL_AUTH0_SECRET": "<client_secret>",
    "EXTERNAL_AUTH0_URL": "https://linuxfoundation.auth0.com"
  }'
```

## Step 3: Configure Module in Gatewaze

1. Navigate to **Admin → Integrations → LFID Authentication**
2. Enter the Auth0 credentials:
   - **AUTH0_DOMAIN:** `linuxfoundation.auth0.com`
   - **AUTH0_CLIENT_ID:** (same as Supabase config)
   - **AUTH0_CLIENT_SECRET:** (same as Supabase config)
   - **AUTH0_ROLE_CLAIM:** `https://gatewaze.com/roles` (must match Auth0 action)
3. For auto-provisioning (optional):
   - **AUTH0_MGMT_CLIENT_ID:** (M2M app client ID)
   - **AUTH0_MGMT_CLIENT_SECRET:** (M2M app client secret)
   - **LFID_PROVISION_ON_REGISTRATION:** `true`

## Step 4: Enable the Module

1. Navigate to **Admin → Modules**
2. Find "LFID Authentication" and toggle it to **Enabled**
3. The module will run its migration to create the `integrations_lfid_mappings` table

## How It Works

### Portal Sign-In
When the module is enabled, the portal sign-in page shows a "Sign in with LFID" button below the magic link form. Clicking it initiates the OAuth flow:
1. Supabase redirects to Auth0
2. Auth0 handles LFID authentication
3. Auth0 redirects back to Supabase callback
4. Supabase creates a session with Auth0 claims
5. Portal sign-in page picks up the session

### Admin Sign-In
Same flow as portal. After Auth0 callback, the admin auth context checks if the authenticated email has an `admin_profiles` record. If not, the user sees "Need an admin account? Contact the administrator."

### LFID Provisioning on Registration
When a person registers for an event via Luma:
1. Luma webhook fires and creates the person/registration
2. The `integrations-lfid-provision` edge function is called
3. It looks up the email in the LF Auth0 tenant via Management API
4. If the user exists: creates a mapping record
5. If not: creates an Auth0 user (which sends a verification email) and creates a mapping

### Role Mapping
The Auth0 post-login action adds roles to the JWT. Supabase stores these in `raw_app_meta_data`. The admin auth service can read the role claim to determine admin access level.
