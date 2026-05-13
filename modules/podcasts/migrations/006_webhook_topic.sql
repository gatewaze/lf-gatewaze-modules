-- ============================================================================
-- Module: podcasts
-- Migration: 006_webhook_topic
-- Description: Register podcast_episodes as a webhook topic and attach the
--              shared emit_mutation_event() trigger. Per
--              spec-api-cache-and-revalidation §4.2 and §4.4.
--
-- Note: podcast_episodes has no site_id column — episodes belong to a
-- podcast, which the AAIF host always represents as the platform-wide
-- 'Daily Agentic AI' show. Subscriptions interested in podcast updates
-- register with host_kind='global'; the trigger emits host_id as the
-- well-known global UUID (00000000-0000-0000-0000-000000000000).
-- ============================================================================

INSERT INTO public.webhook_event_topics
  (topic, host_id_column, surrogate_key_template, detail_key_template, notify_columns, description)
VALUES (
  'podcast_episodes',
  NULL,
  'podcasts',
  'podcasts:{slug}',
  ARRAY['slug'],
  'Podcast episodes. Cross-tenant; subscribed by host_kind=global subscriptions.'
)
ON CONFLICT (topic) DO UPDATE SET
  host_id_column = EXCLUDED.host_id_column,
  surrogate_key_template = EXCLUDED.surrogate_key_template,
  detail_key_template = EXCLUDED.detail_key_template,
  notify_columns = EXCLUDED.notify_columns,
  description = EXCLUDED.description;

DROP TRIGGER IF EXISTS podcast_episodes_mutation ON public.podcast_episodes;
CREATE TRIGGER podcast_episodes_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.podcast_episodes
  FOR EACH ROW EXECUTE FUNCTION public.emit_mutation_event();
