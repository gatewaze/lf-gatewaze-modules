-- Add content_category to podcasts and podcast_episodes tables.

ALTER TABLE public.podcasts ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_podcasts_content_category ON public.podcasts (content_category);

ALTER TABLE public.podcast_episodes ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_content_category ON public.podcast_episodes (content_category);
