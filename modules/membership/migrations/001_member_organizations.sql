-- ============================================================================
-- membership module — schema
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  END IF;
  -- Grant the role to the calling user so subsequent ALTER TABLE
  -- ... OWNER TO gatewaze_module_writer doesn't trip 42501 on
  -- Supabase Cloud (where postgres isn't a true superuser and needs
  -- explicit role membership to transfer ownership).
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $$;

-- Tier name → numeric rank lookup. Higher rank = higher promotion.
-- Operators can edit / extend.
CREATE TABLE IF NOT EXISTS public.membership_tier_ranks (
  tier           text PRIMARY KEY,
  rank           int NOT NULL,
  display_label  text NOT NULL,
  color          text,
  description    text,
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_tier_ranks OWNER TO gatewaze_module_writer;

-- Member organizations.
CREATE TABLE IF NOT EXISTS public.member_organizations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text NOT NULL UNIQUE,
  website_url       text,
  description       text,

  tier              text NOT NULL REFERENCES public.membership_tier_ranks(tier),
  tier_rank         int NOT NULL,           -- denormalized from tier_ranks for the rule sync

  logo_source_url   text,
  logo_url          text,                   -- public URL after Supabase storage upload
  logo_synced_at    timestamptz,

  source_url        text,                   -- the AAIF page URL we scraped
  last_synced_at    timestamptz,

  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active         boolean NOT NULL DEFAULT true,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_organizations OWNER TO gatewaze_module_writer;

CREATE INDEX IF NOT EXISTS idx_member_orgs_tier_rank
  ON public.member_organizations (tier_rank DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_member_orgs_slug
  ON public.member_organizations (slug);

-- Sync runs (audit / progress UI).
CREATE TABLE IF NOT EXISTS public.membership_sync_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url          text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','complete','failed','canceled')),
  members_seen        int NOT NULL DEFAULT 0,
  members_inserted    int NOT NULL DEFAULT 0,
  members_updated     int NOT NULL DEFAULT 0,
  members_deactivated int NOT NULL DEFAULT 0,
  logos_downloaded    int NOT NULL DEFAULT 0,
  error_message       text,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_sync_runs OWNER TO gatewaze_module_writer;

-- Update updated_at on member edits.
CREATE OR REPLACE FUNCTION public.member_orgs_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS member_orgs_updated_at ON public.member_organizations;
CREATE TRIGGER member_orgs_updated_at BEFORE UPDATE
  ON public.member_organizations
  FOR EACH ROW EXECUTE FUNCTION public.member_orgs_set_updated_at();

-- RLS: admin-only edit; everyone reads (used by public-facing logo display).
ALTER TABLE public.member_organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mo_service ON public.member_organizations;
CREATE POLICY mo_service ON public.member_organizations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS mo_read ON public.member_organizations;
CREATE POLICY mo_read ON public.member_organizations
  FOR SELECT TO authenticated, anon USING (true);

ALTER TABLE public.membership_tier_ranks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mtr_service ON public.membership_tier_ranks;
CREATE POLICY mtr_service ON public.membership_tier_ranks
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS mtr_read ON public.membership_tier_ranks;
CREATE POLICY mtr_read ON public.membership_tier_ranks
  FOR SELECT TO authenticated, anon USING (true);

ALTER TABLE public.membership_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS msr_service ON public.membership_sync_runs;
CREATE POLICY msr_service ON public.membership_sync_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS msr_admin ON public.membership_sync_runs;
CREATE POLICY msr_admin ON public.membership_sync_runs
  FOR SELECT TO authenticated USING (true);
