/**
 * AAIF-branded newspaper-comic prompt template for the daily-briefing
 * cover image. Interpolates the day's stories into the [Stories]
 * placeholder. Authored by the operator and locked here so each day's
 * generation uses the exact same brand-correct phrasing.
 *
 * The example prompt at the bottom is for the model's reference — the
 * actual rendering instructions tell Gemini to ADAPT it to the supplied
 * stories rather than reproduce it.
 */

import type { DailyBriefingStory } from './gemini-image.js';

const PROMPT_TEMPLATE = `Create a newspaper-comic style image from these stories:

[Stories]

Apply AAIF brand guidance throughout:
- primarily black and white, with AAIF orange (#FF702D) and lavender (#B6B0D0) as accents
- use typography inspired by Instrument Sans: clean, geometric, modern sans-serif
- keep the tone trustworthy, collaborative, neutral, and playful without becoming generic corporate tech art

Fixed format:
- Main masthead/title text must be exactly: "The Daily Agentic"
- Use a vintage but vibrant Sunday newspaper comic/page-one layout: bold masthead, panels, speech bubbles, editorial captions, halftone dots, ink outlines, and playful character-driven vignettes.
- Keep the composition legible in social feeds.
- Make the stories feel like today's front-page beats, not a generic collage.
- Use expressive illustrated characters, action lines, panel dividers, caption boxes, and a clear hierarchy.
- Avoid abstract circuit-board visuals, stock-photo aesthetics, dark moody tech imagery, or generic corporate SaaS art.

Content rules:
- Base the issue on the stories
- Convert the stories into 3 to 5 visual story beats or panels.
- Preserve the factual meaning of the provided stories; do not invent claims, company announcements, statistics, or names that were not provided.
- Shorten story language aggressively so the graphic is readable.
- Use witty newspaper/comic-style labels, but keep them grounded.

Example prompt for Nanobanana (do not use this exact prompt, adapt it based on the provided stories and the design rules above):

\`\`\`
Create a 16:9 banner image about the latest agentic AI news. Style: bold, graphic, fun comic-book/pop-art illustration with solid bright background, punchy typography, expressive cartoon characters, halftone accents, action lines, speech bubbles. NOT corporate, NOT abstract tech, NOT dark moody, NOT stock photo.

Composition: wide split-panel comic strip with 4 connected mini-scenes.

Scene 1 (largest, left side): a cute but intense robot ping-pong player smashing a ball past surprised human pro players, motion lines, scoreboard reading "AGENTS: 3 / PROS: 2".
Scene 2: a friendly "ReasoningBank" memory vault/brain character filing glowing strategy cards labeled "learn", "fail", "retry".
Scene 3: a tiny AI agent trimming an overflowing toolbox/context window with scissors, with floating tool icons and a label "CUT CONTEXT BLOAT".
Scene 4: a futuristic terminal/news screen with a little agent goose or robot assistant surfacing breaking-news cards.

Main headline text, big and readable: "THE DAILY AGENTIC"
Secondary text in bold comic caption style: "ROBOTS • MEMORY • CONTEXT • NEWS"

Make text crisp and legible. Use thick black outlines, comic panels, playful energy, clean composition with strong contrast.
\`\`\``;

/**
 * Render the prompt template with the day's stories. Each story is
 * formatted as `N. <title> — <summary> (source: <source_label>)` so
 * the model has enough context to extract panel ideas without us
 * pre-distilling them. The aggressive-shortening rule in the prompt
 * tells Gemini to compress them on its own.
 */
export function buildDailyBriefingImagePrompt(stories: DailyBriefingStory[]): string {
  const lines = stories
    .map(
      (s, i) =>
        `${i + 1}. ${s.title.trim()} — ${s.summary.trim()} (source: ${s.source_label.trim()})`,
    )
    .join('\n');
  return PROMPT_TEMPLATE.replace('[Stories]', lines);
}
