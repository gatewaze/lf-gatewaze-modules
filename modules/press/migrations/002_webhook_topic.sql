-- ============================================================================
-- Module: press
-- Migration: 002_webhook_topic
-- Description: Register press_releases as a webhook topic and attach the
--              shared emit_mutation_event() trigger. Per
--              spec-api-cache-and-revalidation §4.2 and §4.4.
-- ============================================================================

INSERT INTO public.webhook_event_topics
  (topic, host_id_column, surrogate_key_template, detail_key_template, notify_columns, description)
VALUES (
  'press_releases',
  'site_id',
  'press',
  'press:{slug}',
  ARRAY['slug'],
  'AAIF press-release index + detail pages. Site-scoped via site_id column.'
)
ON CONFLICT (topic) DO UPDATE SET
  host_id_column = EXCLUDED.host_id_column,
  surrogate_key_template = EXCLUDED.surrogate_key_template,
  detail_key_template = EXCLUDED.detail_key_template,
  notify_columns = EXCLUDED.notify_columns,
  description = EXCLUDED.description;

DROP TRIGGER IF EXISTS press_releases_mutation ON public.press_releases;
CREATE TRIGGER press_releases_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.press_releases
  FOR EACH ROW EXECUTE FUNCTION public.emit_mutation_event();
