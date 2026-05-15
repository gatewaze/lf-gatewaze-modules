/**
 * System + user prompt builders for the daily-briefing research
 * autopilot. The system prompt is the operator-authored "find the
 * strongest agentic AI items" brief, verbatim. The user prompt is
 * constructed per-turn from the conversation history + the operator's
 * latest message.
 */

export interface ResearchCandidate {
  title: string;
  summary: string;
  source_label: string;
  source_href: string;
  /** Why this matters — included in the model's reasoning, surfaced in the admin UI. */
  why: string;
}

export interface ResearchHistoryTurn {
  role: 'user' | 'assistant';
  /** Free-form text the operator sent or the assistant returned. */
  content: string;
  /** Assistant turns that proposed candidates serialise them here. */
  candidates?: ResearchCandidate[];
}

/**
 * The fixed system prompt — the brief from the operator describing
 * what makes a strong daily-agentic item and how to format output.
 *
 * Two adaptations from the raw brief:
 *   - The output schema is enforced via a structured-output tool
 *     (submit_candidates), not via the "DAILY AGENTIC — [DATE]" markup.
 *     The narrative explanation still goes in the assistant's text
 *     turn so the operator can read it in the chat panel.
 *   - The "date" is interpolated per call so the model has the
 *     today/yesterday anchor it needs for the 24h gate.
 */
export const RESEARCH_SYSTEM_PROMPT = `You are the research assistant for the AAIF Daily Agentic newsletter. Find the strongest agentic AI items from the past day, with a strict date gate. Focus on concrete developments in:
- AI agents, agent runtimes, coding agents, browser/desktop agents, enterprise agents
- MCP, Goose, ACP, A2A, AP2, x402, agent protocols, gateways, registries, tool governance
- Agent security, prompt injection, tool misuse, sandboxing, secrets exposure, runtime controls
- Agentic commerce, payments, identity, permissions, auditability, enterprise control planes
- Open-source agent frameworks, agent evals, memory, context engineering, orchestration, MCP servers
- Production deployments or credible real-world usage of agents
- Major social signals only when they indicate real ecosystem momentum

Use a strict 24-hour date gate from today. Do not include older items unless there is a fresh update, release, exploit, repo change, funding announcement, benchmark, or major social signal inside the 24-hour window.

Always check:
- Hacker News, using 200+ points as the normal threshold for meaningful traction
- GitHub Trending daily
- X/social signals from credible builders, maintainers, researchers, founders, and major AI labs
- Major AI/company blogs and repos
- Relevant newsletters and email sources when available, including AI News, arXiv trending papers, MarkTechPost, business news, Alpha Signal, and Latent Space
- Reputable tech and business outlets

Compare against the already-published Daily Agentic document or prior list provided. Do not duplicate anything already published.

For each candidate, evaluate:
- Is it truly agentic, or just general AI?
- Is it new inside the date gate?
- Is there a concrete artifact, release, benchmark, repo, product change, security event, production deployment, or credible social signal?
- Why does it matter for agent infrastructure, enterprise adoption, developer workflows, security, protocols, commerce, or production use?
- Is it strong enough for a top 5?

Rules:
- Keep the bullets punchy and copy-ready.
- Use Capital Case headlines, not ALL CAPS.
- Include direct destination URLs only (no aggregators, no AMP, no tracking wrappers).
- Prefer primary sources, repos, official docs, credible press, and high-signal social posts.
- Exclude weak vendor product launches, generic AI model news, routine MCP server launches, generic "AI assistant" news, and anything that is not clearly agentic.
- If fewer than five strong items pass the gate, return fewer and say so in your narrative — do not pad.

Workflow:
1. Use the available tools (web_search and fetch_url) to discover and verify items. Prefer fetch_url to confirm details on primary sources after a search surfaces them.
2. Write a short narrative explaining what you found and what you considered borderline. This becomes the assistant message the operator sees in the chat panel.
3. End your turn by calling the \`submit_candidates\` tool with the stack-ranked top items (max 5). Each candidate needs a Capital Case title, a single-sentence summary, a source label, a primary-source URL, and a why-sentence.

When the operator follows up to refine ("drop the third one", "find me something fresher about MCP security"), re-run the relevant parts of the search and submit a revised candidate list. Always submit the FULL current list via \`submit_candidates\`, not just diffs.`;

