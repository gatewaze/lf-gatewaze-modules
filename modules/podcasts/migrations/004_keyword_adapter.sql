-- ============================================================================
-- podcasts module — content-keywords adapter (podcast_episodes)
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN
    RAISE NOTICE '[podcasts/004_keyword_adapter] content-keywords not installed; skipping';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  END IF;
END $migration$;

CREATE OR REPLACE FUNCTION public.podcast_episodes_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH e AS (
    SELECT pe.*, p.name AS podcast_name FROM public.podcast_episodes pe
    LEFT JOIN public.podcasts p ON p.id = pe.podcast_id
    WHERE pe.id = p_content_id
  )
  SELECT 'title'::text, COALESCE(title, '')::text, NULLIF(podcast_name, '')::text FROM e
  UNION ALL
  SELECT 'description'::text, COALESCE(description, '')::text, NULLIF(podcast_name, '')::text FROM e
  UNION ALL
  SELECT 'podcast'::text, COALESCE(podcast_name, '')::text, NULL::text FROM e;
$$;

CREATE OR REPLACE FUNCTION public.podcasts_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('podcast_episode', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='delete', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('podcast_episode', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='evaluate', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS podcasts_ck_enqueue_trg ON public.podcast_episodes;
CREATE TRIGGER podcasts_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF title, description OR DELETE ON public.podcast_episodes
  FOR EACH ROW EXECUTE FUNCTION public.podcasts_ck_enqueue();

CREATE OR REPLACE FUNCTION public.podcast_episodes_public_list(p_limit int DEFAULT 50, p_offset int DEFAULT 0, p_podcast_slug text DEFAULT NULL)
RETURNS SETOF public.podcast_episodes
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pe.* FROM public.podcast_episodes pe
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type='podcast_episode' AND s.content_id=pe.id
  LEFT JOIN public.podcasts p ON p.id = pe.podcast_id
  WHERE pe.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='podcast_episode'),
                 true) = true
    AND (p_podcast_slug IS NULL OR p.slug = p_podcast_slug)
  ORDER BY pe.publish_date DESC NULLS LAST, pe.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;

DO $register$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN RETURN; END IF;
  ALTER FUNCTION public.podcast_episodes_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.podcast_episodes_public_list(int, int, text) OWNER TO gatewaze_module_writer;
  GRANT SELECT ON public.podcast_episodes, public.podcasts TO gatewaze_module_writer;
  REVOKE ALL ON FUNCTION public.podcast_episodes_public_list(int, int, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.podcast_episodes_public_list(int, int, text) TO anon, authenticated, service_role;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column, declared_fields, declares_source, display_label, default_visible_when_no_rules, public_read_fns)
  VALUES (
    'podcast_episode',
    'public.podcast_episodes_keyword_text(uuid)'::regprocedure,
    'public.podcast_episodes'::regclass,
    'created_at',
    ARRAY['title','description','podcast'],
    true,
    'Podcast Episode',
    true,
    ARRAY['public.podcast_episodes_public_list(int,int,text)'::regprocedure]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn, table_name = EXCLUDED.table_name,
    declared_fields = EXCLUDED.declared_fields, public_read_fns = EXCLUDED.public_read_fns;
END $register$;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_match_queue') THEN RETURN; END IF;
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'podcast_episode', id, 'evaluate' FROM public.podcast_episodes
  ON CONFLICT (content_type, content_id) DO NOTHING;
END $backfill$;
