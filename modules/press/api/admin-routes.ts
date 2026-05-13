/**
 * Admin CRUD for the press module.
 *
 * Mounted under /api/modules/press/admin/* (the platform's apiRoutes
 * convention labels routes under /api/modules/<id> as 'jwt' by default,
 * so the upstream JWT middleware runs before any of these handlers).
 *
 *   POST   /api/modules/press/admin/press             — create
 *   PATCH  /api/modules/press/admin/press/:id         — partial update
 *   DELETE /api/modules/press/admin/press/:id         — delete
 *   POST   /api/modules/press/admin/press/:id/publish — flip status to 'published'
 *
 * Mass-assignment guard: every write goes through `pickPressFields`,
 * which restricts the persisted columns to PRESS_WRITE_FIELDS. That
 * keeps callers from setting internal columns (`id`, `site_id`,
 * `created_at`, `created_by`, ...) via the JSON body. See
 * gatewaze-production-readiness/references/security-boundaries.md for
 * the canonical pattern.
 */

import type { Request, Response, Router } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_STATUSES = new Set(['draft', 'published', 'archived']);
const ALLOWED_KINDS = new Set(['release', 'coverage', 'announcement']);

const PRESS_WRITE_FIELDS = new Set<string>([
  'slug',
  'title',
  'summary',
  'body',
  'kind',
  'publisher_name',
  'publisher_logo_url',
  'external_url',
  'featured_image_url',
  'featured_image_alt',
  'tags',
  'status',
  'is_featured',
  'published_at',
]);

export function pickPressFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!PRESS_WRITE_FIELDS.has(k)) continue;
    if (k === 'status' && typeof v === 'string' && !ALLOWED_STATUSES.has(v)) continue;
    if (k === 'kind' && typeof v === 'string' && !ALLOWED_KINDS.has(v)) continue;
    if (k === 'tags' && !Array.isArray(v)) continue;
    out[k] = v;
  }
  return out;
}

interface AdminPressRoutesDeps {
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

export function createAdminPressRoutes(deps: AdminPressRoutesDeps) {
  const { supabase, logger } = deps;

  async function createRelease(req: Request, res: Response): Promise<void> {
    const siteId =
      paramAs((req.body as Record<string, unknown> | undefined)?.site_id) ??
      paramAs(req.query.site_id);
    if (!siteId || !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id (uuid) required');
      return;
    }
    const fields = pickPressFields(req.body);
    if (!fields.title || typeof fields.title !== 'string') {
      sendError(res, 400, 'bad_request', 'title required');
      return;
    }
    if (!fields.slug || typeof fields.slug !== 'string') {
      sendError(res, 400, 'bad_request', 'slug required');
      return;
    }

    const row = { ...fields, site_id: siteId };
    const result = await supabase
      .from('press_releases')
      .insert(row)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('press.admin.create.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    res.status(201).json(result.data);
  }

  async function updateRelease(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const fields = pickPressFields(req.body);
    if (Object.keys(fields).length === 0) {
      sendError(res, 400, 'bad_request', 'no updatable fields supplied');
      return;
    }
    const result = await supabase
      .from('press_releases')
      .update(fields)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('press.admin.update.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `press release '${id}' not found`);
      return;
    }
    res.status(200).json(result.data);
  }

  async function deleteRelease(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase.from('press_releases').delete().eq('id', id);
    if (result.error) {
      logger.warn('press.admin.delete.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    res.status(204).end();
  }

  async function publishRelease(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase
      .from('press_releases')
      .update({ status: 'published' })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('press.admin.publish.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `press release '${id}' not found`);
      return;
    }
    res.status(200).json(result.data);
  }

  return { createRelease, updateRelease, deleteRelease, publishRelease };
}

export function mountAdminPressRoutes(
  router: Router,
  routes: ReturnType<typeof createAdminPressRoutes>,
): void {
  router.post('/admin/press', routes.createRelease);
  router.patch('/admin/press/:id', routes.updateRelease);
  router.delete('/admin/press/:id', routes.deleteRelease);
  router.post('/admin/press/:id/publish', routes.publishRelease);
}