/**
 * JSON schema for the model's structured-output tool. The model MUST
 * call this tool to terminate its turn; the loop in editor-ai-copilot
 * returns whatever JSON the tool received.
 */
export const SUBMIT_CANDIDATES_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    narrative: {
      type: 'string',
      description:
        'Short prose explanation of what you found, what you skipped, and any caveats. 2–6 sentences. Shown to the operator alongside the candidate cards.',
    },
    candidates: {
      type: 'array',
      description:
        'Stack-ranked top items, strongest first. Max 5; can be fewer if the date gate is thin.',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Capital Case headline.' },
          summary: { type: 'string', description: 'One concise sentence explaining what happened.' },
          source_label: { type: 'string', description: 'e.g. "Anthropic blog", "HN", "GitHub".' },
          source_href: { type: 'string', description: 'Primary-source URL.' },
          why: { type: 'string', description: 'One sentence on significance for agent infra / adoption.' },
        },
        required: ['title', 'summary', 'source_label', 'source_href', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['narrative', 'candidates'],
  additionalProperties: false,
} as const;

export interface BuildUserPromptOpts {
  /** ISO date (YYYY-MM-DD) — anchors the model's 24h gate. */
  briefDate: string;
  /** Previously-published item titles (from earlier days). Model uses for de-dup. */
  alreadyPublished?: string[];
  /** Conversation history within THIS thread (prior turns, oldest first). */
  history: ResearchHistoryTurn[];
  /** The operator's latest message, or the auto-run kickoff text. */
  latestUserMessage: string;
}

/**
 * Builds the per-turn user prompt. We pack the conversation context as
 * structured text rather than rely on multi-turn message history because
 * the shared editor-ai-copilot loop is single-shot — and serialising the
 * prior candidates lets the model refine without re-running every web
 * search (it can decide to keep the strong ones and only re-search for
 * weak slots).
 */
export function buildResearchUserPrompt(opts: BuildUserPromptOpts): string {
  const lines: string[] = [];
  lines.push(`Today's date: ${opts.briefDate}.`);

  if (opts.alreadyPublished && opts.alreadyPublished.length > 0) {
    lines.push('');
    lines.push(
      'Already-published headlines from recent days (do not duplicate):',
    );
    for (const title of opts.alreadyPublished) lines.push(`- ${title}`);
  }

  // History — keep it compact but include the previous candidates so
  // the model can refine in place.
  const prevTurns = opts.history.filter((t) => t.role === 'user' || t.role === 'assistant');
  if (prevTurns.length > 0) {
    lines.push('');
    lines.push('Conversation so far:');
    for (const t of prevTurns) {
      if (t.role === 'user') {
        lines.push(`OPERATOR: ${t.content.trim()}`);
      } else {
        lines.push(`ASSISTANT: ${t.content.trim()}`);
        if (t.candidates && t.candidates.length > 0) {
          lines.push('  Candidates submitted in that turn:');
          for (const c of t.candidates) {
            lines.push(`  - ${c.title} — ${c.summary} (${c.source_label}: ${c.source_href})`);
          }
        }
      }
    }
  }

  lines.push('');
  lines.push(`OPERATOR: ${opts.latestUserMessage.trim()}`);
  lines.push('');
  lines.push(
    'Now run the research workflow and submit your candidates via the submit_candidates tool.',
  );
  return lines.join('\n');
}

/** Default first-run kickoff text used by the weekday autopilot. */
export const AUTOPILOT_KICKOFF_MESSAGE =
  'Run the standard daily-agentic research pass. Find the top 5 strongest items inside the 24-hour gate, stack-ranked by editorial strength.';
