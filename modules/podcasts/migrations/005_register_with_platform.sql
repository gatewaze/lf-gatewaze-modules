-- ============================================================================
-- podcasts — register podcast_episode with content-platform.
-- ============================================================================

ALTER TABLE public.podcast_episodes
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published'
  CHECK (publish_state IN
    ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));

DO $backfill$
BEGIN
  -- podcast_episodes.status is (draft/scheduled/recording/editing/published/
  -- archived/pending_review/rejected). Map editing/recording/scheduled → draft;
  -- archived → unpublished.
  UPDATE public.podcast_episodes SET publish_state = CASE
    WHEN status = 'pending_review' THEN 'pending_review'
    WHEN status = 'rejected'       THEN 'rejected'
    WHEN status IN ('draft','scheduled','recording','editing') THEN 'draft'
    WHEN status = 'archived'       THEN 'unpublished'
    ELSE 'published'  -- published + anything else
  END WHERE TRUE;
END $backfill$;

CREATE INDEX IF NOT EXISTS podcast_episodes_publish_state_live
  ON public.podcast_episodes(publish_state) WHERE publish_state = 'published';

CREATE OR REPLACE FUNCTION public.podcasts_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT pe.title::text,
         NULLIF(concat_ws(' · ',
           CASE WHEN pe.season IS NOT NULL THEN 'S' || pe.season ELSE NULL END,
           CASE WHEN pe.episode_number IS NOT NULL THEN 'E' || pe.episode_number ELSE NULL END,
           p.name
         ), '')::text,
         COALESCE(pe.thumbnail_url, p.cover_image_url)::text
  FROM public.podcast_episodes pe
  LEFT JOIN public.podcasts p ON p.id = pe.podcast_id
  WHERE pe.id = p_id;
$$;
ALTER FUNCTION public.podcasts_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[podcasts/004] content-platform not installed; skipping';
    RETURN;
  END IF;
  PERFORM public.register_content_type(
    p_content_type      => 'podcast_episode',
    p_table_name        => 'public.podcast_episodes'::regclass,
    p_display_label     => 'Podcast Episode',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.podcasts_inbox_preview(uuid)'::regprocedure
  );

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='podcast_episodes' AND column_name='content_category')
     AND EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='content_category_adapters') THEN
    PERFORM public.register_category_adapter(
      p_content_type => 'podcast_episode',
      p_table_name   => 'public.podcast_episodes'::regclass,
      p_category_col => 'content_category'
    );
  END IF;
END $register$;
