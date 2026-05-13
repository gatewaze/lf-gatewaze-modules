/**
 * Admin CRUD for the projects module.
 *
 * Mounted under /api/modules/projects/admin/* (the platform's apiRoutes
 * convention labels routes under /api/modules/<id> as 'jwt' by default,
 * so the upstream JWT middleware runs before any of these handlers).
 *
 *   POST   /api/modules/projects/admin/projects             — create
 *   PATCH  /api/modules/projects/admin/projects/:id         — partial update
 *   DELETE /api/modules/projects/admin/projects/:id         — delete
 *   POST   /api/modules/projects/admin/projects/:id/publish — flip status to 'published'
 *
 * Mass-assignment guard: every write goes through `pickProjectFields`,
 * which restricts the persisted columns to PROJECT_WRITE_FIELDS. That
 * keeps callers from setting internal columns (`id`, `site_id`,
 * `created_at`, `created_by`, ...) via the JSON body. See
 * gatewaze-production-readiness/references/security-boundaries.md for the
 * canonical pattern.
 */

import type { Request, Response, Router } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_STATUSES = new Set(['draft', 'published', 'archived']);

const PROJECT_WRITE_FIELDS = new Set<string>([
  'slug',
  'title',
  'short_description',
  'long_description',
  'logo_url',
  'logo_alt',
  'cover_image_url',
  'website_url',
  'github_url',
  'docs_url',
  'category',
  'tags',
  'status',
  'is_featured',
  'sort_order',
  'maintainer_org',
  'license',
  'founded_at',
]);

export function pickProjectFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!PROJECT_WRITE_FIELDS.has(k)) continue;
    if (k === 'status' && typeof v === 'string' && !ALLOWED_STATUSES.has(v)) continue;
    if (k === 'tags' && !Array.isArray(v)) continue;
    out[k] = v;
  }
  return out;
}

interface AdminProjectsRoutesDeps {
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

export function createAdminProjectsRoutes(deps: AdminProjectsRoutesDeps) {
  const { supabase, logger } = deps;

  async function createProject(req: Request, res: Response): Promise<void> {
    const siteId = paramAs((req.body as Record<string, unknown> | undefined)?.site_id) ??
      paramAs(req.query.site_id);
    if (!siteId || !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id (uuid) required');
      return;
    }
    const fields = pickProjectFields(req.body);
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
      .from('projects')
      .insert(row)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('projects.admin.create.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    res.status(201).json(result.data);
  }

  async function updateProject(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const fields = pickProjectFields(req.body);
    if (Object.keys(fields).length === 0) {
      sendError(res, 400, 'bad_request', 'no updatable fields supplied');
      return;
    }
    const result = await supabase
      .from('projects')
      .update(fields)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('projects.admin.update.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `project '${id}' not found`);
      return;
    }
    res.status(200).json(result.data);
  }

  async function deleteProject(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase.from('projects').delete().eq('id', id);
    if (result.error) {
      logger.warn('projects.admin.delete.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    res.status(204).end();
  }

  async function publishProject(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase
      .from('projects')
      .update({ status: 'published' })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('projects.admin.publish.db_error', { error: result.error.message, id });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `project '${id}' not found`);
      return;
    }
    res.status(200).json(result.data);
  }

  return { createProject, updateProject, deleteProject, publishProject };
}

export function mountAdminProjectsRoutes(
  router: Router,
  routes: ReturnType<typeof createAdminProjectsRoutes>,
): void {
  router.post('/admin/projects', routes.createProject);
  router.patch('/admin/projects/:id', routes.updateProject);
  router.delete('/admin/projects/:id', routes.deleteProject);
  router.post('/admin/projects/:id/publish', routes.publishProject);
}
