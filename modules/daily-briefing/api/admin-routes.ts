/**
 * Admin CRUD for the daily-briefing module.
 *
 * Mounted under /api/modules/daily-briefing/admin/* (the platform's
 * apiRoutes convention labels routes under /api/modules/<id> as 'jwt'
 * by default, so the upstream JWT middleware runs before any of these
 * handlers).
 *
 *   POST   /api/modules/daily-briefing/admin/items             — create
 *   PATCH  /api/modules/daily-briefing/admin/items/:id         — partial update
 *   DELETE /api/modules/daily-briefing/admin/items/:id         — delete
 *   POST   /api/modules/daily-briefing/admin/items/:id/publish — flip status to 'published'
 *
 * Mass-assignment guard: every write goes through `pickDailyBriefingFields`,
 * which restricts the persisted columns to DAILY_BRIEFING_WRITE_FIELDS.
 * That keeps callers from setting internal columns (`id`, `site_id`,
 * `created_at`, `created_by`, ...) via the JSON body. See
 * gatewaze-production-readiness/references/security-boundaries.md for
 * the canonical pattern.
 */

import type { Request, Response, Router } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_STATUSES = new Set(['draft', 'published', 'archived']);

const DAILY_BRIEFING_WRITE_FIELDS = new Set<string>([
  'title',
  'summary',
  'brief_date',
  'source_label',
  'source_href',
  'status',
  'is_pinned',
]);

export function pickDailyBriefingFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!DAILY_BRIEFING_WRITE_FIELDS.has(k)) continue;
    if (k === 'status' && typeof v === 'string' && !ALLOWED_STATUSES.has(v)) continue;
    if (k === 'is_pinned' && typeof v !== 'boolean') continue;
    out[k] = v;
  }
  return out;
}

interface AdminDailyBriefingRoutesDeps {
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

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createAdminDailyBriefingRoutes(deps: AdminDailyBriefingRoutesDeps) {
  const { supabase, logger } = deps;

  async function createItem(req: Request, res: Response): Promise<void> {
    const siteId =
      paramAs((req.body as Record<string, unknown> | undefined)?.site_id) ??
      paramAs(req.query.site_id);
    if (!siteId || !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id (uuid) required');
      return;
    }
    const fields = pickDailyBriefingFields(req.body);
    if (!fields.title || typeof fields.title !== 'string') {
      sendError(res, 400, 'bad_request', 'title required');
      return;
    }
    if (!fields.summary || typeof fields.summary !== 'string') {
      sendError(res, 400, 'bad_request', 'summary required');
      return;
    }
    if (!fields.brief_date || typeof fields.brief_date !== 'string') {
      sendError(res, 400, 'bad_request', 'brief_date required');
      return;
    }
    if (!fields.source_label || typeof fields.source_label !== 'string') {
      sendError(res, 400, 'bad_request', 'source_label required');
      return;
    }
    if (!fields.source_href || typeof fields.source_href !== 'string') {
      sendError(res, 400, 'bad_request', 'source_href required');
      return;
    }

    const row = { ...fields, site_id: siteId };
    const result = await supabase
      .from('daily_briefing_items')
      .insert(row)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('daily-briefing.admin.create.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    res.status(201).json(result.data);
  }

  async function updateItem(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const fields = pickDailyBriefingFields(req.body);
    if (Object.keys(fields).length === 0) {
      sendError(res, 400, 'bad_request', 'no updatable fields supplied');
      return;
    }
    const result = await supabase
      .from('daily_briefing_items')
      .update(fields)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('daily-briefing.admin.update.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `daily briefing item '${id}' not found`);
      return;
    }
    res.status(200).json(result.data);
  }

  async function deleteItem(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase.from('daily_briefing_items').delete().eq('id', id);
    if (result.error) {
      logger.warn('daily-briefing.admin.delete.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    res.status(204).end();
  }

  async function publishItem(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase
      .from('daily_briefing_items')
      .update({ status: 'published' })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('daily-briefing.admin.publish.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `daily briefing item '${id}' not found`);
      return;
    }
    res.status(200).json(result.data);
  }

  return { createItem, updateItem, deleteItem, publishItem };
}

export function mountAdminDailyBriefingRoutes(
  router: Router,
  routes: ReturnType<typeof createAdminDailyBriefingRoutes>,
): void {
  router.post('/admin/items', routes.createItem);
  router.patch('/admin/items/:id', routes.updateItem);
  router.delete('/admin/items/:id', routes.deleteItem);
  router.post('/admin/items/:id/publish', routes.publishItem);
}
