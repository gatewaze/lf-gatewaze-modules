-- ============================================================================
-- content-pipeline module — content-keywords adapter (content_items)
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN
    RAISE NOTICE '[content-pipeline/008_keyword_adapter] content-keywords not installed; skipping';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  END IF;
END $migration$;

CREATE OR REPLACE FUNCTION public.content_items_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH c AS (SELECT * FROM public.content_items WHERE id = p_content_id)
  SELECT 'title'::text, COALESCE(title, '')::text, NULLIF(source_type, '')::text FROM c
  UNION ALL
  SELECT 'summary'::text, COALESCE(summary, '')::text, NULLIF(source_type, '')::text FROM c
  UNION ALL
  SELECT 'topics'::text, COALESCE(array_to_string(topics, ' '), '')::text, NULLIF(source_type, '')::text FROM c
  UNION ALL
  SELECT 'projects'::text, COALESCE(array_to_string(projects, ' '), '')::text, NULLIF(source_type, '')::text FROM c
  UNION ALL
  SELECT 'author'::text, COALESCE(author, '')::text, NULLIF(source_type, '')::text FROM c;
$$;

CREATE OR REPLACE FUNCTION public.content_items_ck_enqueue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('content_item', OLD.id, 'delete')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='delete', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN OLD;
  ELSE
    INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
      VALUES ('content_item', NEW.id, 'evaluate')
      ON CONFLICT (content_type, content_id) DO UPDATE
        SET op='evaluate', enqueued_at=now(), next_attempt_at=now(), attempts=0, last_error=NULL;
    RETURN NEW;
  END IF;
END $$;
DROP TRIGGER IF EXISTS content_items_ck_enqueue_trg ON public.content_items;
CREATE TRIGGER content_items_ck_enqueue_trg
  AFTER INSERT OR UPDATE OF title, summary, topics, projects, author OR DELETE
  ON public.content_items
  FOR EACH ROW EXECUTE FUNCTION public.content_items_ck_enqueue();

CREATE OR REPLACE FUNCTION public.content_items_public_list(
  p_limit int DEFAULT 50, p_offset int DEFAULT 0,
  p_content_type text DEFAULT NULL, p_source_type text DEFAULT NULL
) RETURNS SETOF public.content_items
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.* FROM public.content_items c
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type='content_item' AND s.content_id=c.id
  WHERE COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='content_item'),
                 true) = true
    AND (p_content_type IS NULL OR c.content_type = p_content_type)
    AND (p_source_type  IS NULL OR c.source_type  = p_source_type)
  ORDER BY c.publish_date DESC NULLS LAST, c.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;

DO $register$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_adapters') THEN RETURN; END IF;
  ALTER FUNCTION public.content_items_keyword_text(uuid) OWNER TO gatewaze_module_writer;
  ALTER FUNCTION public.content_items_public_list(int, int, text, text) OWNER TO gatewaze_module_writer;
  GRANT SELECT ON public.content_items TO gatewaze_module_writer;
  REVOKE ALL ON FUNCTION public.content_items_public_list(int, int, text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.content_items_public_list(int, int, text, text) TO anon, authenticated, service_role;

  INSERT INTO public.content_keyword_adapters
    (content_type, text_fn, table_name, created_at_column, declared_fields, declares_source, display_label, default_visible_when_no_rules, public_read_fns)
  VALUES (
    'content_item',
    'public.content_items_keyword_text(uuid)'::regprocedure,
    'public.content_items'::regclass,
    'created_at',
    ARRAY['title','summary','topics','projects','author'],
    true,
    'Content Item',
    true,
    ARRAY['public.content_items_public_list(int,int,text,text)'::regprocedure]
  )
  ON CONFLICT (content_type) DO UPDATE SET
    text_fn = EXCLUDED.text_fn, table_name = EXCLUDED.table_name,
    declared_fields = EXCLUDED.declared_fields, public_read_fns = EXCLUDED.public_read_fns;
END $register$;

DO $backfill$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='content_keyword_match_queue') THEN RETURN; END IF;
  INSERT INTO public.content_keyword_match_queue (content_type, content_id, op)
  SELECT 'content_item', id, 'evaluate' FROM public.content_items
  ON CONFLICT (content_type, content_id) DO NOTHING;
END $backfill$;
