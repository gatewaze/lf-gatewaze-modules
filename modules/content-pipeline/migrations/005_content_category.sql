-- Add content_category to content_items and content_submissions tables.

ALTER TABLE public.content_items ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_content_items_content_category ON public.content_items (content_category);

ALTER TABLE public.content_submissions ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_content_submissions_content_category ON public.content_submissions (content_category);
