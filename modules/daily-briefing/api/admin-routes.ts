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

// Lookback window for the autopilot dedup list. Sites that have been
// running for months accumulate hundreds of stories; passing them all
// to the model blows the prompt budget for diminishing returns (an
// article from a week+ ago is unlikely to come up again as "today's
// news"). 7 days catches repeats from the same news cycle without
// bloating context. Override via env var if a site has a longer
// editorial memory.
const AUTOPILOT_DEDUP_LOOKBACK_DAYS = Number(
  process.env.DAILY_BRIEFING_DEDUP_LOOKBACK_DAYS ?? 7,
);

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
  'why',
  'status',
  'display_order',
]);

const ITEM_PATCH_FIELDS = new Set<string>([
  'title',
  'summary',
  'source_label',
  'source_href',
  'why',
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
   * BullMQ enqueue, provided by the platform's ModuleRuntimeContext.
   * Required — the research-kickoff route enqueues a
   * `daily-briefing:run-research` job per model so it shows up in
   * /admin/ai/jobs. The handler returns 503 when this isn't wired.
   */
  enqueueJob?: (
    queue: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ id: string | undefined }>;
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
    stories: Array<{
      title: string;
      summary: string;
      source_label: string;
      /**
       * Editorial reasoning from the research autopilot — when present,
       * the cover-image prompt uses it to stage each panel against the
       * story's significance rather than just the headline text.
       */
      why?: string | null;
    }>;
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
    // No auto-kickoff. The autopilot only runs when the operator
    // explicitly clicks "Run research" — POST /admin/days/:id/research/run.
    // Rationale: many days are populated manually (operator already has
    // the stories in hand), and autopilot calls burn AI credit. Making
    // the trigger explicit keeps spend predictable.
    res.status(201).json(newDay);
  }

  /**
   * Manual autopilot trigger. Fans out one kickoff per model the caller
   * supplies in the request body — typically every model tab the
   * operator has open in the chat widget — so each model writes its
   * candidate output into its own thread (keyed by `thread_key=<modelId>`)
   * and the operator can compare side-by-side.
   *
   * Body shape: { models: string[] }. If absent or empty, falls back to
   * the use case's allowed_models, so a cron-style call without an
   * explicit list still runs against every model the use case permits.
   */
  async function runResearchKickoff(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id || !UUID_RE.test(id)) {
      sendError(res, 400, 'bad_request', 'id (uuid) required');
      return;
    }
    if (!deps.enqueueJob) {
      sendError(res, 503, 'enqueue_unavailable', 'research kickoff requires the platform job queue (enqueueJob not wired)');
      return;
    }
    const dayRes = await supabase
      .from('daily_briefing_days')
      .select('id, site_id, brief_date')
      .eq('id', id)
      .maybeSingle();
    if (dayRes.error || !dayRes.data) {
      sendError(res, 404, 'not_found', `day '${id}' not found`);
      return;
    }
    const day = dayRes.data as { id: string; site_id: string; brief_date: string };

    // Resolve the model list. Body-supplied models win (so the UI can
    // mirror exactly which tabs the operator has open). Otherwise fall
    // back to the use case's allowed_models — the server-known canonical
    // list, what the cron / webhook callers will hit.
    const body = (req.body ?? {}) as { models?: unknown };
    let models: string[] = [];
    if (Array.isArray(body.models)) {
      models = (body.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.length > 0);
    }
    if (models.length === 0) {
      const ucRes = await supabase
        .from('ai_use_cases')
        .select('allowed_models, default_model')
        .eq('id', 'daily-briefing-research')
        .maybeSingle();
      const uc = ucRes.data as { allowed_models?: string[]; default_model?: string } | null;
      const allowed = (uc?.allowed_models ?? []).filter((m): m is string => typeof m === 'string' && m.length > 0);
      if (allowed.length > 0) {
        models = allowed;
      } else if (uc?.default_model) {
        models = [uc.default_model];
      }
    }
    if (models.length === 0) {
      sendError(res, 400, 'no_models', 'no models supplied and the use case has no allowed_models configured');
      return;
    }

    // spec-ai-job-runner — create the ai_thread / ai_message rows
    // synchronously, then enqueue `daily-briefing:run-research` per
    // model. The job appears in /admin/ai/jobs and survives an API
    // restart.
    const useCasePrompt = await resolveUseCasePromptSafe(supabase, 'daily-briefing-research');
    const jobIds: string[] = [];
    for (const model of models) {
      const provider = inferProviderFromModel(model);
      const threadKey = model;
      const threadRow = await ensureAiThread(supabase, day.id, threadKey);
      if ('error' in threadRow) {
        logger.warn('daily-briefing.research.enqueue.thread_create_failed', {
          day_id: day.id, model, error: threadRow.error,
        });
        continue;
      }
      if (threadRow.value.status === 'running') continue;
      const placeholder = await supabase
        .from('ai_messages')
        .insert({
          thread_id: threadRow.value.id,
          role: 'assistant',
          status: 'queued',
          content: '',
          provider,
          model,
        })
        .select('id')
        .maybeSingle();
      if (placeholder.error || !placeholder.data) {
        logger.warn('daily-briefing.research.enqueue.placeholder_failed', {
          day_id: day.id, model, error: placeholder.error?.message,
        });
        continue;
      }
      const messageId = (placeholder.data as { id: string }).id;
      await supabase
        .from('ai_threads')
        .update({ status: 'running', last_error: null })
        .eq('id', threadRow.value.id);
      const enq = await deps.enqueueJob('jobs', 'daily-briefing:run-research', {
        dayId: day.id,
        threadId: threadRow.value.id,
        messageId,
        model,
        briefDate: day.brief_date,
        siteId: day.site_id,
        systemPromptOverride: useCasePrompt.systemPrompt,
        kickoffMessage: useCasePrompt.kickoffMessage,
      });
      if (enq.id) jobIds.push(enq.id);
    }
    res.status(202).json({ status: 'queued', models, job_ids: jobIds });
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
      .select('title, summary, source_label, why')
      .eq('day_id', id)
      .eq('status', 'published')
      .order('display_order', { ascending: true })
      .limit(MAX_STORIES_PER_COVER);
    const items = (itemsRes.data ?? []) as Array<{
      title: string;
      summary: string;
      source_label: string;
      why: string | null;
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
      | {
          title?: unknown;
          summary?: unknown;
          source_label?: unknown;
          source_href?: unknown;
          why?: unknown;
        }
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
    // `why` is optional in the schema (older candidates predate it),
    // so we coerce non-string values to null rather than rejecting.
    const why = typeof cand.why === 'string' && cand.why.trim().length > 0
      ? cand.why.trim()
      : null;

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
        why,
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
    runResearchKickoff,
  };
}

