-- ============================================================================
-- Module: projects
-- Migration: 002_webhook_topic
-- Description: Register projects as a webhook topic and attach the shared
--              emit_mutation_event() trigger. Per
--              spec-api-cache-and-revalidation §4.2 and §4.4.
--
-- Depends on: webhooks/001 + 002.
-- ============================================================================

INSERT INTO public.webhook_event_topics
  (topic, host_id_column, surrogate_key_template, detail_key_template, notify_columns, description)
VALUES (
  'projects',
  'site_id',
  'projects',
  'projects:{slug}',
  ARRAY['slug'],
  'Per-site projects (AAIF project pages). Site-scoped via site_id column.'
)
ON CONFLICT (topic) DO UPDATE SET
  host_id_column = EXCLUDED.host_id_column,
  surrogate_key_template = EXCLUDED.surrogate_key_template,
  detail_key_template = EXCLUDED.detail_key_template,
  notify_columns = EXCLUDED.notify_columns,
  description = EXCLUDED.description;

DROP TRIGGER IF EXISTS projects_mutation ON public.projects;
CREATE TRIGGER projects_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.emit_mutation_event();
