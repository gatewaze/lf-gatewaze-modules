-- ============================================================================
-- Module: podcasts
-- Migration: 001_podcasts_tables
-- Description: Create tables for podcasts, episodes, guests, and episode-guest
--              assignments
-- ============================================================================

-- ============================================================================
-- 1. podcasts — podcast series
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.podcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  description     text,
  cover_image_url text,
  rss_feed_url    text,
  website_url     text,
  is_active       boolean NOT NULL DEFAULT true,
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.podcasts IS 'Podcast series (e.g., MLOps Community Podcast)';

CREATE INDEX IF NOT EXISTS idx_podcasts_slug ON public.podcasts (slug);
CREATE INDEX IF NOT EXISTS idx_podcasts_active ON public.podcasts (is_active);

CREATE TRIGGER podcasts_updated_at
  BEFORE UPDATE ON public.podcasts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 2. podcast_episodes — individual episodes
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.podcast_episodes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id       uuid NOT NULL REFERENCES public.podcasts(id) ON DELETE CASCADE,
  title            text NOT NULL,
  slug             text,
  description      text,
  episode_number   integer,
  season           integer,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'scheduled', 'recording', 'editing', 'published', 'archived')),
  record_date      timestamptz,
  publish_date     timestamptz,
  audio_url        text,
  video_url        text,
  thumbnail_url    text,
  show_notes       text,
  duration_seconds integer,
  metadata         jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.podcast_episodes IS 'Individual podcast episodes';

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_podcast ON public.podcast_episodes (podcast_id);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_status ON public.podcast_episodes (status);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_record_date ON public.podcast_episodes (record_date);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_publish_date ON public.podcast_episodes (publish_date DESC);

CREATE TRIGGER podcast_episodes_updated_at
  BEFORE UPDATE ON public.podcast_episodes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3. podcast_guests — people who want to be on a podcast
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.podcast_guests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id        uuid REFERENCES public.podcasts(id) ON DELETE SET NULL,
  name              text NOT NULL,
  email             text NOT NULL,
  company           text,
  title             text,
  bio               text,
  linkedin_url      text,
  twitter_url       text,
  website_url       text,
  topic_suggestions text,
  notes             text,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'declined', 'contacted', 'archived')),
  source            text NOT NULL DEFAULT 'form'
                    CHECK (source IN ('form', 'manual', 'import')),
  person_id         uuid,
  metadata          jsonb DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.podcast_guests IS 'Guest list — people who applied or were added as potential podcast guests';

CREATE INDEX IF NOT EXISTS idx_podcast_guests_podcast ON public.podcast_guests (podcast_id);
CREATE INDEX IF NOT EXISTS idx_podcast_guests_status ON public.podcast_guests (status);
CREATE INDEX IF NOT EXISTS idx_podcast_guests_email ON public.podcast_guests (email);
CREATE INDEX IF NOT EXISTS idx_podcast_guests_source ON public.podcast_guests (source);

CREATE TRIGGER podcast_guests_updated_at
  BEFORE UPDATE ON public.podcast_guests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 4. podcast_episode_guests — join table linking guests to episodes
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.podcast_episode_guests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      uuid NOT NULL REFERENCES public.podcast_episodes(id) ON DELETE CASCADE,
  guest_id        uuid NOT NULL REFERENCES public.podcast_guests(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'guest'
                  CHECK (role IN ('guest', 'host', 'co-host', 'moderator')),
  is_confirmed    boolean NOT NULL DEFAULT false,
  notified_at     timestamptz,
  confirmed_at    timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, guest_id)
);

COMMENT ON TABLE public.podcast_episode_guests IS 'Junction table linking guests to specific episodes with roles';

CREATE INDEX IF NOT EXISTS idx_podcast_episode_guests_episode ON public.podcast_episode_guests (episode_id);
CREATE INDEX IF NOT EXISTS idx_podcast_episode_guests_guest ON public.podcast_episode_guests (guest_id);

CREATE TRIGGER podcast_episode_guests_updated_at
  BEFORE UPDATE ON public.podcast_episode_guests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 5. View: episode guests with details
