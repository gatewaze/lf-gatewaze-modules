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

// Number of recently-published days to scan for dedup titles when
// invoking the autopilot. Higher = less repetition of past stories,
// at the cost of a longer prompt.
const RESEARCH_HISTORY_RECENT_PUBLISHED_DAYS = 7;

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

    // Hydrate per-day research-thread status so the day-section toggle
    // button can render "Researching" without opening the chat panel.
    // A separate query (not a join) keeps the supabase-js surface narrow.
    const threads = await supabase
      .from('daily_briefing_research_threads')
      .select('day_id, status, last_error');
    const threadByDay = new Map<
      string,
      { status: string; last_error: string | null }
    >();
    for (const row of (threads.data ?? []) as Array<{
      day_id: string;
      status: string;
      last_error: string | null;
    }>) {
      threadByDay.set(row.day_id, { status: row.status, last_error: row.last_error });
    }

    const annotated = days.map((d) => ({
      ...d,
      item_count: byDay.get(d.id)?.total ?? 0,
      published_item_count: byDay.get(d.id)?.published ?? 0,
      research_status: threadByDay.get(d.id)?.status ?? null,
      research_error: threadByDay.get(d.id)?.last_error ?? null,
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
    const newDay = result.data as { id: string; site_id: string; brief_date: string };
    // Fire-and-forget the research autopilot on freshly-created days
    // (when wired). The HTTP response returns immediately; the chat
    // panel polls the thread status until it flips from running →
    // ready so the operator sees the candidates without refreshing.
    if (deps.runResearch) {
      void kickoffAutopilotForNewDay({
        supabase,
        logger,
        runResearch: deps.runResearch,
        day: newDay,
      });
    }
    res.status(201).json(newDay);
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

    // Tear down children explicitly even though FK ON DELETE CASCADE
    // would handle it. Two reasons:
    //   1) Survives a future schema change that loses a CASCADE.
    //   2) Per-table error logging makes "delete failed" diagnosable
    //      from logs alone (which child blocked? RLS? FK from a table
    //      we don't know about?).
    // Each step is best-effort: a child-table delete error is logged
    // but does not abort the whole flow, because the FK cascade will
    // catch it on the final day delete anyway.
    type DelResult = { error: { message?: string } | null };
    const childDel = async (table: string, column: string): Promise<void> => {
      const r = (await supabase.from(table).delete().eq(column, id)) as DelResult;
      if (r.error) {
        logger.warn('daily-briefing.admin.days.delete.child_error', {
          id,
          table,
          column,
          error: r.error.message,
        });
      }
    };

    // research_messages → research_threads → items → day
    // (research_messages.thread_id FK + cascade make it a no-op when
    // threads are gone, but listing it makes intent explicit.)
    const threadsRes = (await supabase
      .from('daily_briefing_research_threads')
      .select('id')
      .eq('day_id', id)) as { data: Array<{ id: string }> | null; error: { message?: string } | null };
    if (threadsRes.error) {
      logger.warn('daily-briefing.admin.days.delete.threads_lookup_error', {
        id,
        error: threadsRes.error.message,
      });
    }
    const threadIds = (threadsRes.data ?? []).map((t) => t.id);
    if (threadIds.length > 0) {
      const r = (await supabase
        .from('daily_briefing_research_messages')
        .delete()
        .in('thread_id', threadIds)) as DelResult;
      if (r.error) {
        logger.warn('daily-briefing.admin.days.delete.child_error', {
          id,
          table: 'daily_briefing_research_messages',
          column: 'thread_id',
          error: r.error.message,
        });
      }
    }
    await childDel('daily_briefing_research_threads', 'day_id');
    await childDel('daily_briefing_items', 'day_id');

    const result = (await supabase
      .from('daily_briefing_days')
      .delete()
      .eq('id', id)) as DelResult;
    if (result.error) {
      logger.warn('daily-briefing.admin.days.delete.db_error', {
        error: result.error.message,
        id,
      });
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    logger.info('daily-briefing.admin.days.deleted', { id });
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

    // Only PUBLISHED items feed the image — the cover should reflect
    // what readers actually see on the front page, not editorial drafts
    // mid-write. Cap at MAX_STORIES_PER_COVER so the prompt's panel-
    // count instruction stays bounded. Top-N by drag-drop order matches
    // operator intent.
    const itemsRes = await supabase
      .from('daily_briefing_items')
      .select('title, summary, source_label')
      .eq('day_id', id)
      .eq('status', 'published')
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

  // The chat lifecycle (thread CRUD + message POST) now lives in
  // @gatewaze-modules/ai. The frontend AiChatWidget talks to
  // /api/modules/ai/admin/threads/* directly. Daily-briefing only owns
  // the candidate-approval flow + the autopilot kickoff (called on
  // day creation + by the weekday cron).

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

    // After follow-up #2: the conversation lives in @gatewaze-modules/
    // ai's ai_messages. The candidates JSON is the `structured` sidecar
    // (the model's submit_candidates tool input, persisted verbatim).
    const msgRes = await supabase
      .from('ai_messages')
      .select('id, structured, thread_id')
      .eq('id', messageId)
      .maybeSingle();
    if (msgRes.error || !msgRes.data) {
      sendError(res, 404, 'not_found', 'message not found');
      return;
    }
    const msg = msgRes.data as {
      id: string;
      structured: { candidates?: unknown } | null;
      thread_id: string;
    };
    const list = Array.isArray(msg.structured?.candidates) ? msg.structured!.candidates : [];
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
    approveResearchCandidate,
  };
}

// ─── Research helpers (module-private) ────────────────────────────────────

/**
 * Fire-and-forget research kickoff on day creation. Mirrors what the
 * weekday-autopilot cron does for auto-created days but runs in the
 * background after a manual create — so the operator's "New day"
 * action populates the chat panel without an explicit "Run autopilot"
 * click.
 *
 * Failures are logged but never surface to the client (the day was
 * already created successfully). The thread row carries the failure
 * state via status='failed' + last_error so the UI can show a retry
 * affordance.
 */
/**
 * Fire the autopilot for a newly-created day. Persists into the ai
 * module's `ai_threads` / `ai_messages` (keyed by use_case=
 * 'daily-briefing-research', host_kind='daily_briefing_day',
 * host_id=day.id) so the AiChatWidget renders the result without any
 * extra wiring.
 */
async function kickoffAutopilotForNewDay(args: {
  supabase: SupabaseClient;
  logger: AdminDailyBriefingRoutesDeps['logger'];
  runResearch: NonNullable<AdminDailyBriefingRoutesDeps['runResearch']>;
  day: { id: string; site_id: string; brief_date: string };
}): Promise<void> {
  const { supabase, logger, runResearch, day } = args;
  try {
    // 1. Ensure the ai_threads row exists. The unique constraint is
    //    (use_case, host_kind, host_id, thread_key) — use thread_key=''
    //    for the singular per-day thread.
    const threadRow = await ensureAiThread(supabase, day.id);
    if ('error' in threadRow) {
      logger.warn('daily-briefing.research.kickoff.thread_create_failed', {
        day_id: day.id,
        error: threadRow.error,
      });
      return;
    }
    if (threadRow.value.status === 'running') {
      // Another caller is mid-flight; bail.
      return;
    }

    // 2. Insert an assistant placeholder. Operator-facing UI polls
    //    ai_messages.status; the placeholder lets the spinner appear
    //    instantly.
    const placeholder = await supabase
      .from('ai_messages')
      .insert({
        thread_id: threadRow.value.id,
        role: 'assistant',
        status: 'running',
        content: '',
      })
      .select('id')
      .maybeSingle();
    if (placeholder.error || !placeholder.data) {
      throw new Error(`placeholder insert: ${placeholder.error?.message ?? 'no row'}`);
    }
    const messageId = (placeholder.data as { id: string }).id;
    await supabase
      .from('ai_threads')
      .update({ status: 'running', last_error: null })
      .eq('id', threadRow.value.id);

    // 3. Build the dedup list (titles from items in recently-published days).
    const recentDays = await supabase
      .from('daily_briefing_days')
      .select('id')
      .eq('site_id', day.site_id)
      .eq('status', 'published')
      .order('brief_date', { ascending: false })
      .limit(7);
    const dayIds = ((recentDays.data ?? []) as Array<{ id: string }>).map((d) => d.id);
    let alreadyPublished: string[] = [];
    if (dayIds.length > 0) {
      const items = await supabase.from('daily_briefing_items').select('title');
      alreadyPublished = ((items.data ?? []) as Array<{ title: string }>).map((r) => r.title);
    }

    // 4. Run the research turn (bridged through @gatewaze-modules/ai's
    //    runChat — cost ledger + retries + daily cap are enforced
    //    there). Pass the message ID so the usage_event row links back.
    const result = await runResearch({
      briefDate: day.brief_date,
      history: [],
      message: '',
      alreadyPublished,
      threadId: threadRow.value.id,
      messageId,
    });

    // 5. Update the placeholder with the assistant's narrative +
    //    structured candidates sidecar.
    await supabase
      .from('ai_messages')
      .update({
        status: 'complete',
        content: result.narrative,
        structured: { narrative: result.narrative, candidates: result.candidates },
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_micro_usd: result.costMicroUsd,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      })
      .eq('id', messageId);
    await supabase
      .from('ai_threads')
      .update({
        status: 'ready',
        last_error: null,
        input_tokens: (threadRow.value.input_tokens ?? 0) + result.inputTokens,
        output_tokens: (threadRow.value.output_tokens ?? 0) + result.outputTokens,
        cost_micro_usd: (threadRow.value.cost_micro_usd ?? 0) + result.costMicroUsd,
      })
      .eq('id', threadRow.value.id);

    logger.info('daily-briefing.research.kickoff.complete', {
      day_id: day.id,
      candidates: result.candidates.length,
      cost_micro_usd: result.costMicroUsd,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('daily-briefing.research.kickoff.failed', {
      day_id: day.id,
      error: message,
    });
    // Mark the thread failed (best-effort; ignore secondary failures).
    await supabase
      .from('ai_threads')
      .update({ status: 'failed', last_error: message })
      .eq('use_case', 'daily-briefing-research')
      .eq('host_kind', 'daily_briefing_day')
      .eq('host_id', day.id)
      .then(() => undefined, () => undefined);
  }
}

/**
 * Ensure an ai_threads row exists for a daily-briefing day. Idempotent;
 * tolerates a concurrent insert losing the unique-constraint race by
 * re-SELECTing the winning row.
 */
async function ensureAiThread(
  supabase: SupabaseClient,
  dayId: string,
): Promise<{ value: { id: string; status: string; input_tokens: number; output_tokens: number; cost_micro_usd: number } } | { error: string }> {
  const select = await supabase
    .from('ai_threads')
    .select('id, status, input_tokens, output_tokens, cost_micro_usd')
    .eq('use_case', 'daily-briefing-research')
    .eq('host_kind', 'daily_briefing_day')
    .eq('host_id', dayId)
    .eq('thread_key', '')
    .maybeSingle();
  if (select.error) return { error: select.error.message };
  if (select.data) return { value: select.data };

  const created = await supabase
    .from('ai_threads')
    .insert({
      use_case: 'daily-briefing-research',
      host_kind: 'daily_briefing_day',
      host_id: dayId,
      thread_key: '',
      status: 'idle',
    })
    .select('id, status, input_tokens, output_tokens, cost_micro_usd')
    .maybeSingle();
  if (created.error && /ai_threads_addressable_unique/.test(created.error.message)) {
    // Lost the race; re-SELECT the winning row.
    const refetch = await supabase
      .from('ai_threads')
      .select('id, status, input_tokens, output_tokens, cost_micro_usd')
      .eq('use_case', 'daily-briefing-research')
      .eq('host_kind', 'daily_briefing_day')
      .eq('host_id', dayId)
      .eq('thread_key', '')
      .maybeSingle();
    if (refetch.data) return { value: refetch.data };
    return { error: refetch.error?.message ?? 'lost race + row not found' };
  }
  if (created.error || !created.data) {
    return { error: created.error?.message ?? 'no row returned' };
  }
  return { value: created.data };
}


type SupabaseClient = AdminDailyBriefingRoutesDeps['supabase'];

/**
 * Look up the thread for a day, creating it on first read. Tolerant
 * of a concurrent insert losing the unique-constraint race — when the
 * client mounts twice (React strict-mode dev double-effect, two
 * browser tabs, etc.) both GETs hit ensureThread with empty `select`
 * results; one INSERT wins, the other hits
 * `daily_briefing_research_threads_day_unique` and we re-SELECT to
 * return the row the winner just created.
 */
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

  // Research autopilot — thread/message CRUD lives in
  // @gatewaze-modules/ai's /api/modules/ai/admin/threads/* now.
  // Daily-briefing only owns the candidate-approval flow (creates a
  // daily_briefing_items row from a structured candidate the model
  // surfaced).
  router.post('/admin/days/:id/research/approve', routes.approveResearchCandidate);
}
