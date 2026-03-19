/**
 * Processing Worker
 *
 * Processes content queue items through the full processing pipeline:
 *   1. Pick up items from content_queue with status 'pending'
 *   2. Content-type-specific scraping and extraction
 *   3. Generate summary, hot take, topic/project tags
 *   4. For video/audio: deep indexing with timestamped segments
 *   5. Generate embeddings for semantic search
 *   6. Write to content_items and content_segments
 *
 * This is "Agent 2" from the spec — the most complex agent.
 * Individual content-type handlers will be implemented as the pipeline matures.
 */

import { supabase } from '@/lib/supabase';

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
    let result;

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
      })
      .select()
      .single();

    if (insertError || !contentItem) {
      throw new Error(`Failed to insert content item: ${insertError?.message}`);
    }

    // Insert segments if any (deep video indexing)
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

    console.log(`[content-processing] Completed: ${contentItem.title}`);
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
// Content-type-specific handlers (stubs)
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
  // 3. LLM summary, hot take, tags
  // 4. Generate embedding
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

async function processAudio(queueItem: any): Promise<ProcessingResult> {
  // TODO: Implement audio/podcast processing
  // 1. Download audio
  // 2. Transcribe with Whisper (timestamped)
  // 3. LLM segmentation and summary
  // 4. Generate embedding
  console.log(`[content-processing] Audio processing not yet implemented: ${queueItem.url}`);
  return {
    title: queueItem.title || 'Untitled Audio',
    summary: 'Processing not yet implemented.',
  };
}

async function processGeneric(queueItem: any): Promise<ProcessingResult> {
  console.log(`[content-processing] Generic processing for: ${queueItem.url}`);
  return {
    title: queueItem.title || 'Untitled Content',
    summary: 'Processing not yet implemented.',
  };
}
