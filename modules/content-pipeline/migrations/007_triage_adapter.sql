-- ============================================================================
-- content-pipeline — triage adapter (bridge)
-- Adds needs_review boolean + rejected flag on content_items + triage RPCs.
-- Guarded: no-op if content-triage isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_triage_adapters'
  ) THEN
    RAISE NOTICE '[content-pipeline/007_triage_adapter] content-triage not installed; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.content_items ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
  ALTER TABLE public.content_items ADD COLUMN IF NOT EXISTS triage_status text DEFAULT 'approved';
  ALTER TABLE public.content_items ADD COLUMN IF NOT EXISTS rejection_reason text;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.content_items'::regclass
      AND pg_get_constraintdef(c.oid) ILIKE '%triage_status%pending_review%'
  ) THEN
    ALTER TABLE public.content_items DROP CONSTRAINT IF EXISTS content_items_triage_status_check;
    ALTER TABLE public.content_items ADD CONSTRAINT content_items_triage_status_check
      CHECK (triage_status IN ('approved','pending_review','rejected'));
  END IF;

  CREATE INDEX IF NOT EXISTS idx_content_items_needs_review ON public.content_items(needs_review) WHERE needs_review;
END
$migration$;

CREATE OR REPLACE FUNCTION public.content_items_triage_approve(
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
  UPDATE public.content_items
     SET needs_review = false,
         triage_status = 'approved',
         topics = CASE
           WHEN p_categories IS NOT NULL AND array_length(p_categories, 1) > 0
             THEN ARRAY(SELECT DISTINCT unnest(topics || p_categories))
           ELSE topics
         END
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Content item % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.content_items_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.content_items
     SET needs_review = false,
         triage_status = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Content item % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.content_items_triage_suggest_categories(
  p_content_id uuid
) RETURNS TABLE(categories text[], source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT ci.topics, 'content_topics'::text
    FROM public.content_items ci
    WHERE ci.id = p_content_id AND ci.topics IS NOT NULL AND array_length(ci.topics, 1) > 0
    LIMIT 1;
END $$;

CREATE OR REPLACE FUNCTION public.content_items_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.content_items
     SET needs_review = true,
         triage_status = 'pending_review'
   WHERE id = p_content_id;
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

  ALTER FUNCTION public.content_items_triage_approve(uuid, text[], boolean, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.content_items_triage_reject(uuid, text, uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.content_items_triage_suggest_categories(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.content_items_triage_submit(uuid, boolean) OWNER TO gatewaze_module_writer;

  INSERT INTO public.content_triage_adapters
    (content_type, approve_fn, reject_fn, suggest_fn, submit_fn, display_label)
  VALUES (
    'content_item',
    'public.content_items_triage_approve(uuid,text[],boolean,uuid)'::regprocedure,
    'public.content_items_triage_reject(uuid,text,uuid)'::regprocedure,
    'public.content_items_triage_suggest_categories(uuid)'::regprocedure,
    'public.content_items_triage_submit(uuid,boolean)'::regprocedure,
    'Content Item'
  )
  ON CONFLICT (content_type) DO UPDATE SET
    approve_fn    = EXCLUDED.approve_fn,
    reject_fn     = EXCLUDED.reject_fn,
    suggest_fn    = EXCLUDED.suggest_fn,
    submit_fn     = EXCLUDED.submit_fn,
    display_label = EXCLUDED.display_label;
END
$register$;