// ─── Research helpers (module-private) ────────────────────────────────────

/**
 * Provider lookup from model id. Used by the autopilot when fanning
 * out across tabs — the router needs a provider hint paired with the
 * model id (it can't infer from the model alone because providers
 * sometimes serve the same model name). Defaults to anthropic for
 * unfamiliar names since that's where the historic autopilot runs.
 */
function inferProviderFromModel(model: string): 'anthropic' | 'openai' | 'gemini' {
  if (model.startsWith('claude') || model.startsWith('anthropic')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('openai')) return 'openai';
  if (model.startsWith('gemini') || model.startsWith('google')) return 'gemini';
  return 'anthropic';
}

/**
 * Ensure an ai_threads row exists for a daily-briefing day. Idempotent;
 * tolerates a concurrent insert losing the unique-constraint race by
 * re-SELECTing the winning row.
 */
/**
 * Default thread_key the autopilot writes against. Must match the
 * default tab the AiChatModelTabs widget opens in the UI
 * (defaultModel='claude-sonnet-4-5' for daily-briefing-research). Each
 * model in the tabs widget gets its own thread row keyed by the
 * model id, so this is the autopilot's "main" tab — its candidates
 * land in whichever chat tab is for this model.
 */
const AUTOPILOT_THREAD_KEY = 'claude-sonnet-4-5';

