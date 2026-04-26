-- ============================================================================
-- content-pipeline — register content_item with content-platform.
-- Backfills publish_state from the existing triage_status column added by
-- 007_triage_adapter. The triage_status column stays for one release with a
-- DEPRECATED comment; portal/admin reads should switch to publish_state.
-- ============================================================================

ALTER TABLE public.content_items
  ADD COLUMN IF NOT EXISTS publish_state text NOT NULL DEFAULT 'published'
  CHECK (publish_state IN
    ('draft','pending_review','auto_suppressed','rejected','published','unpublished'));

DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='content_items' AND column_name='triage_status'
  ) THEN
    UPDATE public.content_items SET publish_state = CASE
      WHEN triage_status = 'pending_review' THEN 'pending_review'
      WHEN triage_status = 'rejected'       THEN 'rejected'
      ELSE 'published'  -- 'approved' default
    END;
    COMMENT ON COLUMN public.content_items.triage_status IS
      'DEPRECATED — superseded by publish_state. To be dropped in next release.';
    COMMENT ON COLUMN public.content_items.needs_review IS
      'DEPRECATED — superseded by publish_state=''pending_review''. To be dropped in next release.';
  END IF;
END $backfill$;

CREATE INDEX IF NOT EXISTS content_items_publish_state_live
  ON public.content_items(publish_state) WHERE publish_state = 'published';

CREATE OR REPLACE FUNCTION public.content_items_inbox_preview(p_id uuid)
RETURNS TABLE(title text, subtitle text, thumbnail_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT ci.title::text,
         NULLIF(concat_ws(' · ',
           ci.source_type,
           NULLIF(ci.author, ''),
           NULLIF(LEFT(ci.summary, 80), '')
         ), '')::text,
         ci.thumbnail_url::text
  FROM public.content_items ci WHERE ci.id = p_id;
$$;
ALTER FUNCTION public.content_items_inbox_preview(uuid) OWNER TO gatewaze_module_writer;

-- Update the triage adapter functions to also write publish_state via the
-- platform RPC, so admin actions in either UI stay in sync.
CREATE OR REPLACE FUNCTION public.content_items_triage_approve(
  p_content_id uuid, p_categories text[], p_featured boolean, p_reviewer uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_actor text;
BEGIN
  v_actor := COALESCE('admin:' || p_reviewer::text, 'system:auto_approve');
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='content_publish_adapters') THEN
    PERFORM public.content_publish_state_set('content_item', p_content_id, 'published', v_actor, 'triage_approve');
  END IF;
  UPDATE public.content_items
     SET needs_review = false,
         triage_status = 'approved',
         topics = CASE
           WHEN p_categories IS NOT NULL AND array_length(p_categories, 1) > 0
             THEN ARRAY(SELECT DISTINCT unnest(topics || p_categories))
           ELSE topics END
   WHERE id = p_content_id;
END $$;

CREATE OR REPLACE FUNCTION public.content_items_triage_reject(
  p_content_id uuid, p_reason text, p_reviewer uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_actor text;
BEGIN
  v_actor := COALESCE('admin:' || p_reviewer::text, 'system:reject');
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='content_publish_adapters') THEN
    PERFORM public.content_publish_state_set('content_item', p_content_id, 'rejected', v_actor, p_reason);
  END IF;
  UPDATE public.content_items
     SET needs_review = false,
         triage_status = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
END $$;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='content_publish_adapters'
  ) THEN
    RAISE NOTICE '[content-pipeline/009] content-platform not installed; skipping';
    RETURN;
  END IF;
  PERFORM public.register_content_type(
    p_content_type      => 'content_item',
    p_table_name        => 'public.content_items'::regclass,
    p_display_label     => 'Discovered Content',
    p_publish_state_col => 'publish_state',
    p_inbox_preview_fn  => 'public.content_items_inbox_preview(uuid)'::regprocedure
  );
END $register$;
