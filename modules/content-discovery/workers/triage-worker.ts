/**
 * Triage Worker
 *
 * Processes content submissions through the triage stage:
 *   1. Classify the submitted URL (single item vs index/feed/playlist)
 *   2. Determine content_type and source_type
 *   3. Expand collections into individual items (e.g., playlist → videos)
 *   4. Deduplicate against existing content_items (exact URL + cross-platform fuzzy)
 *   5. Create entries in content_queue
 *
 * This is "Agent 1" from the spec — focused on classification and fan-out.
 */

import { supabase } from '@/lib/supabase';
import { findDuplicates } from '../utils/dedup';

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

    // ================================================================
    // Exact URL dedup — check if this exact URL already exists
    // ================================================================
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

    // ================================================================
    // Cross-platform dedup for podcasts
    // If this is a podcast URL, check if we already have a video version
    // of the same content (videos are preferred over podcasts)
    // ================================================================
    if (classification.contentType === 'podcast' && submission.title) {
      const crossPlatformMatches = await findDuplicates(
        submission.title,
        null, // author not known at triage time
        null, // duration not known at triage time
      );

      // If we find a high-confidence match that's a video, skip this podcast
      const videoMatch = crossPlatformMatches.find(
        (m) => m.item_content_type === 'video' && m.title_similarity > 0.8
      );

      if (videoMatch) {
        await supabase
          .from('content_submissions')
          .update({
            status: 'duplicate',
            notes: `Cross-platform duplicate of video: ${videoMatch.item_url}`,
          })
          .eq('id', submissionId);
        console.log(
          `[content-triage] Podcast skipped — video version exists: ${videoMatch.item_url} (similarity=${videoMatch.title_similarity})`
        );
        return;
      }
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
      hostname.includes('anchor.fm') || hostname.includes('podbean.com') ||
      hostname.includes('overcast.fm') || hostname.includes('pocketcasts.com') ||
      hostname.includes('castbox.fm') || hostname.includes('castro.fm')) {
    return {
      contentType: 'podcast',
      sourceType: 'podcast',
      priority: 3,
      isCollection: false,
    };
  }

  // RSS feed URLs (common patterns)
  if (parsed.pathname.endsWith('/feed') || parsed.pathname.endsWith('/rss') ||
      parsed.pathname.endsWith('.xml') || parsed.pathname.endsWith('/atom') ||
      parsed.pathname.includes('/feed/')) {
    return {
      contentType: 'podcast',
      sourceType: 'rss',
      priority: 3,
      isCollection: true,
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
