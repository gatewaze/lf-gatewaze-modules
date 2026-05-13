/**
 * Public read-only podcasts API.
 *
 * Mounted on the platform's public router (no JWT required). Themes /
 * static-site generators / the AAIF Next.js app consume these endpoints
 * to render the home-page WrittenContentHub "Podcasts" tab from
 * Gatewaze's `podcast_episodes` table (joined with `podcasts`).
 *
 *   GET /api/podcasts/episodes                   — list published episodes
 *     ?limit=N (default 20, max 100)
 *     ?offset=N
 *     ?podcast_slug=<slug>                       — filter to one podcast
 *     ?search=<text>                             — ilike on title + description
 *   GET /api/podcasts/episodes/:slug             — single episode by slug
 *
 * All endpoints:
 *   - filter to status='published'
 *   - join podcast info (name, slug, cover_image_url) under `podcast`
 *   - Cache-Control: public, max-age=60, s-maxage=300
 *   - no auth required
 */

import type { Request, Response, Router } from 'express';

interface ErrorEnvelope {
  error: string;
  message: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CACHE_HEADER = 'public, max-age=60, s-maxage=300';

// The embedded podcast info uses PostgREST's foreign-key resource embed
// syntax: `podcast:podcasts(name, slug, cover_image_url)`.
const LIST_COLUMNS = [
  'id',
  'podcast_id',
  'slug',
  'title',
  'description',
  'episode_number',
  'season',
  'publish_date',
  'audio_url',
  'video_url',
  'thumbnail_url',
  'duration_seconds',
  'podcast:podcasts(name, slug, cover_image_url, website_url)',
].join(', ');

// Detail endpoint additionally returns `show_notes`.
const DETAIL_COLUMNS = LIST_COLUMNS + ', show_notes';

export interface PublicPodcastsRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

function clampLimit(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function clampOffset(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : 0;
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

export function createPublicPodcastsRoutes(deps: PublicPodcastsRoutesDeps) {
  const { supabase, logger } = deps;

  async function listEpisodes(req: Request, res: Response): Promise<void> {
    const limit = clampLimit(paramAs(req.query.limit));
    const offset = clampOffset(paramAs(req.query.offset));
    const search = paramAs(req.query.search);
    const podcastSlug = paramAs(req.query.podcast_slug);

    // If filtering by podcast_slug, we need the podcast.id first. Resolve
    // it in a small lookup so the main query can stay a single round-trip.
    let podcastId: string | null = null;
    if (podcastSlug) {
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(podcastSlug)) {
        sendError(res, 400, 'bad_request', 'podcast_slug must be a url-safe slug');
        return;
      }
      const lookup = await supabase
        .from('podcasts')
        .select('id')
        .eq('slug', podcastSlug)
        .eq('is_active', true)
        .maybeSingle();
      if (lookup.error) {
        logger.warn('podcasts.public.list.lookup_error', { error: lookup.error.message });
        sendError(res, 500, 'internal', String(lookup.error.message ?? ''));
        return;
      }
      if (!lookup.data) {
        // Unknown podcast — empty list, not an error.
        res.setHeader('Cache-Control', CACHE_HEADER);
        res.status(200).json({ episodes: [], limit, offset });
        return;
      }
      podcastId = lookup.data.id;
    }

    let query = supabase
      .from('podcast_episodes')
      .select(LIST_COLUMNS)
      .eq('status', 'published')
      .order('publish_date', { ascending: false, nullsFirst: false })
      .order('episode_number', { ascending: false, nullsFirst: false });

    if (podcastId) query = query.eq('podcast_id', podcastId);

    if (search) {
      // ilike on title + description. PostgREST `.or()` is a known
      // injection vector — strip filter metacharacters and cap length
      // before interpolation. (Same pattern as press / projects.)
      const safe = String(search).replace(/[,()*\\]/g, '').slice(0, 100);
      if (safe.length > 0) {
        query = query.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`);
      }
    }

    query = query.range(offset, offset + limit - 1);

    const result = await query;
    if (result.error) {
      logger.warn('podcasts.public.list.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }

    res.setHeader('Cache-Control', CACHE_HEADER);
    res.status(200).json({
      episodes: (result.data ?? []) as unknown[],
      limit,
      offset,
    });
  }

  async function getEpisode(req: Request, res: Response): Promise<void> {
    const slug = paramAs(req.params.slug);
    if (!slug) {
      sendError(res, 400, 'missing_slug', 'slug required');
      return;
    }
    // slugs are url-safe: lowercase alphanumeric + hyphen. Reject anything
    // else early so we don't even hit Postgres.
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(slug)) {
      sendError(res, 404, 'not_found', `podcast episode '${slug}' not found`);
      return;
    }

    const query = supabase
      .from('podcast_episodes')
      .select(DETAIL_COLUMNS)
      .eq('slug', slug)
      .eq('status', 'published');

    const result = await query.maybeSingle();
    if (result.error) {
      logger.warn('podcasts.public.detail.db_error', { error: result.error.message, slug });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `podcast episode '${slug}' not found`);
      return;
    }

    res.setHeader('Cache-Control', CACHE_HEADER);
    res.status(200).json(result.data);
  }

  return { listEpisodes, getEpisode };
}

export function mountPublicPodcastsRoutes(
  router: Router,
  routes: ReturnType<typeof createPublicPodcastsRoutes>,
): void {
  router.get('/podcasts/episodes', routes.listEpisodes);
  router.get('/podcasts/episodes/:slug', routes.getEpisode);
}

function sendError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message } satisfies ErrorEnvelope);
}
