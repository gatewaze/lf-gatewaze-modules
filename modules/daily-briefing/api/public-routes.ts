/**
 * Public read-only daily-briefing API (day-grouped shape).
 *
 * Mounted on the platform's public router (no JWT required). The AAIF
 * Next.js theme consumes this endpoint to render the home-page Hero
 * sidebar ("Daily Agentic AI LinkedIn Newsletter").
 *
 *   GET /api/daily-briefing
 *     ?site_id=<uuid>   — restrict to one site (optional; first published
 *                          day across all sites otherwise — useful for the
 *                          single-tenant AAIF deploy where the dev DB has
 *                          stub sites)
 *
 * Returns the most-recent published day:
 *
 *   {
 *     "day": {
 *       "id": "...",
 *       "brief_date": "2026-05-14",
 *       "image_storage_path": "daily_briefing_day/.../cover.png" | null,
 *       "image_generated_at": "..." | null
 *     },
 *     "items": [
 *       { "id": "...", "title": "...", "summary": "...",
 *         "source_label": "...", "source_href": "...",
 *         "display_order": 1000 },
 *       ...
 *     ]
 *   }
 *
 * - At most 3 published items are returned (operator chooses ordering via
 *   the admin UI's drag-handles → display_order).
 * - If no published day exists, returns 200 with `{ day: null, items: [] }`
 *   so the theme can render a graceful empty state.
 *
 * Cache-Control / Surrogate-Key / ETag per §5.4 of the cache spec.
 */

import { createHash } from 'node:crypto';

import type { Request, Response, Router } from 'express';

interface ErrorEnvelope {
  error: string;
  message: string;
}

const CACHE_HEADER = 'public, max-age=60, s-maxage=300, stale-if-error=86400';
const PUBLIC_ITEMS_PER_DAY = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY_COLUMNS = [
  'id',
  'site_id',
  'brief_date',
  'image_storage_path',
  'image_generated_at',
].join(', ');

const ITEM_COLUMNS = [
  'id',
  'title',
  'summary',
  'source_label',
  'source_href',
  'display_order',
].join(', ');

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

export function createPublicDailyBriefingRoutes(deps: PublicDailyBriefingRoutesDeps) {
  const { supabase, logger } = deps;

  async function getMostRecentDay(req: Request, res: Response): Promise<void> {
    const siteId = paramAs(req.query.site_id);
    if (siteId && !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id must be a uuid');
      return;
    }

    // 1. Find the most-recent published day.
    let dayQuery = supabase
      .from('daily_briefing_days')
      .select(DAY_COLUMNS)
      .eq('status', 'published')
      .order('brief_date', { ascending: false })
      .limit(1);
    if (siteId) dayQuery = dayQuery.eq('site_id', siteId);

    const dayResult = await dayQuery.maybeSingle();
    if (dayResult.error) {
      logger.warn('daily-briefing.public.day.db_error', {
        error: dayResult.error.message,
      });
      sendError(res, 500, 'internal', String(dayResult.error.message ?? ''));
      return;
    }
    if (!dayResult.data) {
      // No published day yet — return an empty envelope, still cacheable.
      sendCacheable(
        req,
        res,
        { day: null, items: [] },
        ['daily-briefing'],
      );
      return;
    }
    const day = dayResult.data as {
      id: string;
      site_id: string;
      brief_date: string;
      image_storage_path: string | null;
      image_generated_at: string | null;
    };

    // 2. Pull this day's published items, ordered by drag-drop position.
    const itemsResult = await supabase
      .from('daily_briefing_items')
      .select(ITEM_COLUMNS)
      .eq('day_id', day.id)
      .eq('status', 'published')
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(PUBLIC_ITEMS_PER_DAY);

    if (itemsResult.error) {
      logger.warn('daily-briefing.public.items.db_error', {
        error: itemsResult.error.message,
        day_id: day.id,
      });
      sendError(res, 500, 'internal', String(itemsResult.error.message ?? ''));
      return;
    }

    sendCacheable(
      req,
      res,
      {
        day: {
          id: day.id,
          brief_date: day.brief_date,
          image_storage_path: day.image_storage_path,
          image_generated_at: day.image_generated_at,
        },
        items: (itemsResult.data ?? []) as unknown[],
      },
      ['daily-briefing', `daily-briefing:day:${day.brief_date}`],
    );
  }

  return { getMostRecentDay };
}

export function mountPublicDailyBriefingRoutes(
  router: Router,
  routes: ReturnType<typeof createPublicDailyBriefingRoutes>,
): void {
  router.get('/daily-briefing', routes.getMostRecentDay);
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
