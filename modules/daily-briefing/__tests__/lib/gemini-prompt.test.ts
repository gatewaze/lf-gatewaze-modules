import { describe, it, expect } from 'vitest';
import { buildDailyBriefingImagePrompt } from '../../lib/gemini-prompt.js';

describe('buildDailyBriefingImagePrompt', () => {
  it('interpolates stories into the [Stories] placeholder', () => {
    const prompt = buildDailyBriefingImagePrompt([
      { title: 'Claude wins ping pong', summary: 'Bot beats pros.', source_label: 'X' },
      { title: 'Context shrinks', summary: 'New trim mode.', source_label: 'Blog' },
    ]);
    expect(prompt).toContain('1. Claude wins ping pong — Bot beats pros. (source: X)');
    expect(prompt).toContain('2. Context shrinks — New trim mode. (source: Blog)');
    expect(prompt).not.toContain('[Stories]');
  });

  it('preserves the AAIF brand directives + fixed masthead text', () => {
    const prompt = buildDailyBriefingImagePrompt([
      { title: 'a', summary: 'b', source_label: 'c' },
    ]);
    expect(prompt).toContain('AAIF orange (#FF702D)');
    expect(prompt).toContain('lavender (#B6B0D0)');
    expect(prompt).toContain('"The Daily Agentic"');
    expect(prompt).toContain('Instrument Sans');
  });

  it('trims whitespace on inputs', () => {
    const prompt = buildDailyBriefingImagePrompt([
      { title: '  Lead  ', summary: '  trailing  ', source_label: '  Source  ' },
    ]);
    expect(prompt).toContain('1. Lead — trailing (source: Source)');
  });
});
