/**
 * Worker handler — processes a single `daily-briefing:run-research` job.
 *
 * Lifts the body of api/admin-routes.ts::kickoffAutopilot off the API
 * process so research turns are observable in the /admin/ai/jobs tab
 * and survive an API restart. The actual research logic still lives
 * in lib/research-runner.ts (which wraps the AI module's runChat).
 *
 * Job payload: { dayId, threadId, messageId, model, briefDate, siteId }
 *
 * Stream events go onto `ai:thread:{threadId}` so the chat widget +
 * the Jobs tab live-tail see the same surface.
 */

import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
// We resolve runtime deps lazily through the host project (matches the
// pattern in run-recipe-handler / inspector / redis-client).

interface JobInput {
  data: {
    dayId?: string;
    threadId?: string;
    messageId?: string;
    model?: string;
    briefDate?: string;
    siteId?: string;
    systemPromptOverride?: string;
    kickoffMessage?: string;
  };
  id?: string | number;
  attemptsMade?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts?: any;
}

interface RuntimeContext {
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
  projectRoot?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveFetchUrl?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveGatewazeSearch?: any;
}

const BRAND = process.env.BRAND || 'default';
const STREAM_TTL_SECONDS = Number(process.env.AI_STREAM_TTL_SECONDS ?? 3600);
const STREAM_MAXLEN = Number(process.env.AI_STREAM_MAXLEN ?? 10000);

export default async function runResearchHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  const { dayId, threadId, messageId, model, briefDate, siteId, systemPromptOverride, kickoffMessage } = job.data;
  if (!dayId || !threadId || !messageId || !model || !briefDate) {
    return { skipped: true, reason: 'missing_required_payload' };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Resolve research-runner + redis from the host project's module
  // graph. The daily-briefing module is a peer of the AI module + the
  // platform's ioredis; both are available through the API package
  // path that the platform always exposes via ctx.projectRoot.
  const projectRoot =
    ctx?.projectRoot ?? process.env.GATEWAZE_PROJECT_ROOT ?? process.cwd();
  const req = createRequire(`${projectRoot}/packages/api/package.json`);

  type RedisCtor = new (
    url: string,
    opts?: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => any;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ioredisMod = req('ioredis') as { default?: RedisCtor } & RedisCtor;
  const Redis = (ioredisMod.default ?? ioredisMod) as RedisCtor;
  const redisUrl =
    process.env.REDIS_URL ??
    (process.env.REDIS_HOST
      ? `redis://${process.env.REDIS_PASSWORD ? `:${encodeURIComponent(process.env.REDIS_PASSWORD)}@` : ''}${process.env.REDIS_HOST}:${process.env.REDIS_PORT ?? 6379}`
      : null);
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true })
    : null;

  const streamKey = `${BRAND}:ai:thread:${threadId}`;

  async function streamPush(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!redis) return;
    try {
      const ts = Date.now();
      await redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        STREAM_MAXLEN,
        '*',
        'type',
        type,
        'payload',
        JSON.stringify({ ts, ...payload }),
      );
    } catch {
      // best-effort
    }
  }

  // Load the research-runner from the daily-briefing module's own
  // path (the worker process resolves this through the host's
  // pnpm-linked workspace).
  const runnerCandidates = [
    `${projectRoot}/lf-gatewaze-modules/modules/daily-briefing/lib/research-runner.ts`,
    '@lf-gatewaze-modules/daily-briefing/lib/research-runner.js',
    '../lib/research-runner.js',
  ];
  type MakeResearchRunner = (deps: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any;
    logger: NonNullable<RuntimeContext['logger']>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveFetchUrl?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveGatewazeSearch?: any;
  }) => (opts: Record<string, unknown>) => Promise<{
    narrative: string;
    candidates: Array<Record<string, unknown>>;
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
  }>;
  let makeResearchRunner: MakeResearchRunner | null = null;
  for (const c of runnerCandidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = req(c) as { makeResearchRunner: MakeResearchRunner };
      if (mod?.makeResearchRunner) {
        makeResearchRunner = mod.makeResearchRunner;
        break;
      }
    } catch {
      // try next
    }
  }
  if (!makeResearchRunner) {
    await markFailed(supabase, messageId, threadId, 'research-runner not resolvable');
    await streamPush('run.failed', { error: { code: 'runner_unresolved', message: 'research-runner not found' } });
    throw new Error('UnrecoverableError: research-runner not resolvable');
  }

  const runResearch = makeResearchRunner({
    supabase,
    logger: ctx?.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    resolveFetchUrl: ctx?.resolveFetchUrl,
    resolveGatewazeSearch: ctx?.resolveGatewazeSearch,
  });

  const provider = inferProviderFromModel(model);

  // run.start event for the Jobs tab live-tail.
  await streamPush('run.start', { recipeId: `daily-briefing:${dayId}` });
  if (redis) await redis.expire(streamKey, STREAM_TTL_SECONDS).catch(() => undefined);

  try {
    const alreadyPublished = await buildDedupList(supabase, siteId ?? '');
    const result = await runResearch({
      briefDate,
      history: [],
      message: kickoffMessage ?? '',
      alreadyPublished,
      threadId,
      messageId,
      systemPromptOverride: systemPromptOverride ?? '',
      model,
      provider,
    });

    // Persist into the ai_messages placeholder the API created.
    await supabase
      .from('ai_messages')
      .update({
        status: 'complete',
        content: result.narrative,
        structured: { narrative: result.narrative, candidates: result.candidates },
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_micro_usd: result.costMicroUsd,
        provider,
        model,
      })
      .eq('id', messageId);
    await supabase
      .from('ai_threads')
      .update({
        status: 'ready',
        last_error: null,
      })
      .eq('id', threadId);

    await streamPush('assistant.complete', {
      messageId,
      cost_micro_usd: result.costMicroUsd,
      tokens_in: result.inputTokens,
      tokens_out: result.outputTokens,
    });
    await streamPush('run.complete', {
      final_output: { candidates: result.candidates.length },
      total_cost_micro_usd: result.costMicroUsd,
    });
    return { ok: true, candidates: result.candidates.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(supabase, messageId, threadId, message);
    await streamPush('run.failed', { error: { code: 'research_failed', message } });
    throw err;
  } finally {
    if (redis) {
      try {
        await redis.expire(streamKey, STREAM_TTL_SECONDS);
      } catch {
        // best effort
      }
      await streamPush('close', {});
      try {
        await redis.quit();
      } catch {
        // best effort
      }
    }
  }
}

