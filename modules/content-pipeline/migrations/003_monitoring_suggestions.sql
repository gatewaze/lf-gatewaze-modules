-- ============================================================================
-- Module: content-pipeline
-- Migration: 003_monitoring_suggestions
-- Description: Add table for user-submitted monitoring suggestions
--              Allows users to suggest search topics, keywords, channels,
--              and other criteria for the discovery agent to monitor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.content_monitoring_suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What to monitor
  suggestion_type text NOT NULL DEFAULT 'search_query'
                  CHECK (suggestion_type IN (
                    'search_query',       -- General search terms (e.g., "MCP authentication patterns")
                    'youtube_channel',    -- YouTube channel to follow
                    'rss_feed',           -- RSS feed URL
                    'github_topic',       -- GitHub topic to track
                    'github_repo',        -- Specific GitHub repo to watch
                    'website',            -- Website to scrape
                    'reddit_subreddit',   -- Subreddit to monitor
                    'project'             -- Suggest a new project for taxonomy
                  )),
  -- The actual suggestion content
  title           text NOT NULL,          -- Short label (e.g., "MCP Server Security")
  description     text,                   -- Why this should be monitored
  search_query    text,                   -- Search keywords/terms
  url             text,                   -- URL for feeds, channels, repos, etc.
  -- Moderation
  submitted_by    text NOT NULL DEFAULT 'anonymous',
  submitted_by_id uuid,                   -- User ID if authenticated
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'converted')),
  admin_notes     text,                   -- Admin feedback on the suggestion
  -- If approved, link to the created discovery source or project
  converted_source_id uuid REFERENCES public.content_discovery_sources(id) ON DELETE SET NULL,
  converted_project_id uuid REFERENCES public.content_project_taxonomy(id) ON DELETE SET NULL,
  -- Voting / popularity
  vote_count      integer NOT NULL DEFAULT 0,
  -- Timestamps
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz
);

COMMENT ON TABLE public.content_monitoring_suggestions IS 'User-submitted suggestions for topics, channels, and search criteria to monitor';

CREATE INDEX IF NOT EXISTS idx_content_monitoring_suggestions_status ON public.content_monitoring_suggestions (status);
CREATE INDEX IF NOT EXISTS idx_content_monitoring_suggestions_type ON public.content_monitoring_suggestions (suggestion_type);
CREATE INDEX IF NOT EXISTS idx_content_monitoring_suggestions_votes ON public.content_monitoring_suggestions (vote_count DESC);
CREATE INDEX IF NOT EXISTS idx_content_monitoring_suggestions_created ON public.content_monitoring_suggestions (created_at DESC);

CREATE TRIGGER content_monitoring_suggestions_updated_at
  BEFORE UPDATE ON public.content_monitoring_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.content_monitoring_suggestions ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read and submit suggestions
CREATE POLICY "content_monitoring_suggestions_select" ON public.content_monitoring_suggestions FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_monitoring_suggestions_insert" ON public.content_monitoring_suggestions FOR INSERT TO authenticated WITH CHECK (true);

-- Only admins can update (approve/reject) and delete
CREATE POLICY "content_monitoring_suggestions_update" ON public.content_monitoring_suggestions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_monitoring_suggestions_delete" ON public.content_monitoring_suggestions FOR DELETE TO authenticated USING (public.is_admin());

-- ============================================================================
-- RPC: Upvote a suggestion (any authenticated user)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.content_upvote_suggestion(suggestion_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE public.content_monitoring_suggestions
  SET vote_count = vote_count + 1
  WHERE id = suggestion_id;
$$;

-- ============================================================================
-- Update pipeline stats to include suggestions count
-- ============================================================================
CREATE OR REPLACE FUNCTION public.content_pipeline_stats()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT jsonb_build_object(
    'total_items', (SELECT count(*) FROM public.content_items),
    'total_videos', (SELECT count(*) FROM public.content_items WHERE content_type = 'video'),
    'total_articles', (SELECT count(*) FROM public.content_items WHERE content_type = 'article'),
    'total_segments', (SELECT count(*) FROM public.content_segments),
    'pending_submissions', (SELECT count(*) FROM public.content_submissions WHERE status = 'pending'),
    'pending_queue', (SELECT count(*) FROM public.content_queue WHERE status = 'pending'),
    'processing_queue', (SELECT count(*) FROM public.content_queue WHERE status = 'processing'),
    'failed_queue', (SELECT count(*) FROM public.content_queue WHERE status = 'failed'),
    'active_sources', (SELECT count(*) FROM public.content_discovery_sources WHERE is_active = true),
    'items_last_24h', (SELECT count(*) FROM public.content_items WHERE created_at > now() - interval '24 hours'),
    'discovery_runs_last_24h', (SELECT count(*) FROM public.content_discovery_runs WHERE started_at > now() - interval '24 hours'),
    'tracked_projects', (SELECT count(*) FROM public.content_project_taxonomy WHERE is_active = true),
    'tracked_topics', (SELECT count(*) FROM public.content_topic_taxonomy WHERE is_active = true),
    'pending_suggestions', (SELECT count(*) FROM public.content_monitoring_suggestions WHERE status = 'pending')
  );
$$;
