-- ============================================================================
-- Module: content-pipeline
-- Migration: 004_content_duplicates
-- Description: Add canonical URL tracking and cross-platform duplicate
--              detection infrastructure. Tracks relationships between
--              the same content published across multiple platforms
--              (e.g., a podcast on Spotify, Apple, and YouTube).
-- ============================================================================

-- ============================================================================
-- Add canonical_url and last_updated_at to content_items
-- ============================================================================
ALTER TABLE public.content_items
  ADD COLUMN IF NOT EXISTS canonical_url text,
  ADD COLUMN IF NOT EXISTS is_canonical boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;

COMMENT ON COLUMN public.content_items.canonical_url IS 'Canonical URL for this content — the original/authoritative source';
COMMENT ON COLUMN public.content_items.is_canonical IS 'Whether this item is the canonical (original) version of the content';
COMMENT ON COLUMN public.content_items.source_published_at IS 'When the source page reports this was first published';
COMMENT ON COLUMN public.content_items.source_updated_at IS 'When the source page reports this was last updated';

CREATE INDEX IF NOT EXISTS idx_content_items_canonical_url ON public.content_items (canonical_url);
CREATE INDEX IF NOT EXISTS idx_content_items_is_canonical ON public.content_items (is_canonical) WHERE is_canonical = true;

-- ============================================================================
-- Content Duplicates — cross-platform content relationships
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_duplicates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The canonical (preferred) item — video preferred over podcast,
  -- original source preferred over syndicated
  canonical_item_id   uuid NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,

  -- The duplicate (secondary) item
  duplicate_item_id   uuid NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,

  -- How these were matched
  relationship_type   text NOT NULL DEFAULT 'cross_platform'
                      CHECK (relationship_type IN (
                        'cross_platform',     -- Same content on different platforms (e.g., YouTube + Spotify)
                        'canonical',          -- duplicate_item links to canonical_item via <link rel="canonical">
                        'syndicated',         -- Content republished/syndicated from original
                        'derivative'          -- Derived content (e.g., blog post summarizing a video)
                      )),

  -- Match confidence and details
  confidence_score    numeric NOT NULL DEFAULT 0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
  match_method        text NOT NULL DEFAULT 'manual'
                      CHECK (match_method IN ('fuzzy_title', 'canonical_link', 'manual', 'exact_url', 'fingerprint')),
  match_details       jsonb DEFAULT '{}',   -- Store match specifics: title similarity %, duration diff, etc.

  -- Prevention of duplicate relationships
  UNIQUE (canonical_item_id, duplicate_item_id),
  CHECK (canonical_item_id != duplicate_item_id),

  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_duplicates IS 'Cross-platform content relationships — tracks same content across YouTube, Spotify, Apple Podcasts, etc.';

CREATE INDEX IF NOT EXISTS idx_content_duplicates_canonical ON public.content_duplicates (canonical_item_id);
CREATE INDEX IF NOT EXISTS idx_content_duplicates_duplicate ON public.content_duplicates (duplicate_item_id);
CREATE INDEX IF NOT EXISTS idx_content_duplicates_type ON public.content_duplicates (relationship_type);

-- ============================================================================
-- RLS for content_duplicates
-- ============================================================================
ALTER TABLE public.content_duplicates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "content_duplicates_select" ON public.content_duplicates FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_duplicates_insert" ON public.content_duplicates FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "content_duplicates_update" ON public.content_duplicates FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_duplicates_delete" ON public.content_duplicates FOR DELETE TO authenticated USING (public.is_admin());

-- ============================================================================
-- RPC: Find potential duplicates for a given content item
-- Uses title similarity and duration matching
-- ============================================================================
CREATE OR REPLACE FUNCTION public.content_find_duplicates(
  p_title text,
  p_author text DEFAULT NULL,
  p_duration_seconds integer DEFAULT NULL,
  p_exclude_item_id uuid DEFAULT NULL
)
RETURNS TABLE (
  item_id uuid,
  item_url text,
  item_title text,
  item_content_type text,
  item_source_type text,
  item_author text,
  item_duration_seconds integer,
  title_similarity numeric
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    ci.id AS item_id,
    ci.url AS item_url,
    ci.title AS item_title,
    ci.content_type AS item_content_type,
    ci.source_type AS item_source_type,
    ci.author AS item_author,
    ci.duration_seconds AS item_duration_seconds,
    similarity(lower(ci.title), lower(p_title)) AS title_similarity
  FROM public.content_items ci
  WHERE
    -- Exclude self
    (p_exclude_item_id IS NULL OR ci.id != p_exclude_item_id)
    -- Title similarity threshold (requires pg_trgm)
    AND similarity(lower(ci.title), lower(p_title)) > 0.4
    -- If duration provided, must be within 15% tolerance
    AND (
      p_duration_seconds IS NULL
      OR ci.duration_seconds IS NULL
      OR ABS(ci.duration_seconds - p_duration_seconds) < (p_duration_seconds * 0.15)
    )
  ORDER BY title_similarity DESC
  LIMIT 10;
$$;

-- pg_trgm: on Supabase Cloud, enable via Dashboard > Database > Extensions.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS "pg_trgm";
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pg_trgm extension not created (insufficient privileges). Enable it via the Supabase Dashboard.';
END $$;

-- Add trigram index for fast title similarity searches
CREATE INDEX IF NOT EXISTS idx_content_items_title_trgm
  ON public.content_items USING GIN (title gin_trgm_ops);

-- ============================================================================
-- RPC: Promote a duplicate to canonical
-- When we discover the original source of content we already have,
-- swap the canonical/duplicate relationship
-- ============================================================================
CREATE OR REPLACE FUNCTION public.content_promote_to_canonical(
  p_new_canonical_id uuid,
  p_old_canonical_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Mark new item as canonical
  UPDATE public.content_items
  SET is_canonical = true, canonical_url = url
  WHERE id = p_new_canonical_id;

  -- Unmark old item
  UPDATE public.content_items
  SET is_canonical = false, canonical_url = (SELECT url FROM public.content_items WHERE id = p_new_canonical_id)
  WHERE id = p_old_canonical_id;

  -- Update existing duplicate records: swap relationship direction
  -- Delete any existing relationship between these two items
  DELETE FROM public.content_duplicates
  WHERE (canonical_item_id = p_old_canonical_id AND duplicate_item_id = p_new_canonical_id)
     OR (canonical_item_id = p_new_canonical_id AND duplicate_item_id = p_old_canonical_id);

  -- Create the correct relationship
  INSERT INTO public.content_duplicates (canonical_item_id, duplicate_item_id, relationship_type, match_method, confidence_score)
  VALUES (p_new_canonical_id, p_old_canonical_id, 'canonical', 'canonical_link', 1.0);

  -- Re-point any other duplicates that referenced the old canonical
  UPDATE public.content_duplicates
  SET canonical_item_id = p_new_canonical_id
  WHERE canonical_item_id = p_old_canonical_id;
END;
$$;