async function markFailed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  messageId: string,
  threadId: string,
  message: string,
): Promise<void> {
  await supabase
    .from('ai_messages')
    .update({
      status: 'failed',
      content: `Run failed: ${message}`,
    })
    .eq('id', messageId);
  await supabase
    .from('ai_threads')
    .update({ status: 'failed', last_error: message })
    .eq('id', threadId);
}

function inferProviderFromModel(model: string): 'anthropic' | 'openai' | 'gemini' {
  if (model.startsWith('claude') || model.startsWith('anthropic')) return 'anthropic';
  if (
    model.startsWith('gpt') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('openai')
  ) return 'openai';
  if (model.startsWith('gemini') || model.startsWith('google')) return 'gemini';
  return 'anthropic';
}

/**
 * Rebuild the "already promoted" dedup list. Best-effort import of the
 * helper from admin-routes — falls back to an empty list if not
 * resolvable (the model will still run, the user just gets duplicate
 * candidates suppressed by post-processing).
 */
async function buildDedupList(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  siteId: string,
): Promise<string[]> {
  if (!siteId) return [];
  try {
    // The dedup helper lives in api/admin-routes — re-implement the
    // SELECT here so the worker doesn't take a server-route module dep.
    const itemsRes = await supabase
      .from('daily_briefing_items')
      .select('title')
      .eq('site_id', siteId)
      .limit(500);
    const items = (itemsRes?.data as Array<{ title: string }> | null) ?? [];
    return items.map((r) => r.title).filter((s) => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}
