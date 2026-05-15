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

// Upper bound on stories fed to the image generator. Below the cap the
// actual count flows through unchanged (1 story → 1 panel, 3 → 3, etc.).
const MAX_STORIES_PER_COVER = 5;

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
  /**
   * Runs one turn of the research autopilot against an LLM + scrapling
   * fetcher. Injected so admin tests can mock it without bringing in
   * the Anthropic SDK / web-tools loop. Returns 503 when undefined.
   */
  runResearch?: (params: {
    briefDate: string;
    history: Array<{
      role: 'user' | 'assistant';
      content: string;
      candidates?: Array<{
        title: string;
        summary: string;
        source_label: string;
        source_href: string;
        why: string;
      }>;
    }>;
    message: string;
    alreadyPublished?: string[];
  }) => Promise<{
    narrative: string;
    candidates: Array<{
      title: string;
      summary: string;
      source_label: string;
      source_href: string;
      why: string;
    }>;
    inputTokens: number;
    outputTokens: number;
  }>;
}

const RESEARCH_HISTORY_RECENT_PUBLISHED_DAYS = 7;
const AUTOPILOT_KICKOFF_MESSAGE =
  'Run the standard daily-agentic research pass. Find the top 5 strongest items inside the 24-hour gate, stack-ranked by editorial strength.';

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

    // Cap stories at MAX_STORIES_PER_COVER so the prompt asks for a
    // bounded number of panels — the prompt's panel-count instruction
    // mirrors items.length, so feeding 20 rows would either bloat the
    // composition or invite Gemini to ignore some. Top-N by drag-drop
    // order matches operator intent.
    const itemsRes = await supabase
      .from('daily_briefing_items')
      .select('title, summary, source_label')
      .eq('day_id', id)
      .order('display_order', { ascending: true })
      .limit(MAX_STORIES_PER_COVER);
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

  // ── Research autopilot ──────────────────────────────────────────────────

  /**
   * Returns the thread for a day with its messages. Creates the thread
   * row lazily on first read so the chat panel can render a stable
   * thread id even before any research has been kicked off.
   */
  async function getResearchThread(req: Request, res: Response): Promise<void> {
    const dayId = paramAs(req.params.id);
    if (!dayId || !UUID_RE.test(dayId)) {
      sendError(res, 400, 'bad_request', 'day id (uuid) required');
      return;
    }
    const thread = await ensureThread(supabase, dayId);
    if ('error' in thread) {
      sendError(res, 500, 'internal', thread.error);
      return;
    }
    const messages = await loadMessages(supabase, thread.value.id);
    if ('error' in messages) {
      sendError(res, 500, 'internal', messages.error);
      return;
    }
    res.status(200).json({ thread: thread.value, messages: messages.value });
  }

  /**
   * Resets a thread by deleting it (cascades to messages). The day row
   * is untouched; the next research call recreates the thread fresh.
   */
  async function deleteResearchThread(req: Request, res: Response): Promise<void> {
    const dayId = paramAs(req.params.id);
    if (!dayId || !UUID_RE.test(dayId)) {
      sendError(res, 400, 'bad_request', 'day id (uuid) required');
      return;
    }
    const result = await supabase
      .from('daily_briefing_research_threads')
      .delete()
      .eq('day_id', dayId);
    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    res.status(204).end();
  }

  /**
   * Sends a message to the autopilot. If `message` is omitted, runs the
   * default kickoff prompt — that's the path the cron-driven autopilot
   * takes on auto-creation. Operator follow-ups always include a
   * non-empty `message`.
   *
   * This handler runs the model synchronously. The Claude loop is
   * capped at TIMEOUT_MS=120s in the runner; the operator UI shows a
   * "researching..." indicator. If we want true async background runs
   * later, wire the call through BullMQ — the schema is already ready
   * (thread.status flips between idle / running / ready / failed).
   */
  async function postResearchMessage(req: Request, res: Response): Promise<void> {
    const dayId = paramAs(req.params.id);
    if (!dayId || !UUID_RE.test(dayId)) {
      sendError(res, 400, 'bad_request', 'day id (uuid) required');
      return;
    }
    if (!deps.runResearch) {
      sendError(
        res,
        503,
        'research_unavailable',
        'ANTHROPIC_API_KEY / SCRAPLING_INTERNAL_TOKEN not configured',
      );
      return;
    }

    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const userMessage = typeof body.message === 'string' ? body.message.trim() : '';
    const isKickoff = userMessage.length === 0;
    const effectiveMessage = userMessage || AUTOPILOT_KICKOFF_MESSAGE;

    // Load the day so we have the brief_date for the runner.
    const dayRes = await supabase
      .from('daily_briefing_days')
      .select('id, site_id, brief_date')
      .eq('id', dayId)
      .maybeSingle();
    if (dayRes.error || !dayRes.data) {
      sendError(res, 404, 'not_found', `day '${dayId}' not found`);
      return;
    }
    const day = dayRes.data as { id: string; site_id: string; brief_date: string };

    const thread = await ensureThread(supabase, dayId);
    if ('error' in thread) {
      sendError(res, 500, 'internal', thread.error);
      return;
    }
    if (thread.value.status === 'running') {
      sendError(
        res,
        409,
        'already_running',
        'research is already in progress for this day',
      );
      return;
    }

    // 1. Persist the operator's user turn (skipped on kickoff so the
    //    chat doesn't show a "kickoff" bubble — only the assistant's
    //    response).
    if (!isKickoff) {
      const userInsert = await supabase
        .from('daily_briefing_research_messages')
        .insert({
          thread_id: thread.value.id,
          role: 'user',
          content: userMessage,
        });
      if (userInsert.error) {
        sendError(res, 500, 'internal', userInsert.error.message);
        return;
      }
    }

    // 2. Flip thread status → running so the UI can render a spinner
    //    even if the call gets interrupted mid-flight.
    await supabase
      .from('daily_briefing_research_threads')
      .update({ status: 'running', last_error: null })
      .eq('id', thread.value.id);

    // 3. Build history + dedup list, then run the model.
    const history = await loadHistoryForRunner(supabase, thread.value.id);
    if ('error' in history) {
      sendError(res, 500, 'internal', history.error);
      return;
    }
    const alreadyPublished = await loadRecentlyPublishedTitles(supabase, day.site_id);

    try {
      const runResult = await deps.runResearch({
        briefDate: day.brief_date,
        history: history.value,
        message: effectiveMessage,
        alreadyPublished,
      });

      // 4. Persist the assistant turn with its candidates sidecar.
      const assistantInsert = await supabase
        .from('daily_briefing_research_messages')
        .insert({
          thread_id: thread.value.id,
          role: 'assistant',
          content: runResult.narrative,
          candidates: runResult.candidates,
        })
        .select('*')
        .maybeSingle();
      if (assistantInsert.error) {
        throw new Error(assistantInsert.error.message);
      }

      // 5. Update token totals + status → ready.
      const inputTokens = (thread.value.input_tokens ?? 0) + runResult.inputTokens;
      const outputTokens = (thread.value.output_tokens ?? 0) + runResult.outputTokens;
      const threadUpd = await supabase
        .from('daily_briefing_research_threads')
        .update({
          status: 'ready',
          last_error: null,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        })
        .eq('id', thread.value.id)
        .select('*')
        .maybeSingle();

      logger.info('daily-briefing.research.turn_complete', {
        thread_id: thread.value.id,
        day_id: dayId,
        candidates: runResult.candidates.length,
        input_tokens: runResult.inputTokens,
        output_tokens: runResult.outputTokens,
      });

      res.status(200).json({
        thread: threadUpd.data ?? thread.value,
        message: assistantInsert.data,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('daily-briefing.research.turn_failed', {
        thread_id: thread.value.id,
        day_id: dayId,
        error: message,
      });
      await supabase
        .from('daily_briefing_research_threads')
        .update({ status: 'failed', last_error: message })
        .eq('id', thread.value.id);
      sendError(res, 502, 'research_failed', message);
    }
  }

  /**
   * Approves a candidate from an assistant message and creates a
   * daily_briefing_items row for it on the day. Body:
   *   { message_id, candidate_index }
   * Returns the created item.
   */
  async function approveResearchCandidate(req: Request, res: Response): Promise<void> {
    const dayId = paramAs(req.params.id);
    if (!dayId || !UUID_RE.test(dayId)) {
      sendError(res, 400, 'bad_request', 'day id (uuid) required');
      return;
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const messageId = typeof body.message_id === 'string' ? body.message_id : '';
    const candidateIndex = typeof body.candidate_index === 'number' ? body.candidate_index : -1;
    if (!UUID_RE.test(messageId) || candidateIndex < 0) {
      sendError(
        res,
        400,
        'bad_request',
        'message_id (uuid) and candidate_index (number) required',
      );
      return;
    }

    const msgRes = await supabase
      .from('daily_briefing_research_messages')
      .select('id, candidates, thread_id')
      .eq('id', messageId)
      .maybeSingle();
    if (msgRes.error || !msgRes.data) {
      sendError(res, 404, 'not_found', 'message not found');
      return;
    }
    const msg = msgRes.data as {
      id: string;
      candidates: unknown;
      thread_id: string;
    };
    const list = Array.isArray(msg.candidates) ? msg.candidates : [];
    const cand = list[candidateIndex] as
      | { title?: unknown; summary?: unknown; source_label?: unknown; source_href?: unknown }
      | undefined;
    if (
      !cand ||
      typeof cand.title !== 'string' ||
      typeof cand.summary !== 'string' ||
      typeof cand.source_label !== 'string' ||
      typeof cand.source_href !== 'string'
    ) {
      sendError(res, 404, 'not_found', 'candidate not found at that index');
      return;
    }

    // Auto-position at the end of the day's existing items.
    const maxRes = await supabase
      .from('daily_briefing_items')
      .select('display_order')
      .eq('day_id', dayId)
      .order('display_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    const max = (maxRes.data as { display_order?: number } | null)?.display_order ?? 0;

    const insertRes = await supabase
      .from('daily_briefing_items')
      .insert({
        day_id: dayId,
        display_order: max + 1000,
        title: cand.title,
        summary: cand.summary,
        source_label: cand.source_label,
        source_href: cand.source_href,
        status: 'draft',
      })
      .select('*')
      .maybeSingle();
    if (insertRes.error) {
      // Surface the unique-violation cleanly so the operator can rename
      // a duplicate without losing the candidate.
      const msg = String(insertRes.error.message ?? '');
      const conflict = msg.includes('daily_briefing_items_day_title_unique');
      sendError(
        res,
        conflict ? 409 : 500,
        conflict ? 'conflict' : 'internal',
        conflict ? 'an item with that title already exists for this day' : msg,
      );
      return;
    }
    res.status(201).json(insertRes.data);
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
    getResearchThread,
    deleteResearchThread,
    postResearchMessage,
    approveResearchCandidate,
  };
}

// ─── Research helpers (module-private) ────────────────────────────────────

type SupabaseClient = AdminDailyBriefingRoutesDeps['supabase'];

async function ensureThread(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient,
  dayId: string,
): Promise<{ value: ThreadRow } | { error: string }> {
  const existing = await supabase
    .from('daily_briefing_research_threads')
    .select('*')
    .eq('day_id', dayId)
    .maybeSingle();
  if (existing.error) return { error: existing.error.message };
  if (existing.data) return { value: existing.data as ThreadRow };
  const created = await supabase
    .from('daily_briefing_research_threads')
    .insert({ day_id: dayId, status: 'idle' })
    .select('*')
    .maybeSingle();
  if (created.error || !created.data) {
    return { error: created.error?.message ?? 'failed to create thread' };
  }
  return { value: created.data as ThreadRow };
}

async function loadMessages(
  supabase: SupabaseClient,
  threadId: string,
): Promise<{ value: MessageRow[] } | { error: string }> {
  const result = await supabase
    .from('daily_briefing_research_messages')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (result.error) return { error: result.error.message };
  return { value: (result.data ?? []) as MessageRow[] };
}

async function loadHistoryForRunner(
  supabase: SupabaseClient,
  threadId: string,
): Promise<
  | {
      value: Array<{
        role: 'user' | 'assistant';
        content: string;
        candidates?: Array<{
          title: string;
          summary: string;
          source_label: string;
          source_href: string;
          why: string;
        }>;
      }>;
    }
  | { error: string }
> {
  const messages = await loadMessages(supabase, threadId);
  if ('error' in messages) return messages;
  const value = messages.value
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      ...(Array.isArray(m.candidates)
        ? {
            candidates: m.candidates as Array<{
              title: string;
              summary: string;
              source_label: string;
              source_href: string;
              why: string;
            }>,
          }
        : {}),
    }));
  return { value };
}

