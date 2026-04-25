-- ============================================================================
-- membership module — extends the events content-keywords adapter
-- (1) text_fn now also yields a 'speakers' field built from
--     events_speakers ⨝ events_speaker_profiles.
-- (2) declared_fields gains 'speakers'.
-- (3) public_read_fns updated so portal/API reads ORDER BY match_tier_rank.
-- (4) content_category trigger that flips events to 'members' when a
--     member rule matches, 'community' otherwise.
--
-- Guarded — no-op if events module isn't installed.
-- ============================================================================
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'events'
  ) THEN
    RAISE NOTICE '[membership/003_extend_events_adapter] events table missing; skipping';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_keyword_adapters'
  ) THEN
    RAISE NOTICE '[membership/003_extend_events_adapter] content-keywords missing; skipping';
    RETURN;
  END IF;
END $migration$;

-- (1) Updated text_fn — speakers joined in if event-speakers module present.
CREATE OR REPLACE FUNCTION public.events_keyword_text(p_content_id uuid)
RETURNS TABLE(field text, value text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH e AS (SELECT * FROM public.events WHERE id = p_content_id),
       speakers AS (
         SELECT
           CASE WHEN EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='events_speakers'
           ) THEN (
             SELECT string_agg(DISTINCT
                      COALESCE(esp.name, '')
                      || ' '
                      || COALESCE(esp.company, '')
                      || ' '
                      || COALESCE(es.speaker_title, ''),
                      ' ')
             FROM public.events_speakers es
             LEFT JOIN public.events_speaker_profiles esp ON esp.id = es.speaker_id
             WHERE es.event_uuid = p_content_id
           ) ELSE NULL END AS speaker_text
       )
  SELECT 'title'::text, COALESCE(event_title, '')::text, NULLIF(event_source_name, '')::text FROM e
  UNION ALL
  SELECT 'body'::text,  COALESCE(event_description, '')::text, NULLIF(event_source_name, '')::text FROM e
  UNION ALL
  SELECT 'host'::text,  COALESCE(event_source_name, '')::text, NULL::text FROM e
  UNION ALL
  SELECT 'topics'::text, COALESCE(array_to_string(event_topics, ' '), '')::text, NULLIF(event_source_name, '')::text FROM e
  UNION ALL
  SELECT 'speakers'::text, COALESCE(s.speaker_text, '')::text, NULL::text FROM speakers s;
$$;

-- (2) Update adapter row to include 'speakers' in declared_fields.
DO $update_adapter$
BEGIN
  UPDATE public.content_keyword_adapters
  SET declared_fields = ARRAY['title','body','host','topics','speakers']
  WHERE content_type = 'event';
END $update_adapter$;

-- Grant SELECT on speaker tables to module writer (for the SECURITY DEFINER fn).
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='events_speakers') THEN
    EXECUTE 'GRANT SELECT ON public.events_speakers TO gatewaze_module_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='events_speaker_profiles') THEN
    EXECUTE 'GRANT SELECT ON public.events_speaker_profiles TO gatewaze_module_writer';
  END IF;
  -- The category-sync trigger writes to events.content_category.
  EXECUTE 'GRANT UPDATE (content_category) ON public.events TO gatewaze_module_writer';
END $grants$;

-- (3) Replace public read fns — sort by match_tier_rank DESC so member
-- content surfaces first; ties broken by event_start.
CREATE OR REPLACE FUNCTION public.events_public_list(
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0,
  p_city text DEFAULT NULL,
  p_country_code text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
) RETURNS SETOF public.events
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e.*
  FROM public.events e
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'event' AND s.content_id = e.id
  WHERE COALESCE(e.status, 'complete') = 'complete'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules
                  FROM public.content_keyword_adapters
                  WHERE content_type = 'event'),
                 true) = true
    AND (p_city IS NULL OR e.event_city ILIKE '%' || p_city || '%')
    AND (p_country_code IS NULL OR e.event_country_code = p_country_code)
    AND (p_from IS NULL OR e.event_start >= p_from)
    AND (p_to IS NULL OR e.event_start < p_to)
  ORDER BY s.match_tier_rank DESC NULLS LAST,
           e.event_start DESC NULLS LAST,
           e.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;
ALTER FUNCTION public.events_public_list(int, int, text, text, timestamptz, timestamptz) OWNER TO gatewaze_module_writer;

-- (4) Tag content_category based on whether the item state has a member match.
-- Trigger on content_keyword_item_state for events: any matched member rule
-- → category = 'members'; otherwise → 'community' (unless content_category
-- is already set to a non-default value via the legacy column).
CREATE OR REPLACE FUNCTION public.events_member_category_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_has_member_match boolean;
BEGIN
  IF NEW.content_type <> 'event' THEN RETURN NEW; END IF;

  -- Did any matched rule have membership metadata?
  SELECT EXISTS (
    SELECT 1 FROM public.content_keyword_rules
    WHERE id = ANY(NEW.matched_rule_ids)
      AND metadata->>'kind' = 'membership'
  ) INTO v_has_member_match;

  UPDATE public.events
  SET content_category = CASE
    WHEN v_has_member_match THEN 'members'
    ELSE 'community'
  END
  WHERE id = NEW.content_id
    -- Don't overwrite a more-specific manual category set by an admin.
    AND (content_category IS NULL OR content_category IN ('members','community'));

  RETURN NEW;
END $$;
ALTER FUNCTION public.events_member_category_sync() OWNER TO gatewaze_module_writer;
DROP TRIGGER IF EXISTS events_member_category_sync_trg ON public.content_keyword_item_state;
CREATE TRIGGER events_member_category_sync_trg
  AFTER INSERT OR UPDATE OF matched_rule_ids ON public.content_keyword_item_state
  FOR EACH ROW EXECUTE FUNCTION public.events_member_category_sync();
