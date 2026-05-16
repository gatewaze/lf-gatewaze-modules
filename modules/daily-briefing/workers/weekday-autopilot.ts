// @ts-nocheck — depends on @supabase/supabase-js which is resolved at module-host install time.

/**
 * Weekday autopilot — runs every weekday morning to pre-populate the
 * next-day's research thread so operators arrive to a chat panel that
 * already has candidate stories.
 *
 * For each site that has the daily-briefing module enabled:
 *   1. Compute the brief_date (today in UTC — the cron fires at 04:00
 *      UTC each Mon-Fri, before the editorial workday).
 *   2. Skip if a day already exists for that (site, brief_date) AND
 *      it already has stories or a non-empty research thread — that
 *      means an operator already started working manually and we
 *      shouldn't clobber their context.
 *   3. Otherwise: create the day (draft), create an empty thread,
 *      kick off the autopilot research, persist the assistant turn.
 *
 * Failures per-site are logged but don't fail the cron — one site's
 * Anthropic 5xx shouldn't take down everyone else's pre-population.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { makeResearchRunner } from '../lib/research-runner.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

interface Deps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>;
  logger: PlatformLogger;
}

const RECENT_PUBLISHED_DAYS = 7;

export async function runWeekdayAutopilot(deps: Deps): Promise<void> {
  const { supabase, logger } = deps;

  // After spec-ai-module Phase B the cron runs through the new ai
  // module's runChat — credentials, cost ledger, and the daily cap are
  // all enforced there. We still wire scrapling-fetcher for the
  // fetch_url tool but the cron can run (using web_search only) even
  // when scrapling is unreachable.
  const scraplingFetcherUrl = process.env.SCRAPLING_FETCHER_URL ?? '';
  const scraplingInternalToken = process.env.SCRAPLING_INTERNAL_TOKEN ?? '';
  const resolveFetchUrl = scraplingFetcherUrl && scraplingInternalToken
    ? buildScraplingFetchResolver(scraplingFetcherUrl, scraplingInternalToken)
    : undefined;

  // Find sites that have the daily-briefing module enabled. The
  // installed_modules row stores per-site flags via the `enabled_sites`
  // array (when the platform supports per-site enables) — for the
  // single-tenant AAIF case, every site in `sites` is in scope.
  const sites = await supabase.from('sites').select('id, slug, name');
  if (sites.error) {
    logger.error('[daily-briefing] weekday autopilot: failed to load sites', {
      error: sites.error.message,
    });
    return;
  }
  const siteRows = (sites.data ?? []) as Array<{ id: string; slug: string; name: string }>;
  if (siteRows.length === 0) {
    logger.info('[daily-briefing] weekday autopilot: no sites enabled');
    return;
  }

  const runResearch = makeResearchRunner({ supabase, resolveFetchUrl, logger });

  const briefDate = new Date().toISOString().slice(0, 10);
  logger.info('[daily-briefing] weekday autopilot: starting', {
    brief_date: briefDate,
    sites: siteRows.length,
  });

  for (const site of siteRows) {
    try {
      await runForSite({ supabase, logger, runResearch, site, briefDate });
    } catch (err) {
      logger.error('[daily-briefing] weekday autopilot: site failed', {
        site_id: site.id,
        site_slug: site.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue to the next site — don't fail the entire cron run.
    }
  }
}

async function runForSite(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>;
  logger: PlatformLogger;
  runResearch: ReturnType<typeof makeResearchRunner>;
  site: { id: string; slug: string; name: string };
  briefDate: string;
}): Promise<void> {
  const { supabase, logger, runResearch, site, briefDate } = args;

  // 1. Existing day? If so, decide whether to skip.
  const existing = await supabase
    .from('daily_briefing_days')
    .select('id, status')
    .eq('site_id', site.id)
    .eq('brief_date', briefDate)
    .maybeSingle();
  if (existing.error) throw new Error(`day lookup: ${existing.error.message}`);

  let dayId: string;
  let isNewDay = false;
  if (existing.data) {
    dayId = (existing.data as { id: string }).id;
    // If a thread already has messages, the operator (or a prior cron
    // pass) has touched this day. Skip — we never overwrite their work.
    const threadRes = await supabase
      .from('daily_briefing_research_threads')
      .select('id')
      .eq('day_id', dayId)
      .maybeSingle();
    if (threadRes.data) {
      const msgRes = await supabase
        .from('daily_briefing_research_messages')
        .select('id')
        .eq('thread_id', (threadRes.data as { id: string }).id)
        .limit(1);
      const hasMessages = ((msgRes.data ?? []) as Array<unknown>).length > 0;
      if (hasMessages) {
        logger.info('[daily-briefing] weekday autopilot: skip site (thread already has messages)', {
          site_id: site.id,
          site_slug: site.slug,
          day_id: dayId,
        });
        return;
      }
    }
    const itemsRes = await supabase
      .from('daily_briefing_items')
      .select('id')
      .eq('day_id', dayId)
      .limit(1);
    const hasItems = ((itemsRes.data ?? []) as Array<unknown>).length > 0;
    if (hasItems) {
      logger.info('[daily-briefing] weekday autopilot: skip site (day already has items)', {
        site_id: site.id,
        site_slug: site.slug,
        day_id: dayId,
      });
      return;
    }
  } else {
    // 2. Create the day in draft state.
    const created = await supabase
      .from('daily_briefing_days')
      .insert({ site_id: site.id, brief_date: briefDate, status: 'draft' })
      .select('id')
      .maybeSingle();
    if (created.error || !created.data) {
      throw new Error(`day create: ${created.error?.message ?? 'no row'}`);
    }
    dayId = (created.data as { id: string }).id;
    isNewDay = true;
  }

  // 3. Ensure a thread exists.
  let threadId: string;
  const existingThread = await supabase
    .from('daily_briefing_research_threads')
    .select('id, input_tokens, output_tokens')
    .eq('day_id', dayId)
    .maybeSingle();
  let existingInputTokens = 0;
  let existingOutputTokens = 0;
  if (existingThread.data) {
    const t = existingThread.data as {
      id: string;
      input_tokens: number;
      output_tokens: number;
    };
    threadId = t.id;
    existingInputTokens = t.input_tokens;
    existingOutputTokens = t.output_tokens;
  } else {
    const createdThread = await supabase
      .from('daily_briefing_research_threads')
      .insert({ day_id: dayId, status: 'running' })
      .select('id')
      .maybeSingle();
    if (createdThread.error || !createdThread.data) {
      throw new Error(`thread create: ${createdThread.error?.message ?? 'no row'}`);
    }
    threadId = (createdThread.data as { id: string }).id;
  }

  // Mark running.
  await supabase
    .from('daily_briefing_research_threads')
    .update({ status: 'running', last_error: null })
    .eq('id', threadId);

  // 4. Load dedup list of recently-published titles.
  const recentDays = await supabase
    .from('daily_briefing_days')
    .select('id')
    .eq('site_id', site.id)
    .eq('status', 'published')
    .order('brief_date', { ascending: false })
    .limit(RECENT_PUBLISHED_DAYS);
  const recentDayIds = ((recentDays.data ?? []) as Array<{ id: string }>).map((d) => d.id);
  let alreadyPublished: string[] = [];
  if (recentDayIds.length > 0) {
    const items = await supabase
      .from('daily_briefing_items')
      .select('title');
    alreadyPublished = ((items.data ?? []) as Array<{ title: string }>).map((r) => r.title);
  }

  // 5. Run the autopilot.
  try {
    const result = await runResearch({
      briefDate,
      history: [],
      message: '',
      alreadyPublished,
    });

    await supabase
      .from('daily_briefing_research_messages')
      .insert({
        thread_id: threadId,
        role: 'assistant',
        content: result.narrative,
        candidates: result.candidates,
      });

    await supabase
      .from('daily_briefing_research_threads')
      .update({
        status: 'ready',
        last_error: null,
        input_tokens: existingInputTokens + result.inputTokens,
        output_tokens: existingOutputTokens + result.outputTokens,
      })
      .eq('id', threadId);

    logger.info('[daily-briefing] weekday autopilot: site complete', {
      site_id: site.id,
      site_slug: site.slug,
      day_id: dayId,
      brief_date: briefDate,
      candidates: result.candidates.length,
      created_day: isNewDay,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('daily_briefing_research_threads')
      .update({ status: 'failed', last_error: message })
      .eq('id', threadId);
    throw err;
  }
}

/**
 * Job-runner entry point. Platform dispatches `data.kind = 'daily-briefing.weekday-autopilot'`
 * here.
 */