-- ============================================================================
CREATE OR REPLACE VIEW public.podcast_episode_guests_with_details AS
SELECT
  peg.id,
  peg.episode_id,
  peg.guest_id,
  peg.role,
  peg.is_confirmed,
  peg.notified_at,
  peg.confirmed_at,
  peg.notes,
  peg.created_at,
  peg.updated_at,
  pg.name AS guest_name,
  pg.email AS guest_email,
  pg.company AS guest_company,
  pg.title AS guest_title,
  pg.bio AS guest_bio,
  pg.linkedin_url AS guest_linkedin_url,
  pe.title AS episode_title,
  pe.record_date AS episode_record_date,
  pe.status AS episode_status,
  p.name AS podcast_name,
  p.id AS podcast_id
FROM public.podcast_episode_guests peg
LEFT JOIN public.podcast_guests pg ON pg.id = peg.guest_id
LEFT JOIN public.podcast_episodes pe ON pe.id = peg.episode_id
LEFT JOIN public.podcasts p ON p.id = pe.podcast_id;

-- ============================================================================
-- 6. RLS Policies
-- ============================================================================
ALTER TABLE public.podcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.podcast_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.podcast_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.podcast_episode_guests ENABLE ROW LEVEL SECURITY;

-- SELECT: anon can read active podcasts (for portal guest form)
CREATE POLICY "podcasts_select_anon" ON public.podcasts FOR SELECT TO anon
  USING (is_active = true);

-- SELECT: authenticated can read all
CREATE POLICY "podcasts_select" ON public.podcasts FOR SELECT TO authenticated USING (true);
CREATE POLICY "podcast_episodes_select" ON public.podcast_episodes FOR SELECT TO authenticated USING (true);
CREATE POLICY "podcast_guests_select" ON public.podcast_guests FOR SELECT TO authenticated USING (true);
CREATE POLICY "podcast_episode_guests_select" ON public.podcast_episode_guests FOR SELECT TO authenticated USING (true);

-- INSERT: admin only
CREATE POLICY "podcasts_insert" ON public.podcasts FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "podcast_episodes_insert" ON public.podcast_episodes FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "podcast_guests_insert" ON public.podcast_guests FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "podcast_episode_guests_insert" ON public.podcast_episode_guests FOR INSERT TO authenticated WITH CHECK (public.is_admin());

-- UPDATE: admin only
CREATE POLICY "podcasts_update" ON public.podcasts FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "podcast_episodes_update" ON public.podcast_episodes FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "podcast_guests_update" ON public.podcast_guests FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "podcast_episode_guests_update" ON public.podcast_episode_guests FOR UPDATE TO authenticated USING (public.is_admin());

-- DELETE: admin only
CREATE POLICY "podcasts_delete" ON public.podcasts FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "podcast_episodes_delete" ON public.podcast_episodes FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "podcast_guests_delete" ON public.podcast_guests FOR DELETE TO authenticated USING (public.is_admin());
CREATE POLICY "podcast_episode_guests_delete" ON public.podcast_episode_guests FOR DELETE TO authenticated USING (public.is_admin());

-- Service role: full access (for API form submissions)
CREATE POLICY "podcasts_service" ON public.podcasts FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "podcast_episodes_service" ON public.podcast_episodes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "podcast_guests_service" ON public.podcast_guests FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "podcast_episode_guests_service" ON public.podcast_episode_guests FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- 7. RPC: Podcast stats for dashboard
-- ============================================================================
CREATE OR REPLACE FUNCTION public.podcast_stats()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT jsonb_build_object(
    'total_podcasts', (SELECT count(*) FROM public.podcasts WHERE is_active = true),
    'total_episodes', (SELECT count(*) FROM public.podcast_episodes),
    'published_episodes', (SELECT count(*) FROM public.podcast_episodes WHERE status = 'published'),
    'total_guests', (SELECT count(*) FROM public.podcast_guests),
    'pending_guests', (SELECT count(*) FROM public.podcast_guests WHERE status = 'pending'),
    'approved_guests', (SELECT count(*) FROM public.podcast_guests WHERE status = 'approved')
  );
$$;
