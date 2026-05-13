/**
 * Public read-only daily-briefing API.
 *
 * Mounted on the platform's public router (no JWT required). The AAIF
 * Next.js theme consumes these endpoints to render the home-page Hero
 * sidebar ("Daily Agentic AI LinkedIn Newsletter") from Gatewaze's
 * `daily_briefing_items` table.
 *
 *   GET /api/daily-briefing                  — list published items
 *     ?limit=N (default 20, max 100)
 *     ?offset=N
 *     ?pinned=true                            — only is_pinned rows
 *     ?search=<text>                          — ilike on title + summary
 *     ?site_id=<uuid>                         — restrict to one site (optional)
 *   GET /api/daily-briefing/:id               — single item by id
 *
 * All endpoints:
 *   - filter to status='published'
 *   - Cache-Control: public, max-age=60, s-maxage=300
 *   - no auth required
 *
 * Sort order: is_pinned DESC, brief_date DESC, created_at DESC.
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
  'title',
  'summary',
  'brief_date',
  'source_label',
  'source_href',
  'is_pinned',
].join(', ');

// Detail endpoint returns the same shape (no extra fields for v1).
const DETAIL_COLUMNS = LIST_COLUMNS;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicDailyBriefingRoutesDeps {
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

export function createPublicDailyBriefingRoutes(deps: PublicDailyBriefingRoutesDeps) {
  const { supabase, logger } = deps;

  async function listItems(req: Request, res: Response): Promise<void> {
    const limit = clampLimit(paramAs(req.query.limit));
    const offset = clampOffset(paramAs(req.query.offset));
    const search = paramAs(req.query.search);
    const pinned = paramAs(req.query.pinned) === 'true';
    const siteId = paramAs(req.query.site_id);

    let query = supabase
      .from('daily_briefing_items')
      .select(LIST_COLUMNS)
      .eq('status', 'published')
      .order('is_pinned', { ascending: false })
      .order('brief_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (siteId) {
      if (!UUID_RE.test(siteId)) {
        sendError(res, 400, 'bad_request', 'site_id must be a uuid');
        return;
      }
      query = query.eq('site_id', siteId);
    }

    if (pinned) query = query.eq('is_pinned', true);

    if (search) {
      // ilike on title + summary. PostgREST `.or()` is a known injection
      // vector — strip filter metacharacters and cap length before
      // interpolation. (Same pattern as press / projects public-routes.)
      const safe = String(search).replace(/[,()*\\]/g, '').slice(0, 100);
      if (safe.length > 0) {
        query = query.or(`title.ilike.%${safe}%,summary.ilike.%${safe}%`);
      }
    }

    query = query.range(offset, offset + limit - 1);

    const result = await query;
    if (result.error) {
      logger.warn('daily-briefing.public.list.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }

    sendCacheable(
      req,
      res,
      {
        items: (result.data ?? []) as unknown[],
        limit,
        offset,
      },
      ['daily-briefing'],
    );
  }

  async function getItem(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id) {
      sendError(res, 400, 'missing_id', 'id required');
      return;
    }
    if (!UUID_RE.test(id)) {
      sendError(res, 404, 'not_found', `daily briefing item '${id}' not found`);
      return;
    }

    const siteId = paramAs(req.query.site_id);
    if (siteId && !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id must be a uuid');
      return;
    }

    let query = supabase
      .from('daily_briefing_items')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .eq('status', 'published');
    if (siteId) query = query.eq('site_id', siteId);

    const result = await query.maybeSingle();
    if (result.error) {
      logger.warn('daily-briefing.public.detail.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `daily briefing item '${id}' not found`);
      return;
    }

    sendCacheable(req, res, result.data, ['daily-briefing', `daily-briefing:${id}`]);
  }

  return { listItems, getItem };
}

export function mountPublicDailyBriefingRoutes(
  router: Router,
  routes: ReturnType<typeof createPublicDailyBriefingRoutes>,
): void {
  router.get('/daily-briefing', routes.listItems);
  router.get('/daily-briefing/:id', routes.getItem);
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
