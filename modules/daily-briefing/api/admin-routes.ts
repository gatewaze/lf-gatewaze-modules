/**
 * Admin CRUD for the daily-briefing module (day-grouped shape).
 *
 * Mounted under /api/modules/daily-briefing/admin/* (the platform's
 * apiRoutes convention labels /api/modules/<id> as 'jwt' by default).
 *
 *   GET    /admin/days?site_id=<uuid>         — list days (with item count)
 *   POST   /admin/days                        — create day { site_id, brief_date, status? }
 *   PATCH  /admin/days/:id                    — partial update (status, etc.)
 *   DELETE /admin/days/:id                    — delete (cascades items)
 *   POST   /admin/days/:id/generate-image     — Gemini image-gen + host-media upload
 *
 *   POST   /admin/items                       — create item { day_id, ... }
 *   PATCH  /admin/items/:id                   — partial update
 *   DELETE /admin/items/:id                   — delete
 *   POST   /admin/items/:id/publish           — flip status to 'published'
 *   POST   /admin/items/reorder               — bulk PATCH display_order
 *                                               body: { items: [{ id, display_order }] }
 *
 * Mass-assignment guards: every write goes through pickDayFields /
 * pickItemFields which restrict the persisted columns to the explicit
 * allowlists below. See gatewaze-production-readiness/references/
 * security-boundaries.md for the canonical pattern.
 */

import type { Request, Response, Router } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_STATUSES = new Set(['draft', 'published', 'archived']);

const DAY_WRITE_FIELDS = new Set<string>([
  'brief_date',
  'status',
]);

const ITEM_WRITE_FIELDS = new Set<string>([
  'day_id',
  'title',
  'summary',
  'source_label',
  'source_href',
  'status',
  'display_order',
]);

const ITEM_PATCH_FIELDS = new Set<string>([
  'title',
  'summary',
  'source_label',
  'source_href',
  'status',
  'display_order',
]);

export function pickDayFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!DAY_WRITE_FIELDS.has(k)) continue;
    if (k === 'status' && typeof v === 'string' && !ALLOWED_STATUSES.has(v)) continue;
    if (k === 'brief_date' && typeof v === 'string' && !ISO_DATE_RE.test(v)) continue;
    out[k] = v;
  }
  return out;
}

export function pickItemCreateFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!ITEM_WRITE_FIELDS.has(k)) continue;
    if (k === 'status' && typeof v === 'string' && !ALLOWED_STATUSES.has(v)) continue;
    if (k === 'display_order' && typeof v !== 'number') continue;
    out[k] = v;
  }
  return out;
}

export function pickItemPatchFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!ITEM_PATCH_FIELDS.has(k)) continue;
    if (k === 'status' && typeof v === 'string' && !ALLOWED_STATUSES.has(v)) continue;
    if (k === 'display_order' && typeof v !== 'number') continue;
    out[k] = v;
  }
  return out;
}

