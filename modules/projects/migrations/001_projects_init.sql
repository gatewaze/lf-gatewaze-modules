-- ============================================================================
-- Module: projects
-- Migration: 001_projects_init
-- Description: Portfolio table for open-source / standards projects that the
--              AAIF-style home page ProjectsSection renders. Each site can
--              maintain its own list (multi-tenant via site_id). The public
--              API reads rows with status='published'; admins write via the
--              admin endpoints (service-role) or via Postgres directly.
-- Idempotent: uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--             DO $$ IF NOT EXISTS guards. Safe to reapply.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  slug              text NOT NULL,
  title             text NOT NULL,
  short_description text,
  long_description  text,
  -- Logos / branding
  logo_url          text,
  logo_alt          text,
  cover_image_url   text,
  -- Links
  website_url       text,
  github_url        text,
  docs_url          text,
  -- Taxonomy
  category          text,
  tags              text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived')),
  is_featured       boolean NOT NULL DEFAULT false,
  sort_order        int NOT NULL DEFAULT 0,
  -- Metadata
  maintainer_org    text,
  license           text,
  founded_at        date,
  -- Lifecycle
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT projects_site_slug_unique UNIQUE (site_id, slug)
);

COMMENT ON TABLE public.projects IS 'Portfolio projects (open-source / standards) rendered by the home-page ProjectsSection. Multi-tenant via site_id.';

CREATE INDEX IF NOT EXISTS projects_site_status_sort_idx
  ON public.projects (site_id, status, sort_order);

CREATE INDEX IF NOT EXISTS projects_site_slug_idx
  ON public.projects (site_id, slug);

-- updated_at trigger (shared platform helper). Re-create idempotently.
DROP TRIGGER IF EXISTS projects_updated_at ON public.projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- anon: read published rows only.
DROP POLICY IF EXISTS "projects_select_published_anon" ON public.projects;
CREATE POLICY "projects_select_published_anon"
  ON public.projects FOR SELECT TO anon
  USING (status = 'published');

-- authenticated: read all rows (admin UI shows drafts/archived too;
-- the app gates whether the caller has access to the site separately).
DROP POLICY IF EXISTS "projects_select_authenticated" ON public.projects;
CREATE POLICY "projects_select_authenticated"
  ON public.projects FOR SELECT TO authenticated
  USING (true);

-- Writes are admin-only. The service-role key bypasses RLS, which is
-- what the admin-routes handler uses; this policy fences off
-- inadvertent writes from JWT'd clients.
DROP POLICY IF EXISTS "projects_insert_admin" ON public.projects;
CREATE POLICY "projects_insert_admin"
  ON public.projects FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "projects_update_admin" ON public.projects;
CREATE POLICY "projects_update_admin"
  ON public.projects FOR UPDATE TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "projects_delete_admin" ON public.projects;
CREATE POLICY "projects_delete_admin"
  ON public.projects FOR DELETE TO authenticated
  USING (public.is_admin());
