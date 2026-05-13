-- ============================================================================
-- Module: press
-- Migration: 001_press_init
-- Description: Press releases authored by the site owner (kind='release' /
--              'announcement') and external press coverage that links out
--              (kind='coverage'). The AAIF home-page WrittenContentHub
--              "Press & News" tab consumes the public /api/press list to
--              render cards. Multi-tenant via site_id.
-- Idempotent: uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--             DROP-then-CREATE for policies + trigger. Safe to reapply.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.press_releases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  slug                text NOT NULL,                       -- url-safe
  title               text NOT NULL,
  summary             text,                                -- 1-line card description
  body                text,                                -- markdown for detail page (optional for kind='coverage')
  -- Type discriminator: press release authored by the site owner vs external coverage
  kind                text NOT NULL DEFAULT 'release'
                      CHECK (kind IN ('release','coverage','announcement')),
  -- Source / publisher
  publisher_name      text,                                -- "AAIF" / "Linux Foundation" / "TechCrunch"
  publisher_logo_url  text,                                -- /media/<path> or external
  external_url        text,                                -- for kind='coverage', the source article
  -- Hero / card
  featured_image_url  text,
  featured_image_alt  text,
  -- Taxonomy
  tags                text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','published','archived')),
  is_featured         boolean NOT NULL DEFAULT false,
  published_at        timestamptz,                         -- when the press release / article went out
  -- Lifecycle
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT press_releases_site_slug_unique UNIQUE (site_id, slug)
);

COMMENT ON TABLE public.press_releases IS 'Press releases + external press coverage rendered by the home-page WrittenContentHub "Press & News" tab. Multi-tenant via site_id.';

CREATE INDEX IF NOT EXISTS press_releases_site_status_pub_idx
  ON public.press_releases (site_id, status, published_at DESC);

CREATE INDEX IF NOT EXISTS press_releases_site_slug_idx
  ON public.press_releases (site_id, slug);

-- updated_at trigger (shared platform helper). Re-create idempotently.
DROP TRIGGER IF EXISTS press_releases_updated_at ON public.press_releases;
CREATE TRIGGER press_releases_updated_at
  BEFORE UPDATE ON public.press_releases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.press_releases ENABLE ROW LEVEL SECURITY;

-- anon: read published rows only.
DROP POLICY IF EXISTS "press_releases_select_published_anon" ON public.press_releases;
CREATE POLICY "press_releases_select_published_anon"
  ON public.press_releases FOR SELECT TO anon
  USING (status = 'published');

-- authenticated: read all rows (admin UI shows drafts/archived too).
DROP POLICY IF EXISTS "press_releases_select_authenticated" ON public.press_releases;
CREATE POLICY "press_releases_select_authenticated"
  ON public.press_releases FOR SELECT TO authenticated
  USING (true);

-- Writes are admin-only. The service-role key bypasses RLS (used by the
-- admin-routes handler); this policy fences off inadvertent writes from
-- JWT'd anon/authenticated clients.
DROP POLICY IF EXISTS "press_releases_insert_admin" ON public.press_releases;
CREATE POLICY "press_releases_insert_admin"
  ON public.press_releases FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "press_releases_update_admin" ON public.press_releases;
CREATE POLICY "press_releases_update_admin"
  ON public.press_releases FOR UPDATE TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "press_releases_delete_admin" ON public.press_releases;
CREATE POLICY "press_releases_delete_admin"
  ON public.press_releases FOR DELETE TO authenticated
  USING (public.is_admin());
