/**
 * Gemini image generation for daily-briefing day covers.
 *
 * Calls Google's `gemini-2.5-flash-image-preview` (the model commonly
 * referred to as "nano banana") with the AAIF-branded newspaper-comic
 * prompt template, then uploads the resulting PNG to the host-media
 * Supabase Storage bucket. Returns the storage path + public CDN URL +
 * the exact prompt that was used (stored on the day row for audit).
 *
 * Why a dedicated file in this module, not editor-ai-copilot:
 *   editor-ai-copilot is the text/tool-use surface (Claude + GPT). The
 *   Gemini image API has a different shape and a different env key,
 *   and the daily-briefing prompt is brand-specific in a way that
 *   wouldn't survive a "generic image gen" abstraction. Cheaper to
 *   inline here than to design a shared surface no other caller yet
 *   needs.
 */

import { buildDailyBriefingImagePrompt } from './gemini-prompt.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = 'gemini-2.5-flash-image-preview';

// Supabase Storage bucket — must match HOST_MEDIA_BUCKET on the platform
// side. Fallback to 'media' matches host-media's own default.
const STORAGE_BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';

export interface DailyBriefingStory {
  title: string;
  summary: string;
  source_label: string;
}

export interface GeneratedImage {
  storage_path: string;
  cdn_url: string;
  prompt: string;
}

export interface GenerateDayImageOpts {
  dayId: string;
  siteId: string;
  briefDate: string; // YYYY-MM-DD
  stories: DailyBriefingStory[];
}

export interface GenerateDayImageDeps {
  apiKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  publicSupabaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Used by tests to make the filename deterministic. */
  now?: () => Date;
}

/**
 * Generate the day's cartoon cover, upload to storage, return the
 * persistable references. Throws on any failure so the caller can
 * mark image_status='failed' + capture the error.
 */
export function makeDayImageGenerator(deps: GenerateDayImageDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  return async function generateDayImage(
    opts: GenerateDayImageOpts,
  ): Promise<GeneratedImage> {
    const prompt = buildDailyBriefingImagePrompt(opts.stories);

    // 1. Call Gemini image API.
    const url =
      `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(deps.apiKey)}`;
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    };
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `gemini API returned ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    const json = (await response.json()) as GeminiGenerateResponse;
    const part = json.candidates?.[0]?.content?.parts?.find(
      (p): p is GeminiInlineDataPart => Boolean(p.inline_data?.data) || Boolean(p.inlineData?.data),
    );
    // Gemini's v1beta JSON uses both `inline_data` (REST shape) and
    // `inlineData` (TS SDK shape) depending on transport. Accept either.
    const inlineData = part?.inline_data ?? part?.inlineData;
    if (!inlineData?.data) {
      const finishReason = json.candidates?.[0]?.finishReason ?? 'unknown';
      throw new Error(
        `gemini response contained no image data (finish_reason=${finishReason})`,
      );
    }
    const mimeType = inlineData.mimeType ?? inlineData.mime_type ?? 'image/png';
    const buffer = Buffer.from(inlineData.data, 'base64');

    // 2. Upload to Supabase Storage via the same shape host-media uses:
    //    <hostKind>/<hostId>/<mediaId>/<filename>
    const ts = now().toISOString().replace(/[:.]/g, '-');
    const ext = mimeFromTypeToExt(mimeType);
    const filename = `cover-${opts.briefDate}-${ts}.${ext}`;
    const mediaId = `cover-${ts}`;
    const storagePath = `daily_briefing_day/${opts.dayId}/${mediaId}/${filename}`;

    const { error } = await deps.supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });
    if (error) {
      throw new Error(`storage upload failed: ${error.message}`);
    }

    const cdnUrl = `${deps.publicSupabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
    return { storage_path: storagePath, cdn_url: cdnUrl, prompt };
  };
}

function mimeFromTypeToExt(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

interface GeminiInlineDataPart {
  inline_data?: { data: string; mime_type?: string; mimeType?: string };
  inlineData?: { data: string; mime_type?: string; mimeType?: string };
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: GeminiInlineDataPart[] };
    finishReason?: string;
  }>;
}
