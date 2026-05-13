/**
 * Public read-only projects API.
 *
 * Mounted on the platform's public router (no JWT required). Themes /
 * static-site generators / the AAIF Next.js app consume these endpoints
 * to render the home-page ProjectsSection from Gatewaze's `projects`
 * table.
 *
 *   GET /api/projects                  — list published projects
 *     ?limit=N (default 20, max 100)
 *     ?offset=N
 *     ?category=<slug>                 — filter by exact category
 *     ?tag=<slug>                      — filter by tag (array membership)
 *     ?featured=true                   — only is_featured rows
 *     ?search=<text>                   — ilike on title + short_description
 *     ?site_id=<uuid>                  — restrict to one site (optional —
 *                                        the AAIF dev DB has a single
 *                                        site so the default omits)
 *   GET /api/projects/:slug            — single project by slug
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
  'short_description',
  'logo_url',
  'logo_alt',
  'cover_image_url',
  'website_url',
  'github_url',
  'docs_url',
  'category',
  'tags',
  'is_featured',
  'sort_order',
  'maintainer_org',
  'license',
  'founded_at',
].join(', ');

const DETAIL_COLUMNS = LIST_COLUMNS + ', long_description';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicProjectsRoutesDeps {
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

export function createPublicProjectsRoutes(deps: PublicProjectsRoutesDeps) {
  const { supabase, logger } = deps;

  async function listProjects(req: Request, res: Response): Promise<void> {
    const limit = clampLimit(paramAs(req.query.limit));
    const offset = clampOffset(paramAs(req.query.offset));
    const category = paramAs(req.query.category);
    const tag = paramAs(req.query.tag);
    const search = paramAs(req.query.search);
    const featured = paramAs(req.query.featured) === 'true';
    const siteId = paramAs(req.query.site_id);

    let query = supabase
      .from('projects')
      .select(LIST_COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true });

    if (siteId) {
      if (!UUID_RE.test(siteId)) {
        sendError(res, 400, 'bad_request', 'site_id must be a uuid');
        return;
      }
      query = query.eq('site_id', siteId);
    }

    if (category) query = query.eq('category', category);
    if (featured) query = query.eq('is_featured', true);
    if (tag) query = query.contains('tags', [tag]);

    if (search) {
      // ilike on title + short_description. PostgREST `.or()` is a
      // known injection vector — strip filter metacharacters and cap
      // length before interpolation. (Same pattern as people.ts /
      // blog public-routes.)
      const safe = String(search).replace(/[,()*\\]/g, '').slice(0, 100);
      if (safe.length > 0) {
        query = query.or(`title.ilike.%${safe}%,short_description.ilike.%${safe}%`);
      }
    }

    query = query.range(offset, offset + limit - 1);

    const result = await query;
    if (result.error) {
      logger.warn('projects.public.list.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }

    sendCacheable(
      req,
      res,
      {
        projects: (result.data ?? []) as unknown[],
        limit,
        offset,
      },
      ['projects'],
    );
  }

  async function getProject(req: Request, res: Response): Promise<void> {
    const slug = paramAs(req.params.slug);
    if (!slug) {
      sendError(res, 400, 'missing_slug', 'slug required');
      return;
    }
    // slugs are url-safe: lowercase alphanumeric + hyphen. Reject
    // anything else early so we don't even hit Postgres.
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(slug)) {
      sendError(res, 404, 'not_found', `project '${slug}' not found`);
      return;
    }

    const siteId = paramAs(req.query.site_id);
    if (siteId && !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id must be a uuid');
      return;
    }

    let query = supabase
      .from('projects')
      .select(DETAIL_COLUMNS)
      .eq('slug', slug)
      .eq('status', 'published');
    if (siteId) query = query.eq('site_id', siteId);

    const result = await query.maybeSingle();
    if (result.error) {
      logger.warn('projects.public.detail.db_error', { error: result.error.message, slug });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `project '${slug}' not found`);
      return;
    }

    sendCacheable(req, res, result.data, ['projects', `projects:${slug}`]);
  }

  return { listProjects, getProject };
}

export function mountPublicProjectsRoutes(
  router: Router,
  routes: ReturnType<typeof createPublicProjectsRoutes>,
): void {
  router.get('/projects', routes.listProjects);
  router.get('/projects/:slug', routes.getProject);
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
