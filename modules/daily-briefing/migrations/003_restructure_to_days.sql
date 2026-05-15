-- ============================================================================
-- Module: daily-briefing
-- Migration: 003_restructure_to_days
-- Description: Restructure daily-briefing into a parent `days` table and
--              child `items` table. Each day groups the news cards for a
--              single brief_date and carries the AI-generated cartoon
--              cover image (the "newspaper-comic" Gemini image that
--              renders alongside the day on the home page).
--
--              Hard-cut migration per operator choice: existing items are
--              dropped (test data, ~3 rows). On install fresh, the new
--              schema is the only one that ever existed; on re-apply,
--              we DROP IF EXISTS first so nothing leaks from migration 001.
--
-- Schema:
--   daily_briefing_days
--     ├─ id                  (PK)
--     ├─ site_id             (FK sites, cascade)
--     ├─ brief_date          (date, unique per site)
--     ├─ status              (draft / published / archived)
--     ├─ image_storage_path  (host-media bucket path; null = no image yet)
--     ├─ image_cdn_url       (resolved public URL for the image)
--     ├─ image_prompt        (last prompt sent to Gemini — for audit)
--     ├─ image_generated_at  (timestamp of last successful generation)
--     ├─ image_status        (idle / generating / failed)
--     ├─ image_error         (last error message; null on success)
--     └─ created_at, updated_at, created_by
--
--   daily_briefing_items
--     ├─ id                  (PK)
--     ├─ day_id              (FK days, cascade)  ← replaces site_id + brief_date
--     ├─ display_order       (int, sortable within a day; lower = first)
--     ├─ title, summary
--     ├─ source_label, source_href
--     ├─ status              (draft / published / archived)
--     └─ created_at, updated_at, created_by
--
-- Public API behaviour (handled in api/public-routes.ts, not SQL):
--   GET /api/daily-briefing  → most-recent PUBLISHED day's items, capped
--   at 3, sorted by display_order ASC.
-- ============================================================================

-- ── 1. Drop the legacy single-table layout (idempotent) ────────────────────
-- Triggers + RLS policies cascade away with the table.
DROP TABLE IF EXISTS public.daily_briefing_items CASCADE;
DROP INDEX IF EXISTS public.daily_briefing_site_status_date_idx;

-- ── 2. daily_briefing_days ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_briefing_days (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  brief_date          date NOT NULL,

  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','published','archived')),

  image_storage_path  text,
  image_cdn_url       text,
  image_prompt        text,
  image_generated_at  timestamptz,
  image_status        text NOT NULL DEFAULT 'idle'
                      CHECK (image_status IN ('idle','generating','ready','failed')),
  image_error         text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Exactly one day per (site, brief_date). The admin UI groups by date,
  -- so collisions would be ambiguous to operators and double-render the
  -- cartoon image.
  CONSTRAINT daily_briefing_days_site_date_unique
    UNIQUE (site_id, brief_date)
);

COMMENT ON TABLE public.daily_briefing_days IS
  'Parent grouping for daily-briefing items. One row per (site, date); carries the cartoon-style cover image generated for that day''s stories.';

-- The home-page query: most recent published day per site. Covers both
-- the public list endpoint and the admin "Days" list.
CREATE INDEX IF NOT EXISTS daily_briefing_days_site_status_date_idx
  ON public.daily_briefing_days (site_id, status, brief_date DESC);

DROP TRIGGER IF EXISTS daily_briefing_days_updated_at ON public.daily_briefing_days;
CREATE TRIGGER daily_briefing_days_updated_at
  BEFORE UPDATE ON public.daily_briefing_days
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.daily_briefing_days ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_briefing_days_select_published_anon" ON public.daily_briefing_days;
CREATE POLICY "daily_briefing_days_select_published_anon"
  ON public.daily_briefing_days FOR SELECT TO anon
  USING (status = 'published');

DROP POLICY IF EXISTS "daily_briefing_days_select_authenticated" ON public.daily_briefing_days;
CREATE POLICY "daily_briefing_days_select_authenticated"
  ON public.daily_briefing_days FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "daily_briefing_days_insert_admin" ON public.daily_briefing_days;
CREATE POLICY "daily_briefing_days_insert_admin"
  ON public.daily_briefing_days FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "daily_briefing_days_update_admin" ON public.daily_briefing_days;
CREATE POLICY "daily_briefing_days_update_admin"
  ON public.daily_briefing_days FOR UPDATE TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "daily_briefing_days_delete_admin" ON public.daily_briefing_days;
CREATE POLICY "daily_briefing_days_delete_admin"
  ON public.daily_briefing_days FOR DELETE TO authenticated
  USING (public.is_admin());

-- ── 3. daily_briefing_items (new shape) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.daily_briefing_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id          uuid NOT NULL REFERENCES public.daily_briefing_days(id) ON DELETE CASCADE,

  -- Drag-drop ordering. Lower = earlier in the day. We use a generous
  -- step (multiples of 1000 on insert) so reorder PATCHes never have
  -- to renumber every sibling; one rebalance pass if values converge.
  display_order   integer NOT NULL DEFAULT 1000,

  title           text NOT NULL,
  summary         text NOT NULL,
  source_label    text NOT NULL,  -- e.g. "Claude on X"
  source_href     text NOT NULL,  -- external URL the card links to

  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','archived')),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- (day, title) unique — same constraint shape as v1 but scoped to a
  -- single day, which is the natural authoring unit now.
  CONSTRAINT daily_briefing_items_day_title_unique
    UNIQUE (day_id, title)
);

COMMENT ON TABLE public.daily_briefing_items IS
  'Daily-briefing news cards. Each row belongs to a day (daily_briefing_days); within a day they sort by display_order.';

CREATE INDEX IF NOT EXISTS daily_briefing_items_day_order_idx
  ON public.daily_briefing_items (day_id, display_order);

CREATE INDEX IF NOT EXISTS daily_briefing_items_day_status_idx
  ON public.daily_briefing_items (day_id, status);

DROP TRIGGER IF EXISTS daily_briefing_items_updated_at ON public.daily_briefing_items;
CREATE TRIGGER daily_briefing_items_updated_at
  BEFORE UPDATE ON public.daily_briefing_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.daily_briefing_items ENABLE ROW LEVEL SECURITY;

-- The anon read policy must also gate on the parent day's status so a
-- published item under a draft day isn't visible publicly.
DROP POLICY IF EXISTS "daily_briefing_items_select_published_anon" ON public.daily_briefing_items;
CREATE POLICY "daily_briefing_items_select_published_anon"
  ON public.daily_briefing_items FOR SELECT TO anon
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.daily_briefing_days d
      WHERE d.id = daily_briefing_items.day_id
      AND d.status = 'published'
    )
  );

DROP POLICY IF EXISTS "daily_briefing_items_select_authenticated" ON public.daily_briefing_items;
CREATE POLICY "daily_briefing_items_select_authenticated"
  ON public.daily_briefing_items FOR SELECT TO authenticated
  USING (true);

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
