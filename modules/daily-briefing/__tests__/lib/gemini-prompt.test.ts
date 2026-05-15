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

  it('asks for a single panel when given exactly one story', () => {
    const prompt = buildDailyBriefingImagePrompt([
      { title: 'a', summary: 'b', source_label: 'c' },
    ]);
    expect(prompt).toContain('single illustrated panel or vignette');
    expect(prompt).not.toContain('[PanelInstruction]');
    // Must not carry over the old hardcoded "3 to 5" language.
    expect(prompt).not.toContain('3 to 5');
  });

  it('asks for exactly N panels matching the story count', () => {
    for (const n of [2, 3, 4, 5]) {
      const prompt = buildDailyBriefingImagePrompt(
        Array.from({ length: n }, (_, i) => ({
          title: `t${i}`,
          summary: `s${i}`,
          source_label: `src${i}`,
        })),
      );
      expect(prompt).toContain(`Render exactly ${n} visual story beats or panels`);
      expect(prompt).not.toContain('[PanelInstruction]');
      expect(prompt).not.toContain('3 to 5');
    }
  });
});