async function ensureAiThread(
  supabase: SupabaseClient,
  dayId: string,
  threadKey: string = AUTOPILOT_THREAD_KEY,
): Promise<{ value: { id: string; status: string; input_tokens: number; output_tokens: number; cost_micro_usd: number } } | { error: string }> {
  const select = await supabase
    .from('ai_threads')
    .select('id, status, input_tokens, output_tokens, cost_micro_usd')
    .eq('use_case', 'daily-briefing-research')
    .eq('host_kind', 'daily_briefing_day')
    .eq('host_id', dayId)
    .eq('thread_key', threadKey)
    .maybeSingle();
  if (select.error) return { error: select.error.message };
  if (select.data) return { value: select.data };

  const created = await supabase
    .from('ai_threads')
    .insert({
      use_case: 'daily-briefing-research',
      host_kind: 'daily_briefing_day',
      host_id: dayId,
      thread_key: threadKey,
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
      .eq('thread_key', threadKey)
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
 * Build the cross-day, cross-thread dedup list for the autopilot.
 *
 * Combines (a) every item ever added to any day in this site, with
 * (b) every candidate title ever surfaced by autopilot in this site's
 * daily-briefing-research threads. The model is told to avoid all of
 * them in its next pass. Returns deduplicated titles.
 *
 * Failures (network, permission, schema drift) degrade to an empty
 * list — better to risk a repeat than block the kickoff entirely.
 */
/**
 * Lazy-import @gatewaze-modules/ai's resolveUseCasePrompt so this
 * module doesn't hard-fail at boot if the ai module is unavailable
 * (mirrors the lazy-import pattern in research-runner.ts +
 * gemini-image.ts). Returns empty strings on any error — callers
 * already know how to fall back to the hardcoded defaults.
 */
async function resolveUseCasePromptSafe(
  supabase: SupabaseClient,
  useCaseId: string,
): Promise<{ systemPrompt: string; kickoffMessage: string }> {
  const attempts = [
    '@gatewaze-modules/ai/lib/use-case-prompt.js',
    '../../../../gatewaze-modules/modules/ai/lib/use-case-prompt.ts',
  ];
  for (const path of attempts) {
    try {
      const mod = (await import(path)) as {
        resolveUseCasePrompt: (
          s: SupabaseClient,
          id: string,
        ) => Promise<{ systemPrompt: string; kickoffMessage: string }>;
      };
      const result = await mod.resolveUseCasePrompt(supabase, useCaseId);
      return { systemPrompt: result.systemPrompt, kickoffMessage: result.kickoffMessage };
    } catch {
      // try next path
    }
  }
  return { systemPrompt: '', kickoffMessage: '' };
}

async function buildAutopilotDedupList(
  supabase: SupabaseClient,
  siteId: string,
): Promise<string[]> {
  const titles = new Set<string>();

  // Lookback cutoff. Days older than this aren't scanned for dedup —
  // an article from a month+ ago is unlikely to re-surface as a
  // "today's news" candidate, and unbounded scans don't scale.
  const cutoffMs = Date.now() - AUTOPILOT_DEDUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString().slice(0, 10); // YYYY-MM-DD

  // (a) All items across days within the lookback window for this site.
  try {
    const days = await supabase
      .from('daily_briefing_days')
      .select('id')
      .eq('site_id', siteId)
      .gte('brief_date', cutoffIso);
    const dayIds = ((days.data ?? []) as Array<{ id: string }>).map((d) => d.id);
    if (dayIds.length > 0) {
      const items = await supabase
        .from('daily_briefing_items')
        .select('title')
        .in('day_id', dayIds);
      for (const row of (items.data ?? []) as Array<{ title: string }>) {
        if (row.title) titles.add(row.title.trim());
      }
    }

    // (b) All candidate titles from prior autopilot turns in this site.
    if (dayIds.length > 0) {
      const threads = await supabase
        .from('ai_threads')
        .select('id')
        .eq('use_case', 'daily-briefing-research')
        .eq('host_kind', 'daily_briefing_day')
        .in('host_id', dayIds);
      const threadIds = ((threads.data ?? []) as Array<{ id: string }>).map((t) => t.id);
      if (threadIds.length > 0) {
        const msgs = await supabase
          .from('ai_messages')
          .select('structured')
          .in('thread_id', threadIds)
          .eq('role', 'assistant');
        for (const row of (msgs.data ?? []) as Array<{ structured: unknown }>) {
          const s = row.structured;
          if (!s || typeof s !== 'object') continue;
          const cands = (s as { candidates?: unknown }).candidates;
          if (!Array.isArray(cands)) continue;
          for (const c of cands) {
            if (c && typeof c === 'object') {
              const t = (c as Record<string, unknown>).title;
              if (typeof t === 'string' && t.trim()) titles.add(t.trim());
            }
          }
        }
      }
    }
  } catch {
    // Best-effort. An empty/partial list still lets the kickoff run.
  }

  return Array.from(titles);
}

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
  router.post('/admin/days/:id/research/run', routes.runResearchKickoff);
}
