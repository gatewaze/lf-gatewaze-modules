/**
 * Processing Worker
 *
 * Processes content queue items through the full processing pipeline:
 *   1. Pick up items from content_queue with status 'pending'
 *   2. Content-type-specific scraping and extraction
 *   3. Extract canonical URLs and published/updated dates
 *   4. Check for cross-platform duplicates
 *   5. Generate summary, hot take, topic/project tags
 *   6. For video/audio: deep indexing with timestamped segments
 *   7. Generate embeddings for semantic search
 *   8. Write to content_items and content_segments
 *   9. Record duplicate relationships if found
 *
 * This is "Agent 2" from the spec — the most complex agent.
 * Individual content-type handlers will be implemented as the pipeline matures.
 */

import { supabase } from '@/lib/supabase';
import {
  checkForDuplicate,
  recordDuplicate,
  promoteToCanonical,
  extractCanonicalUrl,
  extractDates,
} from '../utils/dedup';

interface ProcessingJobData {
  queueItemId: string;
}

export default async function processingWorker(job: { data: ProcessingJobData }) {
  const { queueItemId } = job.data;

  console.log(`[content-processing] Processing queue item: ${queueItemId}`);

  // Fetch the queue item
  const { data: queueItem, error } = await supabase
    .from('content_queue')
    .select('*')
    .eq('id', queueItemId)
    .single();

  if (error || !queueItem) {
    console.error(`[content-processing] Queue item not found: ${queueItemId}`, error);
    return;
  }

  // Mark as processing
  await supabase
    .from('content_queue')
    .update({
      status: 'processing',
      processing_started_at: new Date().toISOString(),
    })
    .eq('id', queueItemId);

  try {
    // Dispatch to content-type-specific handler
    let result: ProcessingResult;

    switch (queueItem.content_type) {
      case 'video':
        result = await processVideo(queueItem);
        break;
      case 'article':
      case 'tutorial':
      case 'documentation':
        result = await processArticle(queueItem);
        break;
      case 'repo':
        result = await processRepo(queueItem);
        break;
      case 'podcast':
      case 'talk':
        result = await processAudio(queueItem);
        break;
      default:
        result = await processGeneric(queueItem);
    }

    if (!result) {
      throw new Error('Processing returned no result');
    }

    // ================================================================
    // Dedup check — before inserting, check for cross-platform matches
    // ================================================================
    const dedupResult = await checkForDuplicate(
      result.title || queueItem.title || '',
      queueItem.content_type,
      queueItem.source_type,
      result.author,
      result.durationSeconds,
      result.canonicalUrl,
    );

    if (dedupResult?.isDuplicate && dedupResult.canonicalItemId) {
      // An existing item is the canonical version (e.g., video exists, this is a podcast)
      // Still insert the item but mark it as non-canonical and link to the canonical
      console.log(
        `[content-processing] Duplicate detected — existing item ${dedupResult.canonicalItemId} is canonical (${dedupResult.matchDetails.preference_decision})`
      );
    }

    // Determine canonical status
    const isCanonical = !dedupResult?.isDuplicate || !dedupResult.canonicalItemId;

    // Insert the content item
    const { data: contentItem, error: insertError } = await supabase
      .from('content_items')
      .insert({
        queue_id: queueItemId,
        url: queueItem.url,
        title: result.title || queueItem.title || queueItem.url,
        content_type: queueItem.content_type,
        source_type: queueItem.source_type,
        author: result.author,
        author_url: result.authorUrl,
        publish_date: result.publishDate,
        summary: result.summary,
        hot_take: result.hotTake,
        topics: result.topics || [],
        projects: result.projects || [],
        key_people: result.keyPeople || [],
        thumbnail_url: result.thumbnailUrl,
        duration_seconds: result.durationSeconds,
        raw_text: result.rawText,
        transcript: result.transcript,
        has_segments: (result.segments?.length ?? 0) > 0,
        language: result.language || 'en',
        metadata: result.metadata || {},
        quality_score: result.qualityScore,
        discovered_at: queueItem.created_at,
        processed_at: new Date().toISOString(),
        // Canonical/dedup fields
        canonical_url: result.canonicalUrl,
        is_canonical: isCanonical,
        source_published_at: result.sourcePublishedAt,
        source_updated_at: result.sourceUpdatedAt,
      })
      .select()
      .single();

    if (insertError || !contentItem) {
      throw new Error(`Failed to insert content item: ${insertError?.message}`);
    }

    // ================================================================
    // Record duplicate relationship if found
    // ================================================================
    if (dedupResult?.isDuplicate) {
      if (dedupResult.canonicalItemId) {
        // Existing item is canonical, new item is the duplicate
        await recordDuplicate(dedupResult.canonicalItemId, contentItem.id, dedupResult);
      } else if (dedupResult.duplicateItemId) {
        // New item should be canonical (e.g., we found the original source)
        // Promote this new item and demote the existing one
        await recordDuplicate(contentItem.id, dedupResult.duplicateItemId, dedupResult);
        await promoteToCanonical(contentItem.id, dedupResult.duplicateItemId);
        console.log(
          `[content-processing] New item promoted to canonical — demoted ${dedupResult.duplicateItemId}`
        );
      }
    }

    // Insert segments if any (deep video/audio indexing)
    if (result.segments && result.segments.length > 0) {
      const segmentRows = result.segments.map((seg: any, i: number) => ({
        content_item_id: contentItem.id,
        segment_index: i,
        start_time: seg.start_time,
        end_time: seg.end_time,
        title: seg.title,
        summary: seg.summary,
        topics: seg.topics || [],
        projects: seg.projects || [],
        key_people: seg.key_people || [],
        transcript_text: seg.transcript_text,
      }));

      const { error: segError } = await supabase
        .from('content_segments')
        .insert(segmentRows);

      if (segError) {
        console.error('[content-processing] Failed to insert segments:', segError);
      }
    }

    // Mark queue item as completed
    await supabase
      .from('content_queue')
      .update({ status: 'completed' })
      .eq('id', queueItemId);

    console.log(`[content-processing] Completed: ${contentItem.title} (canonical=${isCanonical})`);
  } catch (err: any) {
    console.error(`[content-processing] Failed:`, err);

    const newRetryCount = (queueItem.retry_count || 0) + 1;
    const maxRetries = queueItem.max_retries || 3;

    await supabase
      .from('content_queue')
      .update({
        status: newRetryCount >= maxRetries ? 'failed' : 'pending',
        error_message: err.message,
        retry_count: newRetryCount,
        processing_started_at: null,
      })
      .eq('id', queueItemId);
  }
}

