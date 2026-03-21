-- LFID Auth Module: Mapping table between Gatewaze people and LF Auth0 identities
-- This tracks which people have an LFID and stores their Auth0 user_id for lookups.

CREATE TABLE IF NOT EXISTS integrations_lfid_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL DEFAULT (current_setting('app.brand_id', true))::uuid,

  -- Link to Gatewaze person
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  person_email TEXT NOT NULL,

  -- Auth0 / LFID identity
  auth0_user_id TEXT NOT NULL,          -- e.g. 'auth0|abc123' from LF Auth0 tenant
  lfid_username TEXT,                    -- LF username if available from user profile

  -- Provisioning metadata
  provisioned_by TEXT NOT NULL DEFAULT 'manual',  -- 'manual', 'sso_login', 'registration', 'bulk_import'
  provisioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT uq_lfid_person UNIQUE (brand_id, person_id),
  CONSTRAINT uq_lfid_auth0_user UNIQUE (brand_id, auth0_user_id)
);

-- Index for email lookups during provisioning
CREATE INDEX IF NOT EXISTS idx_lfid_mappings_email ON integrations_lfid_mappings(brand_id, person_email);

-- RLS policies
ALTER TABLE integrations_lfid_mappings ENABLE ROW LEVEL SECURITY;

-- Admins can read all LFID mappings
CREATE POLICY lfid_mappings_admin_read ON integrations_lfid_mappings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_profiles
      WHERE admin_profiles.id = auth.uid()
        AND admin_profiles.is_active = true
    )
  );

-- Service role can do everything (used by edge functions)
CREATE POLICY lfid_mappings_service_all ON integrations_lfid_mappings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Updated_at trigger
CREATE OR REPLACE TRIGGER set_lfid_mappings_updated_at
  BEFORE UPDATE ON integrations_lfid_mappings
  FOR EACH ROW
  EXECUTE FUNCTION moddatetime(updated_at);
