/**
 * Daily-briefing day cover image generation — bridged to
 * @gatewaze-modules/ai per spec-ai-module.md Phase B.
 *
 * Previously called Gemini's REST API directly with the GEMINI_API_KEY
 * env var. Now routed through the ai module's `aiGenerateImage`, which
 * gives us cost tracking in ai_usage_events (tagged use_case=
 * 'daily-briefing-cover'), per-use-case daily caps, and the same
 * three-tier credential resolution as the rest of the platform.
 *
 * The brand-specific newspaper-comic prompt template stays here in
 * gemini-prompt.ts — only the LLM call is delegated.
 */

import { buildDailyBriefingImagePrompt } from './gemini-prompt.js';

const STORAGE_BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';
const USE_CASE = 'daily-briefing-cover';

export interface DailyBriefingStory {
  title: string;
  summary: string;
  source_label: string;
}

export interface GeneratedImage {
  storage_path: string;
  prompt: string;
}

export interface GenerateDayImageOpts {
  dayId: string;
  siteId: string;
  briefDate: string; // YYYY-MM-DD
  stories: DailyBriefingStory[];
}

export interface GenerateDayImageDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  /** Used by tests to make the filename deterministic. */
  now?: () => Date;
}

// Lazy-import the ai module — same pattern as research-runner.ts.
type AiGenerateImageFn = (
  ctx: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any;
    logger?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
  },
  opts: {
    useCase: string;
    userId: string | null;
    prompt: string;
    model?: string;
    aspectRatio?: '16:9' | '1:1' | '4:3' | '9:16';
    destination: { bucket: string; path: string };
    systemRun?: boolean;
  },
) => Promise<{ storagePath: string; mimeType: string; prompt: string; costMicroUsd: number; model: string; provider: string }>;

let cachedAiGenerateImage: AiGenerateImageFn | null = null;
async function getAiGenerateImage(): Promise<AiGenerateImageFn> {
  if (cachedAiGenerateImage) return cachedAiGenerateImage;
  const attempts = [
    '@gatewaze-modules/ai/lib/runner.js',
    '../../../../gatewaze-modules/modules/ai/lib/runner.ts',
  ];
  let lastErr: unknown;
  for (const path of attempts) {
    try {
      const mod = (await import(path)) as { aiGenerateImage: AiGenerateImageFn };
      cachedAiGenerateImage = mod.aiGenerateImage;
      return cachedAiGenerateImage;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `daily-briefing gemini-image: failed to resolve @gatewaze-modules/ai/lib/runner. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export function makeDayImageGenerator(deps: GenerateDayImageDeps) {
  const now = deps.now ?? (() => new Date());

  return async function generateDayImage(
    opts: GenerateDayImageOpts,
  ): Promise<GeneratedImage> {
    const prompt = buildDailyBriefingImagePrompt(opts.stories);

    const ts = now().toISOString().replace(/[:.]/g, '-');
    const mediaId = `cover-${ts}`;
    const filename = `cover-${opts.briefDate}-${ts}.png`;
    const storagePath = `daily_briefing_day/${opts.dayId}/${mediaId}/${filename}`;

    const aiGenerateImage = await getAiGenerateImage();
    const result = await aiGenerateImage(
      { supabase: deps.supabase },
      {
        useCase: USE_CASE,
        userId: null,
        prompt,
        aspectRatio: '16:9',
        destination: { bucket: STORAGE_BUCKET, path: storagePath },
        systemRun: true,
      },
    );

    return { storage_path: result.storagePath, prompt: result.prompt };
  };
}