// ============================================================================
// Content-type-specific handlers
// ============================================================================

interface ProcessingResult {
  title?: string;
  author?: string;
  authorUrl?: string;
  publishDate?: string;
  summary?: string;
  hotTake?: string;
  topics?: string[];
  projects?: string[];
  keyPeople?: string[];
  thumbnailUrl?: string;
  durationSeconds?: number;
  rawText?: string;
  transcript?: string;
  language?: string;
  metadata?: Record<string, any>;
  qualityScore?: number;
  canonicalUrl?: string;
  sourcePublishedAt?: string;
  sourceUpdatedAt?: string;
  segments?: Array<{
    start_time: number;
    end_time: number;
    title: string;
    summary?: string;
    topics?: string[];
    projects?: string[];
    key_people?: string[];
    transcript_text?: string;
  }>;
}

async function processVideo(queueItem: any): Promise<ProcessingResult> {
  // TODO: Implement video processing
  // 1. Extract metadata via yt-dlp or YouTube API
  // 2. Get timestamped transcript (captions or Whisper)
  // 3. LLM segmentation for deep video indexing
  // 4. Generate summary, hot take, tags
  // 5. Generate embedding
  // 6. Extract canonical URL from page HTML
  console.log(`[content-processing] Video processing not yet implemented: ${queueItem.url}`);
  return {
    title: queueItem.title || 'Untitled Video',
    summary: 'Processing not yet implemented.',
  };
}

async function processArticle(queueItem: any): Promise<ProcessingResult> {
  // TODO: Implement article processing
  // 1. Scrape with Playwright/fetch
  // 2. Extract main content (strip nav/ads)
  // 3. Extract canonical URL and published/updated dates from HTML
  // 4. LLM summary, hot take, tags
  // 5. Generate embedding
  console.log(`[content-processing] Article processing not yet implemented: ${queueItem.url}`);
  return {
    title: queueItem.title || 'Untitled Article',
    summary: 'Processing not yet implemented.',
  };
}

async function processRepo(queueItem: any): Promise<ProcessingResult> {
  // TODO: Implement repo processing
  // 1. Fetch README, description via GitHub API
  // 2. Extract star count, last commit, contributors
  // 3. LLM summary, tags
  // 4. Generate embedding
  console.log(`[content-processing] Repo processing not yet implemented: ${queueItem.url}`);
  return {
    title: queueItem.title || 'Untitled Repository',
    summary: 'Processing not yet implemented.',
  };
}

/**
 * Process podcast/audio content.
 *
 * Pipeline:
 *   1. Resolve the podcast episode — get RSS feed URL from podcast platform links
 *   2. Extract episode metadata from RSS feed (title, author, description, duration, enclosure URL)
 *   3. Download the audio file from the RSS enclosure
 *   4. Transcribe with OpenAI Whisper API (with timestamps)
 *   5. LLM segmentation — break transcript into topical segments
 *   6. Generate summary, hot take, topic/project tags
 *   7. Extract canonical URL (prefer the podcast's own website link)
 *   8. Check for cross-platform duplicates (especially YouTube videos of the same episode)
 */