export default async function handler(
  payload: { data?: { kind?: string } },
  deps: Deps,
): Promise<void> {
  if (payload.data?.kind !== 'daily-briefing.weekday-autopilot') return;
  await runWeekdayAutopilot(deps);
}

function buildScraplingFetchResolver(
  baseUrl: string,
  token: string,
): (url: string, reason: string) => Promise<{
  ok: boolean;
  content: string;
  bytesIn: number;
  finalUrl: string;
  error?: string;
}> {
  const MAX_BYTES = 200_000;
  const TIMEOUT_MS = 20_000;
  return async (url, reason) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': token },
        body: JSON.stringify({ url, mode: 'fast', extract: ['html'], timeout_ms: TIMEOUT_MS - 1000 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, content: '', bytesIn: 0, finalUrl: url, error: `upstream ${response.status}` };
      }
      const data = (await response.json()) as { data?: { html?: string; final_url?: string; bytes_in?: number } };
      const html = data.data?.html ?? '';
      const truncated = html.length > MAX_BYTES ? html.slice(0, MAX_BYTES) + '\n[…truncated]' : html;
      return {
        ok: true,
        content: `<fetched_content url="${data.data?.final_url ?? url}" reason="${reason}">\n${truncated}\n</fetched_content>`,
        bytesIn: data.data?.bytes_in ?? html.length,
        finalUrl: data.data?.final_url ?? url,
      };
    } catch (err) {
      return { ok: false, content: '', bytesIn: 0, finalUrl: url, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  };
}
