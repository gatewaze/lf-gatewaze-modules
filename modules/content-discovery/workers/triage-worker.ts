/**
 * Triage Worker
 *
 * Processes content submissions through the triage stage:
 *   1. Classify the submitted URL (single item vs index/feed/playlist)
 *   2. Determine content_type and source_type
 *   3. Expand collections into individual items (e.g., playlist → videos)
 *   4. Deduplicate against existing content_items
 *   5. Create entries in content_queue
 *
 * This is "Agent 1" from the spec — focused on classification and fan-out.
 */

import { supabase } from '@/lib/supabase';

interface TriageJobData {
  submissionId: string;
}

export default async function triageWorker(job: { data: TriageJobData }) {
  const { submissionId } = job.data;

  console.log(`[content-triage] Processing submission: ${submissionId}`);

  // Fetch the submission
  const { data: submission, error } = await supabase
    .from('content_submissions')
    .select('*')
    .eq('id', submissionId)
    .single();

  if (error || !submission) {
    console.error(`[content-triage] Submission not found: ${submissionId}`, error);
    return;
  }

  // Mark as triaging
  await supabase
    .from('content_submissions')
    .update({ status: 'triaging' })
    .eq('id', submissionId);

  try {
    const url = submission.url;
    if (!url) {
      throw new Error('Submission has no URL');
    }

    // Classify the URL
    const classification = classifyUrl(url);

    // Check for duplicates
    const { data: existingItem } = await supabase
      .from('content_items')
      .select('id')
      .eq('url', url)
      .maybeSingle();

    if (existingItem) {
      await supabase
        .from('content_submissions')
        .update({ status: 'duplicate' })
        .eq('id', submissionId);
      console.log(`[content-triage] Duplicate found for: ${url}`);
      return;
    }

    const { data: existingQueue } = await supabase
      .from('content_queue')
      .select('id')
      .eq('url', url)
      .maybeSingle();

    if (existingQueue) {
      await supabase
        .from('content_submissions')
        .update({ status: 'duplicate' })
        .eq('id', submissionId);
      console.log(`[content-triage] Already in queue: ${url}`);
      return;
    }

    // For collection URLs (playlists, blog indexes), expand into individual items
    // TODO: Implement expansion for playlists, channels, blog indexes
    const urls = [{ url, title: null as string | null }];

    // Create queue entries
    for (const item of urls) {
      await supabase
        .from('content_queue')
        .insert({
          submission_id: submissionId,
          url: item.url,
          title: item.title,
          content_type: classification.contentType,
          source_type: classification.sourceType,
          priority: classification.priority,
        });
    }

    // Mark submission as completed
    await supabase
      .from('content_submissions')
      .update({ status: 'completed' })
      .eq('id', submissionId);

    console.log(`[content-triage] Created ${urls.length} queue entries for submission ${submissionId}`);
  } catch (err: any) {
    console.error(`[content-triage] Failed:`, err);
    await supabase
      .from('content_submissions')
      .update({ status: 'failed', error_message: err.message })
      .eq('id', submissionId);
  }
}

// ============================================================================
// URL Classification
// ============================================================================

interface UrlClassification {
  contentType: string;
  sourceType: string;
  priority: number;
  isCollection: boolean;
}

function classifyUrl(url: string): UrlClassification {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  // YouTube
  if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
    const isPlaylist = parsed.searchParams.has('list') && !parsed.searchParams.has('v');
    const isChannel = parsed.pathname.startsWith('/@') || parsed.pathname.includes('/channel/');
    return {
      contentType: 'video',
      sourceType: 'youtube',
      priority: 2,
      isCollection: isPlaylist || isChannel,
    };
  }

  // GitHub
  if (hostname.includes('github.com')) {
    return {
      contentType: 'repo',
      sourceType: 'github',
      priority: 3,
      isCollection: false,
    };
  }

  // Reddit
  if (hostname.includes('reddit.com')) {
    return {
      contentType: 'article',
      sourceType: 'reddit',
      priority: 4,
      isCollection: false,
    };
  }

  // Hacker News
  if (hostname.includes('news.ycombinator.com')) {
    return {
      contentType: 'article',
      sourceType: 'hackernews',
      priority: 3,
      isCollection: false,
    };
  }

  // Twitter/X
  if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
    return {
      contentType: 'article',
      sourceType: 'twitter',
      priority: 4,
      isCollection: false,
    };
  }

  // Podcast platforms
  if (hostname.includes('spotify.com') || hostname.includes('podcasts.apple.com') ||
      hostname.includes('anchor.fm') || hostname.includes('podbean.com')) {
    return {
      contentType: 'podcast',
      sourceType: 'podcast',
      priority: 3,
      isCollection: false,
    };
  }

  // Default: blog/article
  return {
    contentType: 'article',
    sourceType: 'blog',
    priority: 3,
    isCollection: false,
  };
}