async function processAudio(queueItem: any): Promise<ProcessingResult> {
  const url = queueItem.url;
  console.log(`[content-processing] Processing audio: ${url}`);

  // Step 1: Resolve podcast episode metadata
  // For RSS-sourced items, metadata may already be in queue metadata
  const episodeMeta = queueItem.metadata?.episode || await resolveEpisodeMetadata(url);

  if (!episodeMeta) {
    console.warn(`[content-processing] Could not resolve episode metadata for: ${url}`);
    return {
      title: queueItem.title || 'Untitled Podcast',
      summary: 'Could not resolve podcast episode metadata.',
      metadata: { processing_note: 'metadata_resolution_failed' },
    };
  }

  // Step 2: Download audio from enclosure URL
  const audioUrl = episodeMeta.enclosureUrl || episodeMeta.audioUrl;
  if (!audioUrl) {
    console.warn(`[content-processing] No audio URL found for: ${url}`);
    return {
      title: episodeMeta.title || queueItem.title || 'Untitled Podcast',
      author: episodeMeta.author,
      summary: episodeMeta.description || 'No audio URL available for transcription.',
      durationSeconds: episodeMeta.durationSeconds,
      metadata: { ...episodeMeta, processing_note: 'no_audio_url' },
    };
  }

  // Step 3: Transcribe with Whisper
  // TODO: Implement actual Whisper API call
  // const transcription = await transcribeWithWhisper(audioUrl);
  console.log(`[content-processing] Whisper transcription not yet implemented for: ${audioUrl}`);

  const transcription = {
    text: '',
    segments: [] as Array<{ start: number; end: number; text: string }>,
    language: 'en',
  };

  // Step 4: LLM segmentation (when transcript is available)
  // TODO: Implement LLM segmentation
  // const segments = await segmentTranscript(transcription, episodeMeta);
  const segments: ProcessingResult['segments'] = [];

  if (transcription.segments.length > 0) {
    // Group whisper segments into topical segments via LLM
    // This would call an LLM to identify topic boundaries and create
    // meaningful segments with titles and summaries
    console.log(`[content-processing] LLM segmentation not yet implemented`);
  }

  // Step 5: Generate summary and tags
  // TODO: Implement LLM summarization
  // const analysis = await analyzePodcast(transcription.text, episodeMeta);

  return {
    title: episodeMeta.title || queueItem.title || 'Untitled Podcast',
    author: episodeMeta.author,
    authorUrl: episodeMeta.authorUrl,
    publishDate: episodeMeta.publishDate,
    summary: episodeMeta.description || 'Transcription and analysis pending.',
    durationSeconds: episodeMeta.durationSeconds,
    thumbnailUrl: episodeMeta.imageUrl,
    transcript: transcription.text || undefined,
    language: transcription.language,
    canonicalUrl: episodeMeta.canonicalUrl || episodeMeta.websiteUrl,
    sourcePublishedAt: episodeMeta.publishDate,
    segments,
    metadata: {
      podcast_name: episodeMeta.podcastName,
      episode_number: episodeMeta.episodeNumber,
      season_number: episodeMeta.seasonNumber,
      audio_url: audioUrl,
      rss_feed_url: episodeMeta.rssFeedUrl,
      platform_urls: episodeMeta.platformUrls || {},
    },
  };
}

async function processGeneric(queueItem: any): Promise<ProcessingResult> {
  console.log(`[content-processing] Generic processing for: ${queueItem.url}`);
  return {
    title: queueItem.title || 'Untitled Content',
    summary: 'Processing not yet implemented.',
  };
}

// ============================================================================
// Podcast helpers
// ============================================================================

interface EpisodeMetadata {
  title: string;
  author?: string;
  authorUrl?: string;
  description?: string;
  publishDate?: string;
  durationSeconds?: number;
  imageUrl?: string;
  enclosureUrl?: string;
  audioUrl?: string;
  canonicalUrl?: string;
  websiteUrl?: string;
  podcastName?: string;
  episodeNumber?: number;
  seasonNumber?: number;
  rssFeedUrl?: string;
  platformUrls?: Record<string, string>;
}

/**
 * Resolve episode metadata from a podcast platform URL.
 *
 * Strategy:
 * - For RSS feed URLs: parse the feed directly
 * - For Apple Podcasts: use the iTunes Lookup API to get the RSS feed URL, then parse
 * - For Spotify: scrape the episode page for metadata (no public API for podcasts)
 * - For other platforms: attempt to scrape basic metadata from the HTML
 */
