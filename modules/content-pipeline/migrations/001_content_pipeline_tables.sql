-- ============================================================================
-- Module: content-pipeline
-- Migration: 001_content_pipeline_tables
-- Description: Create all tables for the content intelligence pipeline
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- Project Taxonomy — controlled vocabulary of tracked projects
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_project_taxonomy (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  description     text,
  aliases         text[] DEFAULT '{}',
  website_url     text,
  github_url      text,
  is_active       boolean NOT NULL DEFAULT true,
  category        text CHECK (category IN ('protocol', 'framework', 'tool', 'standard', 'specification')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_project_taxonomy IS 'Controlled vocabulary of tracked agentic AI projects';

CREATE INDEX IF NOT EXISTS idx_content_project_taxonomy_slug ON public.content_project_taxonomy (slug);
CREATE INDEX IF NOT EXISTS idx_content_project_taxonomy_active ON public.content_project_taxonomy (is_active);

-- ============================================================================
-- Topic Taxonomy — controlled vocabulary of content topics
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_topic_taxonomy (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  description     text,
  parent_slug     text REFERENCES public.content_topic_taxonomy(slug) ON DELETE SET NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_topic_taxonomy IS 'Controlled vocabulary of content topics';

CREATE INDEX IF NOT EXISTS idx_content_topic_taxonomy_slug ON public.content_topic_taxonomy (slug);
CREATE INDEX IF NOT EXISTS idx_content_topic_taxonomy_parent ON public.content_topic_taxonomy (parent_slug);

-- ============================================================================
-- Content Submissions — raw inputs from users or the discovery agent
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url             text,
  search_query    text,
  submitted_by    text NOT NULL DEFAULT 'user',
  submission_type text NOT NULL DEFAULT 'url'
                  CHECK (submission_type IN ('url', 'search_query')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'triaging', 'completed', 'failed', 'duplicate')),
  error_message   text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_submissions IS 'Raw content submissions from users or discovery agent';

CREATE INDEX IF NOT EXISTS idx_content_submissions_status ON public.content_submissions (status);
CREATE INDEX IF NOT EXISTS idx_content_submissions_created ON public.content_submissions (created_at DESC);

CREATE TRIGGER content_submissions_updated_at
  BEFORE UPDATE ON public.content_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Content Queue — individual items awaiting processing
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_queue (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id         uuid REFERENCES public.content_submissions(id) ON DELETE SET NULL,
  url                   text NOT NULL UNIQUE,
  title                 text,
  content_type          text CHECK (content_type IN (
    'article', 'video', 'image', 'repo', 'tutorial', 'talk', 'podcast', 'documentation'
  )),
  source_type           text CHECK (source_type IN (
    'youtube', 'blog', 'github', 'twitter', 'conference', 'podcast', 'rss', 'reddit', 'hackernews'
  )),
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  priority              integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  retry_count           integer NOT NULL DEFAULT 0,
  max_retries           integer NOT NULL DEFAULT 3,
  error_message         text,
  metadata              jsonb DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz
);

COMMENT ON TABLE public.content_queue IS 'Content items awaiting processing by the processing agent';

CREATE INDEX IF NOT EXISTS idx_content_queue_status ON public.content_queue (status);
CREATE INDEX IF NOT EXISTS idx_content_queue_priority ON public.content_queue (priority, created_at);
CREATE INDEX IF NOT EXISTS idx_content_queue_url ON public.content_queue (url);

CREATE TRIGGER content_queue_updated_at
  BEFORE UPDATE ON public.content_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Content Items — fully processed content
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id            uuid REFERENCES public.content_queue(id) ON DELETE SET NULL,
  url                 text NOT NULL UNIQUE,
  title               text NOT NULL,
  content_type        text NOT NULL CHECK (content_type IN (
    'article', 'video', 'image', 'repo', 'tutorial', 'talk', 'podcast', 'documentation'
  )),
  source_type         text NOT NULL CHECK (source_type IN (
    'youtube', 'blog', 'github', 'twitter', 'conference', 'podcast', 'rss', 'reddit', 'hackernews'
  )),
  author              text,
  author_url          text,
  publish_date        timestamptz,
  summary             text,
  hot_take            text,
  topics              text[] DEFAULT '{}',
  projects            text[] DEFAULT '{}',
  key_people          text[] DEFAULT '{}',
  thumbnail_url       text,
  duration_seconds    integer,
  raw_text            text,
  transcript          text,
  has_segments        boolean NOT NULL DEFAULT false,
  language            text NOT NULL DEFAULT 'en',
  metadata            jsonb DEFAULT '{}',
  embedding           vector(1536),
  sanity_document_id  text,
  quality_score       numeric CHECK (quality_score >= 0 AND quality_score <= 1),
  discovered_at       timestamptz,
  processed_at        timestamptz,
  refreshed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_items IS 'Fully processed content items — the core Gatewaze content database';

CREATE INDEX IF NOT EXISTS idx_content_items_content_type ON public.content_items (content_type);
CREATE INDEX IF NOT EXISTS idx_content_items_source_type ON public.content_items (source_type);
CREATE INDEX IF NOT EXISTS idx_content_items_projects ON public.content_items USING GIN (projects);
CREATE INDEX IF NOT EXISTS idx_content_items_topics ON public.content_items USING GIN (topics);
CREATE INDEX IF NOT EXISTS idx_content_items_publish_date ON public.content_items (publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_content_items_quality_score ON public.content_items (quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_content_items_url ON public.content_items (url);

CREATE TRIGGER content_items_updated_at
  BEFORE UPDATE ON public.content_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Content Segments — deep-indexed video/audio segments with timestamps
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_segments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id   uuid NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
  segment_index     integer NOT NULL,
  start_time        integer NOT NULL,
  end_time          integer NOT NULL,
  title             text NOT NULL,
  summary           text,
  topics            text[] DEFAULT '{}',
  projects          text[] DEFAULT '{}',
  key_people        text[] DEFAULT '{}',
  transcript_text   text,
  embedding         vector(1536),
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_segments IS 'Deep-indexed segments of video/audio content with timestamped topics';

CREATE INDEX IF NOT EXISTS idx_content_segments_item ON public.content_segments (content_item_id);
CREATE INDEX IF NOT EXISTS idx_content_segments_projects ON public.content_segments USING GIN (projects);
CREATE INDEX IF NOT EXISTS idx_content_segments_topics ON public.content_segments USING GIN (topics);

-- ============================================================================
-- Discovery Sources — configured sources for the discovery agent
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_discovery_sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  source_type       text NOT NULL CHECK (source_type IN (
    'rss', 'youtube_channel', 'youtube_search', 'google_search',
    'github_topic', 'github_repo', 'twitter_account',
    'reddit_subreddit', 'hackernews', 'website'
  )),
  source_url        text,
  search_query      text,
  check_frequency   interval NOT NULL DEFAULT '6 hours',
  last_checked_at   timestamptz,
  is_active         boolean NOT NULL DEFAULT true,
  priority          integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  metadata          jsonb DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.content_discovery_sources IS 'Configured content sources monitored by the discovery agent';

CREATE INDEX IF NOT EXISTS idx_content_discovery_sources_active ON public.content_discovery_sources (is_active);
CREATE INDEX IF NOT EXISTS idx_content_discovery_sources_type ON public.content_discovery_sources (source_type);

CREATE TRIGGER content_discovery_sources_updated_at
  BEFORE UPDATE ON public.content_discovery_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Discovery Runs — log of discovery agent executions
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_discovery_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid REFERENCES public.content_discovery_sources(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed')),
  items_found       integer NOT NULL DEFAULT 0,
  items_submitted   integer NOT NULL DEFAULT 0,
  error_message     text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

COMMENT ON TABLE public.content_discovery_runs IS 'Log of discovery agent executions for monitoring';

CREATE INDEX IF NOT EXISTS idx_content_discovery_runs_source ON public.content_discovery_runs (source_id);
CREATE INDEX IF NOT EXISTS idx_content_discovery_runs_status ON public.content_discovery_runs (status);
CREATE INDEX IF NOT EXISTS idx_content_discovery_runs_started ON public.content_discovery_runs (started_at DESC);

-- ============================================================================
-- RLS Policies
-- ============================================================================
ALTER TABLE public.content_project_taxonomy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_topic_taxonomy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_discovery_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_discovery_runs ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users can read all pipeline data
CREATE POLICY "content_project_taxonomy_select" ON public.content_project_taxonomy FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_topic_taxonomy_select" ON public.content_topic_taxonomy FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_submissions_select" ON public.content_submissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_queue_select" ON public.content_queue FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_items_select" ON public.content_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_segments_select" ON public.content_segments FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_discovery_sources_select" ON public.content_discovery_sources FOR SELECT TO authenticated USING (true);
CREATE POLICY "content_discovery_runs_select" ON public.content_discovery_runs FOR SELECT TO authenticated USING (true);

-- INSERT: submissions open to all authenticated, rest admin only
CREATE POLICY "content_submissions_insert" ON public.content_submissions FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "content_project_taxonomy_insert" ON public.content_project_taxonomy FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "content_topic_taxonomy_insert" ON public.content_topic_taxonomy FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "content_queue_insert" ON public.content_queue FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "content_items_insert" ON public.content_items FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "content_segments_insert" ON public.content_segments FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "content_discovery_sources_insert" ON public.content_discovery_sources FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "content_discovery_runs_insert" ON public.content_discovery_runs FOR INSERT TO authenticated WITH CHECK (public.is_admin());

-- UPDATE: admin only
CREATE POLICY "content_project_taxonomy_update" ON public.content_project_taxonomy FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_topic_taxonomy_update" ON public.content_topic_taxonomy FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_submissions_update" ON public.content_submissions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_queue_update" ON public.content_queue FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_items_update" ON public.content_items FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_segments_update" ON public.content_segments FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_discovery_sources_update" ON public.content_discovery_sources FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "content_discovery_runs_update" ON public.content_discovery_runs FOR UPDATE TO authenticated USING (public.is_admin());

-- DELETE: admin only
CREATE POLICY "content_project_taxonomy_delete" ON public.content_project_taxonomy FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "content_topic_taxonomy_delete" ON public.content_topic_taxonomy FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "content_submissions_delete" ON public.content_submissions FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "content_queue_delete" ON public.content_queue FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "content_items_delete" ON public.content_items FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "content_segments_delete" ON public.content_segments FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "content_discovery_sources_delete" ON public.content_discovery_sources FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "content_discovery_runs_delete" ON public.content_discovery_runs FOR DELETE TO authenticated USING (public.is_admin());

-- ============================================================================
-- RPC: Pipeline stats for dashboard
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
    'tracked_topics', (SELECT count(*) FROM public.content_topic_taxonomy WHERE is_active = true)
  );
$$;
