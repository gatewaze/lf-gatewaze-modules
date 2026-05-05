-- ============================================================================
-- content-pipeline_010_register_category_adapter
--
-- Per spec-unified-content-management §3.2: register content_items with the
-- universal content_category_adapters trigger so the membership module's
-- keyword rules apply member-vs-community categorisation automatically.
--
-- Migration 005 added content_category. Migration 009 registered the
-- publish-adapter but didn't register the category adapter — closing that
-- gap is what makes the membership trigger actually fire for discovered
-- content (today the content lands but the category stays NULL until
-- manually set in the admin UI).
--
-- Idempotent (register_category_adapter UPSERTs).
-- ============================================================================

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_category_adapters'
  ) THEN
    RAISE NOTICE '[content-pipeline/010] content-platform not installed; skipping';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'content_items'
      AND column_name = 'content_category'
  ) THEN
    RAISE NOTICE '[content-pipeline/010] content_items.content_category missing; skipping (migration 005 should have added it)';
    RETURN;
  END IF;

  PERFORM public.register_category_adapter(
    p_content_type => 'content_item',
    p_table_name   => 'public.content_items'::regclass,
    p_category_col => 'content_category'
  );
END $register$;