async function resolveEpisodeMetadata(url: string): Promise<EpisodeMetadata | null> {
  const hostname = new URL(url).hostname.toLowerCase();

  try {
    if (hostname.includes('podcasts.apple.com')) {
      return await resolveApplePodcast(url);
    }

    if (hostname.includes('spotify.com')) {
      return await resolveSpotifyPodcast(url);
    }

    // For direct RSS or unknown URLs, try to fetch and parse as RSS
    return await resolveFromRss(url);
  } catch (err: any) {
    console.error(`[content-processing] Failed to resolve episode metadata:`, err);
    return null;
  }
}

/**
 * Resolve Apple Podcasts episode via iTunes Lookup API.
 * Apple Podcasts URLs contain a podcast ID that can be used with the lookup API
 * to get the RSS feed URL, which we then parse for full episode data.
 */
async function resolveApplePodcast(url: string): Promise<EpisodeMetadata | null> {
  // Extract podcast ID from URL: https://podcasts.apple.com/.../id1234567890
  const idMatch = url.match(/\/id(\d+)/);
  if (!idMatch) return null;

  const podcastId = idMatch[1];

  // Use iTunes Lookup API to get the RSS feed URL
  // TODO: Implement actual fetch
  // const lookupUrl = `https://itunes.apple.com/lookup?id=${podcastId}&entity=podcast`;
  // const response = await fetch(lookupUrl);
  // const data = await response.json();
  // const feedUrl = data.results?.[0]?.feedUrl;

  console.log(`[content-processing] Apple Podcast lookup not yet implemented for ID: ${podcastId}`);
  return null;
}

/**
 * Resolve Spotify podcast episode.
 * Spotify doesn't have a public podcast API, so we scrape the episode page
 * for basic metadata and attempt to find an associated RSS feed.
 */
async function resolveSpotifyPodcast(url: string): Promise<EpisodeMetadata | null> {
  // TODO: Implement Spotify episode scraping
  // 1. Fetch the Spotify episode page
  // 2. Extract metadata from <script type="application/ld+json"> or meta tags
  // 3. Try to find the podcast's RSS feed via podcast index or manual lookup
  console.log(`[content-processing] Spotify podcast resolution not yet implemented: ${url}`);
  return null;
}

/**
 * Resolve episode metadata from an RSS feed URL.
 * This is the most reliable path — RSS feeds contain complete episode data
 * including the audio enclosure URL needed for transcription.
 */
async function resolveFromRss(url: string): Promise<EpisodeMetadata | null> {
  // TODO: Implement RSS feed parsing
  // 1. Fetch the RSS feed XML
  // 2. Parse with a library like rss-parser or fast-xml-parser
  // 3. Find the specific episode (match by URL or GUID)
  // 4. Extract: title, author, description, enclosure URL, duration, pubDate, image
  //
  // Example RSS episode structure:
  // <item>
  //   <title>Episode Title</title>
  //   <itunes:author>Author Name</itunes:author>
  //   <description>Episode description...</description>
  //   <enclosure url="https://cdn.example.com/episode.mp3" type="audio/mpeg" />
  //   <itunes:duration>3600</itunes:duration>
  //   <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>
  //   <itunes:image href="https://cdn.example.com/cover.jpg" />
  //   <itunes:episode>42</itunes:episode>
  //   <itunes:season>2</itunes:season>
  //   <link>https://podcast-website.com/episodes/42</link>
  // </item>

  console.log(`[content-processing] RSS feed parsing not yet implemented: ${url}`);
  return null;
}

// ============================================================================
// Whisper transcription (stub)
// ============================================================================

/**
 * Transcribe audio using OpenAI Whisper API.
 *
 * Returns timestamped segments for deep indexing.
 *
 * TODO: Implement actual API call:
 *   1. Download the audio file to a temp location
 *   2. If file > 25MB, split into chunks (Whisper API limit)
 *   3. Call OpenAI Whisper API with response_format='verbose_json'
 *      to get word-level timestamps
 *   4. Return the full transcript text and timestamped segments
 *   5. Clean up temp files
 */
// async function transcribeWithWhisper(audioUrl: string): Promise<{
//   text: string;
//   segments: Array<{ start: number; end: number; text: string }>;
//   language: string;
// }> {
//   // Implementation will use OpenAI SDK:
//   // const openai = new OpenAI({ apiKey: config.openaiApiKey });
//   // const transcription = await openai.audio.transcriptions.create({
//   //   file: audioStream,
//   //   model: 'whisper-1',
//   //   response_format: 'verbose_json',
//   //   timestamp_granularities: ['segment'],
//   // });
// }
