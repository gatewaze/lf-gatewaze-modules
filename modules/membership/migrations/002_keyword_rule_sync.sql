-- ============================================================================
-- membership module — auto-sync member rows to content_keyword_rules
-- ============================================================================
-- Each ACTIVE member becomes one keyword rule:
--   pattern        = member name (matched as a whole word, case-insensitive)
--   pattern_type   = 'word'
--   content_types  = all currently-registered adapters (mostly 'event')
--   fields         = ['title','body','host','speakers','topics']
--   metadata       = { kind: 'membership', member_id, tier, tier_rank }
--
-- Tier changes update the rule's metadata.tier_rank → ruleset_version bumps
-- → staleness scanner picks up affected items → re-evaluation writes new
-- match_tier_rank into content_keyword_item_state.
--
-- Setting `is_active=false` on a member deactivates the rule (matched items
-- drop their member tag on next eval). Hard-deleting a member deletes the
-- rule via the trigger.
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_keyword_rules'
  ) THEN
    RAISE EXCEPTION 'membership requires content-keywords module to be installed first';
  END IF;
END $$;

-- Helper: returns content_types we should scope a member rule to (every
-- registered adapter so a single rule covers events + blog + podcasts + …).
CREATE OR REPLACE FUNCTION public.member_target_content_types()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(content_type ORDER BY content_type), ARRAY['event']::text[])
  FROM public.content_keyword_adapters;
$$;
ALTER FUNCTION public.member_target_content_types() OWNER TO gatewaze_module_writer;

CREATE OR REPLACE FUNCTION public.member_orgs_sync_to_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rule_id uuid;
  v_targets text[];
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM public.content_keyword_rules
    WHERE metadata->>'kind' = 'membership'
      AND metadata->>'member_id' = OLD.id::text;
    RETURN OLD;
  END IF;

  v_targets := public.member_target_content_types();

  -- Find existing rule for this member (if any).
  SELECT id INTO v_rule_id FROM public.content_keyword_rules
  WHERE metadata->>'kind' = 'membership'
    AND metadata->>'member_id' = NEW.id::text
  LIMIT 1;

  IF NOT NEW.is_active THEN
    -- Deactivate the rule (preserves audit history).
    IF v_rule_id IS NOT NULL THEN
      UPDATE public.content_keyword_rules
      SET is_active = false,
          metadata = jsonb_set(metadata, '{tier_rank}', to_jsonb(NEW.tier_rank))
      WHERE id = v_rule_id;
    END IF;
    RETURN NEW;
  END IF;

  IF v_rule_id IS NULL THEN
    INSERT INTO public.content_keyword_rules
      (name, description, pattern, pattern_type, case_sensitive, content_types, fields, is_active, metadata)
    VALUES (
      'Member: ' || NEW.name,
      'Auto-generated from member_organizations.' || NEW.slug,
      NEW.name,
      'word',
      false,
      v_targets,
      ARRAY['title','body','host','speakers','topics'],
      true,
      jsonb_build_object(
        'kind', 'membership',
        'member_id', NEW.id::text,
        'member_slug', NEW.slug,
        'tier', NEW.tier,
        'tier_rank', NEW.tier_rank
      )
    );
  ELSE
    UPDATE public.content_keyword_rules
    SET name = 'Member: ' || NEW.name,
        pattern = NEW.name,
        content_types = v_targets,
        is_active = true,
        metadata = jsonb_build_object(
          'kind', 'membership',
          'member_id', NEW.id::text,
          'member_slug', NEW.slug,
          'tier', NEW.tier,
          'tier_rank', NEW.tier_rank
        )
    WHERE id = v_rule_id;
  END IF;

  RETURN NEW;
END $$;
ALTER FUNCTION public.member_orgs_sync_to_rules() OWNER TO gatewaze_module_writer;

DROP TRIGGER IF EXISTS member_orgs_sync_to_rules_trg ON public.member_organizations;
CREATE TRIGGER member_orgs_sync_to_rules_trg
  AFTER INSERT OR UPDATE OF name, slug, tier, tier_rank, is_active
                          OR DELETE
  ON public.member_organizations
  FOR EACH ROW EXECUTE FUNCTION public.member_orgs_sync_to_rules();

-- When a tier_rank value changes in the lookup table, propagate to all members
-- with that tier (which cascades to rules via the per-row trigger).
CREATE OR REPLACE FUNCTION public.membership_tier_ranks_propagate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rank IS DISTINCT FROM OLD.rank THEN
    UPDATE public.member_organizations
    SET tier_rank = NEW.rank
    WHERE tier = NEW.tier AND tier_rank <> NEW.rank;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS membership_tier_ranks_propagate_trg ON public.membership_tier_ranks;
CREATE TRIGGER membership_tier_ranks_propagate_trg
  AFTER UPDATE ON public.membership_tier_ranks
  FOR EACH ROW EXECUTE FUNCTION public.membership_tier_ranks_propagate();
