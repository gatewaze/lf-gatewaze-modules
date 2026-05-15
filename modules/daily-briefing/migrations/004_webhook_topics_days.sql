-- ============================================================================
-- Module: daily-briefing
-- Migration: 004_webhook_topics_days
-- Description: Refresh the webhook topic registrations for the day-grouped
--              schema introduced by 003. We now have TWO topics:
--                - daily_briefing_days  (site-scoped via site_id)
--                - daily_briefing_items (site-scoped via day_id → days.site_id;
--                                        for v1 we hoist site_id onto the
--                                        items row via a denormalised column
--                                        in a follow-up migration if needed.
--                                        For now items don't carry site_id,
--                                        so the topic is registered without
--                                        host_id_column and falls back to
--                                        the global emit path.)
--
-- Depends on: 003_restructure_to_days.sql + the webhooks module's
--             001_webhook_subscriptions.sql + 002_emit_mutation_event_function.sql.
-- ============================================================================

-- 002 left a topic + trigger pointed at the old daily_briefing_items shape.
-- 003 dropped that table; PG implicitly removed the trigger. Re-register
-- the topic with the new surrogate-key template — the day's brief_date
-- is the natural cache key now, not the item id.
INSERT INTO public.webhook_event_topics
  (topic, host_id_column, surrogate_key_template, detail_key_template, notify_columns, description)
VALUES (
  'daily_briefing_days',
  'site_id',
  'daily-briefing',
  'daily-briefing:day:{brief_date}',
  ARRAY['brief_date', 'status', 'image_storage_path'],
  'Daily-briefing day rows. Mutations fire revalidate when content moves between draft/published, when a new day is created, or when the cover image is (re)generated.'
)
ON CONFLICT (topic) DO UPDATE SET
  host_id_column = EXCLUDED.host_id_column,
  surrogate_key_template = EXCLUDED.surrogate_key_template,
  detail_key_template = EXCLUDED.detail_key_template,
  notify_columns = EXCLUDED.notify_columns,
  description = EXCLUDED.description;

DROP TRIGGER IF EXISTS daily_briefing_days_mutation ON public.daily_briefing_days;
CREATE TRIGGER daily_briefing_days_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.daily_briefing_days
  FOR EACH ROW EXECUTE FUNCTION public.emit_mutation_event();

-- Item-level topic — refreshed for the new shape. detail_key resolves
-- to the parent day's date via notify_columns NOT supplying brief_date
-- (items don't carry it directly). The trigger function tolerates a
-- missing detail-key field by skipping the detail key and emitting
-- only the topic-level surrogate ("daily-briefing"); that's still
-- enough to invalidate the home-page query.
INSERT INTO public.webhook_event_topics
  (topic, host_id_column, surrogate_key_template, detail_key_template, notify_columns, description)
VALUES (
  'daily_briefing_items',
  NULL,  -- host_id resolved later; items inherit visibility via parent day
  'daily-briefing',
  'daily-briefing:item:{id}',
  ARRAY['id', 'day_id', 'display_order', 'status'],
  'Daily-briefing news cards. Mutations fire revalidate on the daily-briefing surrogate; the home-page query only displays the most-recent published day, so item-level changes propagate through the same key.'
)
ON CONFLICT (topic) DO UPDATE SET
  host_id_column = EXCLUDED.host_id_column,
  surrogate_key_template = EXCLUDED.surrogate_key_template,
  detail_key_template = EXCLUDED.detail_key_template,
  notify_columns = EXCLUDED.notify_columns,
  description = EXCLUDED.description;

DROP TRIGGER IF EXISTS daily_briefing_items_mutation ON public.daily_briefing_items;
CREATE TRIGGER daily_briefing_items_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.daily_briefing_items
  FOR EACH ROW EXECUTE FUNCTION public.emit_mutation_event();
