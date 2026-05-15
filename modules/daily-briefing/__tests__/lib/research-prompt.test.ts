import { describe, it, expect } from 'vitest';
import {
  buildResearchUserPrompt,
  RESEARCH_SYSTEM_PROMPT,
} from '../../lib/research-prompt.js';

describe('buildResearchUserPrompt', () => {
  it('anchors the model with today’s date', () => {
    const prompt = buildResearchUserPrompt({
      briefDate: '2026-05-15',
      history: [],
      latestUserMessage: 'kick off',
    });
    expect(prompt).toContain("Today's date: 2026-05-15");
  });

  it('includes the dedup list when given prior headlines', () => {
    const prompt = buildResearchUserPrompt({
      briefDate: '2026-05-15',
      history: [],
      latestUserMessage: 'kick off',
      alreadyPublished: ['Robot Ping-Pong Wins', 'Context Trim Mode'],
    });
    expect(prompt).toContain('Already-published headlines');
    expect(prompt).toContain('- Robot Ping-Pong Wins');
    expect(prompt).toContain('- Context Trim Mode');
  });

  it('serialises prior candidates so refinements have context', () => {
    const prompt = buildResearchUserPrompt({
      briefDate: '2026-05-15',
      latestUserMessage: 'drop the AWS one, find something fresher',
      history: [
        {
          role: 'assistant',
          content: 'Top 3 today.',
          candidates: [
            { title: 'A', summary: 's', source_label: 'src', source_href: 'https://a', why: 'w' },
          ],
        },
      ],
    });
    expect(prompt).toContain('ASSISTANT: Top 3 today.');
    expect(prompt).toContain('A — s (src: https://a)');
    expect(prompt).toContain('OPERATOR: drop the AWS one');
  });

  it('omits the published-list block when none provided', () => {
    const prompt = buildResearchUserPrompt({
      briefDate: '2026-05-15',
      history: [],
      latestUserMessage: 'kick off',
    });
    expect(prompt).not.toContain('Already-published');
  });
});

describe('RESEARCH_SYSTEM_PROMPT', () => {
  it('embeds the strict 24-hour date gate rule', () => {
    expect(RESEARCH_SYSTEM_PROMPT).toContain('strict 24-hour date gate');
  });
  it('directs the model to use the structured-output submit_candidates tool', () => {
    expect(RESEARCH_SYSTEM_PROMPT).toContain('submit_candidates');
  });
  it('does NOT include the legacy "DAILY AGENTIC — [DATE]" formatting (output is JSON now)', () => {
    expect(RESEARCH_SYSTEM_PROMPT).not.toContain('DAILY AGENTIC — [DATE]');
  });
});
