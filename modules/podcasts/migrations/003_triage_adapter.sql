-- ============================================================================
-- podcasts — triage adapter
-- Extends podcast_episodes.status with pending_review/rejected + RPCs.
-- Guarded: no-op if content-triage isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RAISE NOTICE '[podcasts/003_triage_adapter] content-triage not installed; skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.podcast_episodes'::regclass
      AND pg_get_constraintdef(c.oid) ILIKE '%pending_review%'
  ) THEN
    ALTER TABLE public.podcast_episodes DROP CONSTRAINT IF EXISTS podcast_episodes_status_check;
    ALTER TABLE public.podcast_episodes ADD CONSTRAINT podcast_episodes_status_check
      CHECK (status IN ('draft','scheduled','recording','editing','published','archived','pending_review','rejected'));
  END IF;

  ALTER TABLE public.podcast_episodes ADD COLUMN IF NOT EXISTS rejection_reason text;
END
$migration$;

CREATE OR REPLACE FUNCTION public.podcast_episodes_triage_approve(
  p_content_id  uuid,
  p_categories  text[],
  p_featured    boolean,
  p_reviewer    uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.podcast_episodes
     SET status = 'published',
         content_category = COALESCE(p_categories[1], content_category)
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Podcast episode % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.podcast_episodes_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.podcast_episodes
     SET status = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Podcast episode % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.podcast_episodes_triage_suggest_categories(
  p_content_id uuid
) RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'podcast_episodes' AND column_name = 'content_category'
  ) THEN
    RETURN QUERY
      SELECT ARRAY[pe.content_category]::text[], 'content_category'::text
      FROM public.podcast_episodes pe
      WHERE pe.id = p_content_id AND pe.content_category IS NOT NULL
      LIMIT 1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.podcast_episodes_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.podcast_episodes
       SET status = 'pending_review'
     WHERE id = p_content_id AND status = 'published';
  ELSE
    UPDATE public.podcast_episodes
       SET status = 'pending_review'
     WHERE id = p_content_id AND status NOT IN ('pending_review','rejected','published','archived');
  END IF;
END $$;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;

  ALTER FUNCTION public.podcast_episodes_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.podcast_episodes_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.podcast_episodes_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.podcast_episodes_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'podcast_episode',
    'public.podcast_episodes_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.podcast_episodes_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.podcast_episodes_triage_suggest_categories(uuid)'::regprocedure,
    'public.podcast_episodes_triage_submit(uuid,boolean)'::regprocedure,
    'Podcast Episode'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn    = EXCLUDED.approve_fn,
    reject_fn     = EXCLUDED.reject_fn,
    suggest_fn    = EXCLUDED.suggest_fn,
    submit_fn     = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$register$;