export interface AdminDailyBriefingRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * Generates a cartoon-style image for a day's stories and uploads it
   * via the host-media adapter. Injected so the route stays testable
   * and so we don't pull Gemini + supabase-storage into route-level
   * imports.
   */
  generateDayImage?: (params: {
    dayId: string;
    siteId: string;
    briefDate: string;
    stories: Array<{ title: string; summary: string; source_label: string }>;
  }) => Promise<{ storage_path: string; prompt: string }>;
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
  const { supabase, logger, generateDayImage } = deps;

  // ── Days ─────────────────────────────────────────────────────────────────

  async function listDays(req: Request, res: Response): Promise<void> {
    const siteId = paramAs(req.query.site_id);
    if (siteId && !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id must be a uuid');
      return;
    }

    let query = supabase
      .from('daily_briefing_days')
      .select('*')
      .order('brief_date', { ascending: false });
    if (siteId) query = query.eq('site_id', siteId);

    const result = await query;
    if (result.error) {
      logger.warn('daily-briefing.admin.days.list.db_error', { error: result.error.message });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }

    // Annotate each day with an item count to drive the admin UI's
    // section header ("3 items"). Done as a separate aggregate query
    // rather than RPC because supabase-js doesn't expose count() per
    // group without an RPC and the dataset is small.
    const days = (result.data ?? []) as Array<{ id: string } & Record<string, unknown>>;
    if (days.length === 0) {
      res.status(200).json({ days: [] });
      return;
    }
    const dayIds = days.map((d) => d.id);
    const counts = await supabase
      .from('daily_briefing_items')
      .select('id, day_id, status');
    const byDay = new Map<string, { total: number; published: number }>();
    for (const id of dayIds) byDay.set(id, { total: 0, published: 0 });
    for (const row of (counts.data ?? []) as Array<{ day_id: string; status: string }>) {
      const c = byDay.get(row.day_id);
      if (!c) continue;
      c.total += 1;
      if (row.status === 'published') c.published += 1;
    }
    const annotated = days.map((d) => ({
      ...d,
      item_count: byDay.get(d.id)?.total ?? 0,
      published_item_count: byDay.get(d.id)?.published ?? 0,
    }));
    res.status(200).json({ days: annotated });
  }

  async function createDay(req: Request, res: Response): Promise<void> {
    const siteId = paramAs((req.body as Record<string, unknown> | undefined)?.site_id);
    if (!siteId || !UUID_RE.test(siteId)) {
      sendError(res, 400, 'bad_request', 'site_id (uuid) required');
      return;
    }
    const fields = pickDayFields(req.body);
    if (!fields.brief_date || typeof fields.brief_date !== 'string') {
      sendError(res, 400, 'bad_request', 'brief_date (YYYY-MM-DD) required');
      return;
    }
    const row = { ...fields, site_id: siteId };
    const result = await supabase
      .from('daily_briefing_days')
      .insert(row)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('daily-briefing.admin.days.create.db_error', {
        error: result.error.message,
      });
      // Surface unique-violation as 409 so the admin UI can render a
      // useful "that day already exists" message.
      const msg = String(result.error.message ?? '');
      const conflict = msg.includes('daily_briefing_days_site_date_unique');
      sendError(
        res,
        conflict ? 409 : 500,
        conflict ? 'conflict' : 'internal',
        conflict ? 'A day with that date already exists for this site' : msg,
      );
      return;
    }
    res.status(201).json(result.data);
  }

  async function patchDay(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const fields = pickDayFields(req.body);
    if (Object.keys(fields).length === 0) {
      sendError(res, 400, 'bad_request', 'no updatable fields supplied');
      return;
    }
    const result = await supabase
      .from('daily_briefing_days')
      .update(fields)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('daily-briefing.admin.days.patch.db_error', {
        error: result.error.message,
        id,
      });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `day '${id}' not found`);
      return;
    }
    res.status(200).json(result.data);
  }

  async function deleteDay(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const result = await supabase.from('daily_briefing_days').delete().eq('id', id);
    if (result.error) {
      logger.warn('daily-briefing.admin.days.delete.db_error', {
        error: result.error.message,
        id,
      });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    res.status(204).end();
  }

  async function generateImage(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    if (!generateDayImage) {
      sendError(
        res,
        503,
        'image_gen_unavailable',
        'GEMINI_API_KEY is not configured on this Gatewaze instance',
      );
      return;
    }

    // Load the day + its items so the generator has the story text.
    const dayRes = await supabase
      .from('daily_briefing_days')
      .select('id, site_id, brief_date, image_status')
      .eq('id', id)
      .maybeSingle();
    if (dayRes.error || !dayRes.data) {
      sendError(res, 404, 'not_found', `day '${id}' not found`);
      return;
    }
    const day = dayRes.data as {
      id: string;
      site_id: string;
      brief_date: string;
      image_status: string;
    };
    if (day.image_status === 'generating') {
      sendError(
        res,
        409,
        'already_generating',
        'image generation is already in progress for this day',
      );
      return;
    }

    const itemsRes = await supabase
      .from('daily_briefing_items')
      .select('title, summary, source_label')
      .eq('day_id', id)
      .order('display_order', { ascending: true });
    const items = (itemsRes.data ?? []) as Array<{
      title: string;
      summary: string;
      source_label: string;
    }>;
    if (items.length === 0) {
      sendError(
        res,
        400,
        'no_stories',
        'add at least one story to this day before generating the cover image',
      );
      return;
    }

    // Mark generating so concurrent requests + the admin UI can show
    // a spinner without polling.
    await supabase
      .from('daily_briefing_days')
      .update({ image_status: 'generating', image_error: null })
      .eq('id', id);

    try {
      const result = await generateDayImage({
        dayId: day.id,
        siteId: day.site_id,
        briefDate: day.brief_date,
        stories: items,
      });
      const updateRes = await supabase
        .from('daily_briefing_days')
        .update({
          image_storage_path: result.storage_path,
          // image_cdn_url intentionally not set: storage path is the
          // source of truth; consumers resolve to a full URL at read
          // time via toPublicUrl. The column is kept for legacy reads
          // and may be dropped in a later migration.
          image_cdn_url: null,
          image_prompt: result.prompt,
          image_generated_at: new Date().toISOString(),
          image_status: 'ready',
          image_error: null,
        })
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (updateRes.error || !updateRes.data) {
        throw new Error(
          updateRes.error?.message ?? 'failed to persist generated image',
        );
      }
      logger.info('daily-briefing.admin.image.generated', {
        day_id: id,
        brief_date: day.brief_date,
        storage_path: result.storage_path,
      });
      res.status(200).json(updateRes.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('daily-briefing.admin.image.failed', { day_id: id, error: message });
      await supabase
        .from('daily_briefing_days')
        .update({ image_status: 'failed', image_error: message })
        .eq('id', id);
      sendError(res, 502, 'image_gen_failed', message);
    }
  }

  // ── Items ────────────────────────────────────────────────────────────────

  async function createItem(req: Request, res: Response): Promise<void> {
    const fields = pickItemCreateFields(req.body);
    const dayId = fields.day_id;
    if (typeof dayId !== 'string' || !UUID_RE.test(dayId)) {
      sendError(res, 400, 'bad_request', 'day_id (uuid) required');
      return;
    }
    if (!fields.title || typeof fields.title !== 'string') {
      sendError(res, 400, 'bad_request', 'title required');
      return;
    }
    if (!fields.summary || typeof fields.summary !== 'string') {
      sendError(res, 400, 'bad_request', 'summary required');
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

    // Auto-position at the end of the day's existing items if the caller
    // didn't specify display_order — keeps "create" insertions visually
    // appended without making the admin UI compute it.
    if (typeof fields.display_order !== 'number') {
      const maxRes = await supabase
        .from('daily_briefing_items')
        .select('display_order')
        .eq('day_id', dayId)
        .order('display_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      const max = (maxRes.data as { display_order?: number } | null)?.display_order ?? 0;
      fields.display_order = max + 1000;
    }

    const result = await supabase
      .from('daily_briefing_items')
      .insert(fields)
      .select('*')
      .maybeSingle();
    if (result.error) {
      logger.warn('daily-briefing.admin.items.create.db_error', {
        error: result.error.message,
      });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    res.status(201).json(result.data);
  }

  async function patchItem(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    const fields = pickItemPatchFields(req.body);
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
      logger.warn('daily-briefing.admin.items.patch.db_error', {
        error: result.error.message,
        id,
      });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `item '${id}' not found`);
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
      logger.warn('daily-briefing.admin.items.delete.db_error', {
        error: result.error.message,
        id,
      });
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
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    if (!result.data) {
      sendError(res, 404, 'not_found', `item '${id}' not found`);
      return;
    }
    res.status(200).json(result.data);
  }

  async function reorderItems(req: Request, res: Response): Promise<void> {
    const body = req.body as { items?: Array<{ id?: unknown; display_order?: unknown }> };
    const rows = Array.isArray(body?.items) ? body.items : [];
    if (rows.length === 0) {
      sendError(res, 400, 'bad_request', 'items array required');
      return;
    }
    const sanitised: Array<{ id: string; display_order: number }> = [];
    for (const r of rows) {
      const id = typeof r.id === 'string' && UUID_RE.test(r.id) ? r.id : null;
      const order = typeof r.display_order === 'number' ? r.display_order : null;
      if (!id || order === null) {
        sendError(res, 400, 'bad_request', 'each item needs { id (uuid), display_order (number) }');
        return;
      }
      sanitised.push({ id, display_order: order });
    }
    // Patch one row at a time. The dataset is tiny (≤ ~10 items per day);
    // a single multi-row update via Postgres CASE would be marginally
    // faster but loses per-row error attribution.
    for (const r of sanitised) {
      const result = await supabase
        .from('daily_briefing_items')
        .update({ display_order: r.display_order })
        .eq('id', r.id);
      if (result.error) {
        sendError(
          res,
          500,
          'internal',
          `failed to reorder item ${r.id}: ${result.error.message}`,
        );
        return;
      }
    }
    res.status(200).json({ reordered: sanitised.length });
  }

  return {
    listDays,
    createDay,
    patchDay,
    deleteDay,
    generateImage,
    createItem,
    patchItem,
    deleteItem,
    publishItem,
    reorderItems,
  };
}

export function mountAdminDailyBriefingRoutes(
  router: Router,
  routes: ReturnType<typeof createAdminDailyBriefingRoutes>,
): void {
  router.get('/admin/days', routes.listDays);
  router.post('/admin/days', routes.createDay);
  router.patch('/admin/days/:id', routes.patchDay);
  router.delete('/admin/days/:id', routes.deleteDay);
  router.post('/admin/days/:id/generate-image', routes.generateImage);

  router.post('/admin/items', routes.createItem);
  router.patch('/admin/items/:id', routes.patchItem);
  router.delete('/admin/items/:id', routes.deleteItem);
  router.post('/admin/items/:id/publish', routes.publishItem);
  router.post('/admin/items/reorder', routes.reorderItems);
}
