/**
 * Daily-briefing AI research autopilot — server-side runner.
 *
 * Drives the multi-turn Claude conversation that surfaces candidate
 * agentic-AI stories for an operator to approve into a daily briefing.
 *
 * Architecture:
 *   - Re-uses `runAnthropicWithWebTools` from editor-ai-copilot to get
 *     the recursive fetch_url + web_search loop terminating on a
 *     structured-output tool. That loop is single-shot per call; we
 *     pack the conversation history into the user prompt so each
 *     refinement turn carries the prior context.
 *   - Fetches go through the internal scrapling-fetcher backend (same
 *     path the editor copilot uses for canvas fetches).
 *
 * The runner is exception-tolerant on the persistence side — failures
 * raise typed errors that the admin endpoint translates to HTTP. We
 * never write a partial assistant turn: if the model errors, the thread
 * status flips to 'failed' with `last_error` so the chat UI can surface
 * a retry button without rendering half-baked output.
 */

import {
  RESEARCH_SYSTEM_PROMPT,
  SUBMIT_CANDIDATES_TOOL_SCHEMA,
  buildResearchUserPrompt,
  type ResearchCandidate,
  type ResearchHistoryTurn,
} from './research-prompt.js';

/**
 * Lazy import of editor-ai-copilot's anthropic+web-tools loop. The
 * package isn't on this module's runtime require-path until the
 * platform's module loader stitches the workspace together at install
 * time, so eager `import { runAnthropicWithWebTools }` crashes the
 * daily-briefing module at boot. Deferring to first-call lets the
 * module boot cleanly even on instances that don't have the copilot
 * installed; the admin endpoint catches the failure and returns 503.
 */
type RunAnthropicWithWebToolsFn = (opts: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  structuredTool: { name: string; description: string; inputSchema: Record<string, unknown> };
  maxOutputTokens: number;
  timeoutMs: number;
  webSearch?: { maxPerTurn: number };
  fetchUrl?: {
    maxPerTurn: number;
    fetchOptions: Record<string, unknown>;
  };
}) => Promise<{
  input: unknown;
  inputTokens: number;
  outputTokens: number;
  fetchedUrls: ReadonlyArray<{
    url: string;
    status: number;
    byte_count: number;
    error_code: string | null;
  }>;
}>;

let cachedLoader: RunAnthropicWithWebToolsFn | null = null;

async function getAnthropicLoop(): Promise<RunAnthropicWithWebToolsFn> {
  if (cachedLoader) return cachedLoader;
  // Try the package-named path first (works when editor-ai-copilot is
  // resolvable as a workspace package), then fall back to a relative
  // path that works when the platform mounts both module repos side-
  // by-side under /lf-gatewaze-modules and /premium-gatewaze-modules.
  const attempts = [
    '@gatewaze-modules/editor-ai-copilot/lib/web-tools/anthropic-loop.js',
    '../../../../premium-gatewaze-modules/modules/editor-ai-copilot/lib/web-tools/anthropic-loop.ts',
  ];
  let lastErr: unknown;
  for (const path of attempts) {
    try {
      const mod = (await import(path)) as {
        runAnthropicWithWebTools: RunAnthropicWithWebToolsFn;
      };
      cachedLoader = mod.runAnthropicWithWebTools;
      return cachedLoader;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `daily-briefing research-runner: failed to resolve editor-ai-copilot's anthropic-loop module. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_OUTPUT_TOKENS = 8_000;
const TIMEOUT_MS = 120_000;
const WEB_SEARCH_MAX_PER_TURN = 6;
const FETCH_URL_MAX_PER_TURN = 8;
const FETCH_MAX_BYTES = 200_000;

export interface ResearchRunnerOpts {
  /** ISO date the operator is researching. */
  briefDate: string;
  /** Prior conversation turns within this thread (oldest first). */
  history: ResearchHistoryTurn[];
  /** Operator's new message, or the autopilot kickoff text. */
  message: string;
  /** Previously-published headlines from older days; the model dedups against these. */
  alreadyPublished?: string[];
}

export interface ResearchRunnerResult {
  narrative: string;
  candidates: ResearchCandidate[];
  inputTokens: number;
  outputTokens: number;
  fetchedUrls: ReadonlyArray<{
    url: string;
    status: number;
    byte_count: number;
    error_code: string | null;
  }>;
}

export interface ResearchRunnerDeps {
  anthropicApiKey: string;
  scraplingFetcherUrl: string;
  scraplingInternalToken: string;
  model?: string;
}

/**
 * Build a research-runner function bound to the platform's credentials.
 * The returned function is called per chat turn.
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

    const runAnthropicWithWebTools = await getAnthropicLoop();
    const result = await runAnthropicWithWebTools({
      apiKey: deps.anthropicApiKey,
      model: deps.model ?? DEFAULT_MODEL,
      systemPrompt: RESEARCH_SYSTEM_PROMPT,
      userPrompt,
      structuredTool: {
        name: 'submit_candidates',
        description:
          'Submit your final stack-ranked candidate list and a short narrative explanation. This terminates the turn.',
        // The shared loop accepts a plain JSON schema object; cast through
        // unknown so the local TS check doesn't try to over-narrow it.
        inputSchema: SUBMIT_CANDIDATES_TOOL_SCHEMA as unknown as Record<string, unknown>,
      },
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: TIMEOUT_MS,
      webSearch: { maxPerTurn: WEB_SEARCH_MAX_PER_TURN },
      fetchUrl: {
        maxPerTurn: FETCH_URL_MAX_PER_TURN,
        fetchOptions: {
          backend: 'scrapling',
          baseUrl: deps.scraplingFetcherUrl,
          internalToken: deps.scraplingInternalToken,
          mode: 'fast',
          timeoutMs: 20_000,
          maxBytes: FETCH_MAX_BYTES,
        },
      },
    });

    const parsed = parseStructuredOutput(result.input);
    return {
      narrative: parsed.narrative,
      candidates: parsed.candidates,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      fetchedUrls: result.fetchedUrls.map((f) => ({
        url: f.url,
        status: f.status,
        byte_count: f.byte_count,
        error_code: f.error_code,
      })),
    };
  };
}

/**
 * The structured-output tool returns `{ narrative, candidates }` per
 * SUBMIT_CANDIDATES_TOOL_SCHEMA. The shared loop returns it typed as
 * `unknown`; narrow it here, throwing if the shape is wrong (the loop
 * already validated against the schema, but defence-in-depth + a clean
 * type narrow makes the downstream code simpler).
 */
function parseStructuredOutput(raw: unknown): {
  narrative: string;
  candidates: ResearchCandidate[];
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('research_runner: structured output was not an object');
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
