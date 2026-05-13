-- ============================================================================
-- Module: daily-briefing
-- Migration: 002_webhook_topic
-- Description: Register daily_briefing_items as a webhook topic and attach
--              the shared emit_mutation_event() trigger. Per
--              spec-api-cache-and-revalidation §4.2 and §4.4.
--
-- Depends on: webhooks/001_webhook_subscriptions.sql + 002_emit_mutation_event_function.sql
-- ============================================================================

-- Seed (or refresh) the topic row. notify_columns is empty because the
-- detail key template doesn't reference any field — daily-briefing's
-- detail key is keyed on the row id, which the trigger emits as row_id
-- regardless of notify_columns. We still emit `id` for explicitness in
-- case the Hub ever needs to materialise it.
INSERT INTO public.webhook_event_topics
  (topic, host_id_column, surrogate_key_template, detail_key_template, notify_columns, description)
VALUES (
  'daily_briefing_items',
  'site_id',
  'daily-briefing',
  'daily-briefing:{id}',
  ARRAY['id'],
  'AAIF home-page Hero sidebar items. Site-scoped via site_id column.'
)
ON CONFLICT (topic) DO UPDATE SET
  host_id_column = EXCLUDED.host_id_column,
  surrogate_key_template = EXCLUDED.surrogate_key_template,
  detail_key_template = EXCLUDED.detail_key_template,
  notify_columns = EXCLUDED.notify_columns,
  description = EXCLUDED.description;

-- AFTER INSERT/UPDATE/DELETE trigger — uses the shared
-- public.emit_mutation_event() function installed by the webhooks module.
DROP TRIGGER IF EXISTS daily_briefing_items_mutation ON public.daily_briefing_items;
CREATE TRIGGER daily_briefing_items_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.daily_briefing_items
  FOR EACH ROW EXECUTE FUNCTION public.emit_mutation_event();
