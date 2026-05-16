/**
 * Daily-briefing AI research autopilot — bridged to @gatewaze-modules/ai.
 *
 * Previously this file orchestrated the Anthropic web-tools loop
 * directly (via a dynamic import of editor-ai-copilot's
 * runAnthropicWithWebTools). After spec-ai-module.md / Phase B, the
 * runner is a thin wrapper around the new ai module's `runChat` —
 * we get unified cost ledger writes, the use-case daily-cap gate, and
 * the per-user credential resolution for free, while the daily-
 * briefing-specific prompt template and candidate shape stay here.
 *
 * Key change: `ResearchRunnerDeps` now takes `supabase` instead of raw
 * provider credentials. The old per-call API keys are resolved by the
 * ai module's three-tier router (user → use_case → env).
 */

import {
  RESEARCH_SYSTEM_PROMPT,
  SUBMIT_CANDIDATES_TOOL_SCHEMA,
  buildResearchUserPrompt,
  type ResearchCandidate,
  type ResearchHistoryTurn,
} from './research-prompt.js';

const USE_CASE = 'daily-briefing-research';
const MAX_OUTPUT_TOKENS = 8_000;
const TIMEOUT_MS = 120_000;

// Lazy-import the ai module's runChat. Same pattern we used for
// editor-ai-copilot before — the daily-briefing module's runtime
// require-path doesn't resolve sibling modules eagerly, so import on
// first use and surface a clean 503 from the admin endpoint when the
// ai module isn't installed alongside.
type RunChatFn = (
  ctx: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any;
    resolveFetchUrl?: (url: string, reason: string) => Promise<{
      ok: boolean;
      content: string;
      bytesIn: number;
      finalUrl: string;
      error?: string;
    }>;
    logger?: {
      info(msg: string, meta?: Record<string, unknown>): void;
      warn(msg: string, meta?: Record<string, unknown>): void;
    };
  },
  opts: {
    useCase: string;
    userId: string | null;
    threadId: string | null;
    messageId: string | null;
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool_result'; content: string }>;
    provider?: 'auto' | 'anthropic' | 'openai' | 'gemini';
    model?: string;
    structuredTool?: { name: string; description: string; inputSchema: Record<string, unknown> };
    systemRun?: boolean;
    maxOutputTokens?: number;
    timeoutMs?: number;
  },
) => Promise<{
  narrative: string;
  structured: Record<string, unknown> | null;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  fetchedUrls: ReadonlyArray<{ url: string; status: number; bytes_in: number; reason: string; fetched_at: string }>;
}>;

let cachedRunChat: RunChatFn | null = null;

async function getRunChat(): Promise<RunChatFn> {
  if (cachedRunChat) return cachedRunChat;
  const attempts = [
    '@gatewaze-modules/ai/lib/runner.js',
    '../../../../gatewaze-modules/modules/ai/lib/runner.ts',
  ];
  let lastErr: unknown;
  for (const path of attempts) {
    try {
      const mod = (await import(path)) as { runChat: RunChatFn };
      cachedRunChat = mod.runChat;
      return cachedRunChat;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `daily-briefing research-runner: failed to resolve @gatewaze-modules/ai/lib/runner. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export interface ResearchRunnerOpts {
  briefDate: string;
  history: ResearchHistoryTurn[];
  message: string;
  alreadyPublished?: string[];
  /**
   * Optional links to thread/message rows so the ai module's cost ledger
   * can cross-reference back to the daily-briefing tables. Passed
   * straight through to `runChat`.
   */
  threadId?: string | null;
  messageId?: string | null;
}

export interface ResearchRunnerResult {
  narrative: string;
  candidates: ResearchCandidate[];
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  fetchedUrls: ReadonlyArray<{
    url: string;
    status: number;
    byte_count: number;
    error_code: string | null;
  }>;
}

export interface ResearchRunnerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  resolveFetchUrl?: (url: string, reason: string) => Promise<{
    ok: boolean;
    content: string;
    bytesIn: number;
    finalUrl: string;
    error?: string;
  }>;
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Build a research-runner bound to a supabase client. Every call routes
 * through the ai module's `runChat` (which handles credentials, cost
 * ledger writes, retries, and the per-use-case daily cap).
 */
export function makeResearchRunner(deps: ResearchRunnerDeps) {
  return async function runResearch(
    opts: ResearchRunnerOpts,
  ): Promise<ResearchRunnerResult> {
    const userPrompt = buildResearchUserPrompt({
      briefDate: opts.briefDate,
      alreadyPublished: opts.alreadyPublished,
      history: opts.history,
      latestUserMessage: opts.message,
    });

    const runChat = await getRunChat();
    const result = await runChat(
      { supabase: deps.supabase, resolveFetchUrl: deps.resolveFetchUrl, logger: deps.logger },
      {
        useCase: USE_CASE,
        userId: null,                         // system-run: cron + autopilot fire-and-forget
        threadId: opts.threadId ?? null,
        messageId: opts.messageId ?? null,
        systemPrompt: RESEARCH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        provider: 'anthropic',
        structuredTool: {
          name: 'submit_candidates',
          description:
            'Submit your final stack-ranked candidate list and a short narrative explanation. This terminates the turn.',
          inputSchema: SUBMIT_CANDIDATES_TOOL_SCHEMA as unknown as Record<string, unknown>,
        },
        systemRun: true,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: TIMEOUT_MS,
      },
    );

    const parsed = parseStructuredOutput(result.structured);
    return {
      narrative: parsed.narrative || result.narrative,
      candidates: parsed.candidates,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicroUsd: result.costMicroUsd,
      fetchedUrls: result.fetchedUrls.map((f) => ({
        url: f.url,
        status: f.status,
        byte_count: f.bytes_in,
        error_code: null,
      })),
    };
  };
}

function parseStructuredOutput(raw: unknown): {
  narrative: string;
  candidates: ResearchCandidate[];
} {
  if (!raw || typeof raw !== 'object') {
    return { narrative: '', candidates: [] };
  }
  const obj = raw as Record<string, unknown>;
  const narrative = typeof obj.narrative === 'string' ? obj.narrative : '';
  const rawCandidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  const candidates: ResearchCandidate[] = [];
  for (const c of rawCandidates) {
    if (!c || typeof c !== 'object') continue;
    const row = c as Record<string, unknown>;
    if (
      typeof row.title !== 'string' ||
      typeof row.summary !== 'string' ||
      typeof row.source_label !== 'string' ||
      typeof row.source_href !== 'string' ||
      typeof row.why !== 'string'
    ) {
      continue;
    }
    candidates.push({
      title: row.title,
      summary: row.summary,
      source_label: row.source_label,
      source_href: row.source_href,
      why: row.why,
    });
  }
  return { narrative, candidates };
}
