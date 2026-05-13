-- ============================================================================
-- Module: daily-briefing
-- Migration: 001_daily_briefing_init
-- Description: Daily Briefing items rendered by the AAIF home-page Hero
--              sidebar ("Daily Agentic AI LinkedIn Newsletter"). Each row
--              is a single newsletter-style card: dated title, summary,
--              and a labelled outbound link to the source. The theme
--              typically fetches `?limit=3` for the desktop stack /
--              mobile slider. Multi-tenant via site_id.
-- Idempotent: uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
--             EXISTS / DROP-then-CREATE for policies + trigger. Safe to
--             reapply.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.daily_briefing_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  -- Card fields (match the existing DailyBriefing.tsx data shape).
  title           text NOT NULL,
  summary         text NOT NULL,
  brief_date      date NOT NULL,                              -- e.g. 2026-04-24
  source_label    text NOT NULL,                              -- e.g. "Claude on X"
  source_href     text NOT NULL,                              -- external URL the card links to
  -- Lifecycle
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','archived')),
  is_pinned       boolean NOT NULL DEFAULT false,             -- forces this item to top regardless of date
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Same (site, brief_date, title) shouldn't be inserted twice — gives us
  -- a clean idempotent seed target without forcing operators to invent a
  -- slug. Two genuine cards on the same day with the same title would be
  -- a content error anyway.
  CONSTRAINT daily_briefing_items_site_date_title_unique
    UNIQUE (site_id, brief_date, title)
);

COMMENT ON TABLE public.daily_briefing_items IS 'Daily Briefing newsletter items rendered by the AAIF home-page Hero sidebar. Multi-tenant via site_id.';

-- Covers the "home page renders the most-recent 3" query: filter by
-- site + status, sort pinned-first then brief_date desc.
CREATE INDEX IF NOT EXISTS daily_briefing_site_status_date_idx
  ON public.daily_briefing_items (site_id, status, is_pinned DESC, brief_date DESC);

-- updated_at trigger (shared platform helper). Re-create idempotently.
DROP TRIGGER IF EXISTS daily_briefing_items_updated_at ON public.daily_briefing_items;
CREATE TRIGGER daily_briefing_items_updated_at
  BEFORE UPDATE ON public.daily_briefing_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.daily_briefing_items ENABLE ROW LEVEL SECURITY;

-- anon: read published rows only.
DROP POLICY IF EXISTS "daily_briefing_items_select_published_anon" ON public.daily_briefing_items;
CREATE POLICY "daily_briefing_items_select_published_anon"
  ON public.daily_briefing_items FOR SELECT TO anon
  USING (status = 'published');

-- authenticated: read all rows (admin UI shows drafts/archived too).
DROP POLICY IF EXISTS "daily_briefing_items_select_authenticated" ON public.daily_briefing_items;
CREATE POLICY "daily_briefing_items_select_authenticated"
  ON public.daily_briefing_items FOR SELECT TO authenticated
  USING (true);

-- Writes are admin-only. The service-role key bypasses RLS (used by the
-- admin-routes handler); this policy fences off inadvertent writes from
-- JWT'd anon/authenticated clients.
DROP POLICY IF EXISTS "daily_briefing_items_insert_admin" ON public.daily_briefing_items;
CREATE POLICY "daily_briefing_items_insert_admin"
  ON public.daily_briefing_items FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "daily_briefing_items_update_admin" ON public.daily_briefing_items;
CREATE POLICY "daily_briefing_items_update_admin"
  ON public.daily_briefing_items FOR UPDATE TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "daily_briefing_items_delete_admin" ON public.daily_briefing_items;
CREATE POLICY "daily_briefing_items_delete_admin"
  ON public.daily_briefing_items FOR DELETE TO authenticated
  USING (public.is_admin());