async function loadRecentlyPublishedTitles(
  supabase: SupabaseClient,
  siteId: string,
): Promise<string[]> {
  // Recently-published items from the last N days (the model uses these
  // to avoid duplicating). Bounded by RESEARCH_HISTORY_RECENT_PUBLISHED_DAYS.
  const sinceIso = new Date(
    Date.now() - RESEARCH_HISTORY_RECENT_PUBLISHED_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const days = await supabase
    .from('daily_briefing_days')
    .select('id')
    .eq('site_id', siteId)
    .eq('status', 'published')
    .order('brief_date', { ascending: false });
  const dayIds = ((days.data ?? []) as Array<{ id: string }>).map((d) => d.id);
  if (dayIds.length === 0) return [];
  const items = await supabase
    .from('daily_briefing_items')
    .select('title');
  void sinceIso; // reserved if we want to bound by item created_at later
  return ((items.data ?? []) as Array<{ title: string }>).map((r) => r.title);
}

interface ThreadRow {
  id: string;
  day_id: string;
  status: 'idle' | 'running' | 'ready' | 'failed';
  last_error: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool_summary';
  content: string;
  candidates: unknown;
  created_at: string;
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

  // Research autopilot — thread is keyed by day id, not a separate
  // thread id, so admin URLs stay anchored to the day the operator is
  // looking at.
  router.get('/admin/days/:id/research', routes.getResearchThread);
  router.delete('/admin/days/:id/research', routes.deleteResearchThread);
  router.post('/admin/days/:id/research/messages', routes.postResearchMessage);
  router.post('/admin/days/:id/research/approve', routes.approveResearchCandidate);
}
