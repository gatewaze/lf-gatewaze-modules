/**
 * Public read-only press API.
 *
 * Mounted on the platform's public router (no JWT required). Themes /
 * static-site generators / the AAIF Next.js app consume these endpoints
 * to render the home-page WrittenContentHub "Press & News" tab from
 * Gatewaze's `press_releases` table.
 *
 *   GET /api/press                       — list published press releases
 *     ?limit=N (default 20, max 100)
 *     ?offset=N
 *     ?kind=release|coverage|announcement — filter by exact kind
 *     ?tag=<slug>                         — filter by tag (array membership)
 *     ?featured=true                      — only is_featured rows
 *     ?search=<text>                      — ilike on title + summary
 *     ?site_id=<uuid>                     — restrict to one site (optional)
 *   GET /api/press/:slug                  — single press release by slug,
 *                                           includes `body` markdown.
 *
 * All endpoints:
 *   - filter to status='published'
 *   - Cache-Control: public, max-age=60, s-maxage=300
 *   - no auth required
 */

import { createHash } from 'node:crypto';

import type { Request, Response, Router } from 'express';

interface ErrorEnvelope {
  error: string;
  message: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CACHE_HEADER = 'public, max-age=60, s-maxage=300, stale-if-error=86400';

const LIST_COLUMNS = [
  'id',
  'site_id',
  'slug',
  'title',
  'summary',
  'kind',
  'publisher_name',
  'publisher_logo_url',
  'external_url',
  'featured_image_url',
  'featured_image_alt',
  'tags',
  'is_featured',
  'published_at',
].join(', ');

// Detail endpoint additionally returns `body` (markdown content). For
// kind='coverage' this column is typically null — the card just links
// out to external_url.
const DETAIL_COLUMNS = LIST_COLUMNS + ', body';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KINDS = new Set(['release', 'coverage', 'announcement']);

export interface PublicPressRoutesDeps {
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

export function createPublicPressRoutes(deps: PublicPressRoutesDeps) {
  const { supabase, logger } = deps;

  async function listReleases(req: Request, res: Response): Promise<void> {
    const limit = clampLimit(paramAs(req.query.limit));
    const offset = clampOffset(paramAs(req.query.offset));
    const kind = paramAs(req.query.kind);
    const tag = paramAs(req.query.tag);
    const search = paramAs(req.query.search);
    const featured = paramAs(req.query.featured) === 'true';
    const siteId = paramAs(req.query.site_id);

    let query = supabase
      .from('press_releases')
      .select(LIST_COLUMNS)
      .eq('status', 'published')
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('title', { ascending: true });

    if (siteId) {
      if (!UUID_RE.test(siteId)) {
        sendError(res, 400, 'bad_request', 'site_id must be a uuid');
        return;
      }
      query = query.eq('site_id', siteId);
    }

    if (kind) {
      if (!ALLOWED_KINDS.has(kind)) {
        sendError(res, 400, 'bad_request', "kind must be one of 'release','coverage','announcement'");
        return;
      }
      query = query.eq('kind', kind);
    }
    if (featured) query = query.eq('is_featured', true);
    if (tag) query = query.contains('tags', [tag]);

    if (search) {
      // ilike on title + summary. PostgREST `.or()` is a known injection
      // vector — strip filter metacharacters and cap length before
      // interpolation. (Same pattern as projects / blog public-routes.)
      const safe = String(search).replace(/[,()*\\]/g, '').slice(0, 100);
      if (safe.length > 0) {
        query = query.or(`title.ilike.%${safe}%,summary.ilike.%${safe}%`);
      }
    }

    query = query.range(offset, offset + limit - 1);

    const result = await query;
    if (result.error) {
      logger.warn('press.public.list.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }

    sendCacheable(
      req,
      res,
      {
        releases: (result.data ?? []) as unknown[],
        limit,
        offset,
      },
      ['press'],
    );
  }

  async function getRelease(req: Request, res: Response): Promise<void> {
    const slug = paramAs(req.params.slug);
    if (!slug) {
      sendError(res, 400, 'missing_slug', 'slug required');
      return;
    }
    // slugs are url-safe: lowercase alphanumeric + hyphen. Reject anything
    // else early so we don't even hit Postgres.
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(slug)) {
      sendError(res, 404, 'not_found', `press release '${slug}' not found`);
      return;
    }

    const siteId = paramAs(req.query.site_id);
    if (siteId && !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id must be a uuid');
      return;
    }

    let query = supabase
      .from('press_releases')
      .select(DETAIL_COLUMNS)
      .eq('slug', slug)
      .eq('status', 'published');
    if (siteId) query = query.eq('site_id', siteId);

    const result = await query.maybeSingle();
    if (result.error) {
      logger.warn('press.public.detail.db_error', { error: result.error.message, slug });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `press release '${slug}' not found`);
      return;
    }

    sendCacheable(req, res, result.data, ['press', `press:${slug}`]);
  }

  return { listReleases, getRelease };
}

export function mountPublicPressRoutes(
  router: Router,
  routes: ReturnType<typeof createPublicPressRoutes>,
): void {
  router.get('/press', routes.listReleases);
  router.get('/press/:slug', routes.getRelease);
}

function sendError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message } satisfies ErrorEnvelope);
}

/**
 * Emit a cacheable response with the headers the Layer-3 CDN expects:
 *
 *   Cache-Control:  public, max-age=60, s-maxage=300, stale-if-error=86400
 *   Surrogate-Key:  <topic> [<topic>:<id-or-slug> ...]
 *   ETag:           W/"<sha256(body)[0:16]>"
 *
 * Spec: §5.4 of spec-api-cache-and-revalidation.md.
 *
 * If the client's `If-None-Match` matches the computed ETag we return
 * 304 with no body (origin bandwidth save inside the max-age window).
 */
function sendCacheable(
  req: Request,
  res: Response,
  body: unknown,
  surrogateKeys: string[],
): void {
  const json = JSON.stringify(body);
  const etag = `W/"${createHash('sha256').update(json).digest('hex').slice(0, 16)}"`;
  res.setHeader('Cache-Control', CACHE_HEADER);
  res.setHeader('Surrogate-Key', surrogateKeys.join(' '));
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.status(200).type('application/json').send(json);
}
