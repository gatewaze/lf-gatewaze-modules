/**
 * Discovery Worker
 *
 * Processes discovery jobs by checking configured sources for new content.
 * Each job targets a specific discovery source and:
 *   1. Fetches new items from the source (RSS, YouTube API, GitHub, etc.)
 *   2. Filters against already-known URLs
 *   3. Creates content_submissions for new items
 *   4. Logs the run in discovery_runs
 *
 * Source-type-specific handlers will be added as the pipeline matures.
 */

import { supabase } from '@/lib/supabase';

interface DiscoveryJobData {
  sourceId: string;
  frequency?: string;
}

export default async function discoveryWorker(job: { data: DiscoveryJobData }) {
  const { sourceId, frequency } = job.data;

  console.log(`[content-discovery] Starting discovery for source: ${sourceId}`);

  // Fetch the source configuration
  const { data: source, error: sourceError } = await supabase
    .from('content_discovery_sources')
    .select('*')
    .eq('id', sourceId)
    .single();

  if (sourceError || !source) {
    console.error(`[content-discovery] Source not found: ${sourceId}`, sourceError);
    return;
  }

  // Create a discovery run record
  const { data: run, error: runError } = await supabase
    .from('content_discovery_runs')
    .insert({
      source_id: sourceId,
      status: 'running',
    })
    .select()
    .single();

  if (runError || !run) {
    console.error('[content-discovery] Failed to create run record', runError);
    return;
  }

  try {
    let itemsFound = 0;
    let itemsSubmitted = 0;

    // Dispatch to source-type-specific handler
    switch (source.source_type) {
      case 'rss':
        ({ itemsFound, itemsSubmitted } = await discoverFromRss(source));
        break;
      case 'youtube_channel':
      case 'youtube_search':
        ({ itemsFound, itemsSubmitted } = await discoverFromYoutube(source));
        break;
      case 'github_topic':
      case 'github_repo':
        ({ itemsFound, itemsSubmitted } = await discoverFromGithub(source));
        break;
      case 'hackernews':
        ({ itemsFound, itemsSubmitted } = await discoverFromHackerNews(source));
        break;
      case 'reddit_subreddit':
        ({ itemsFound, itemsSubmitted } = await discoverFromReddit(source));
        break;
      default:
        console.log(`[content-discovery] No handler for source type: ${source.source_type}`);
    }

    // Update run as completed
    await supabase
      .from('content_discovery_runs')
      .update({
        status: 'completed',
        items_found: itemsFound,
        items_submitted: itemsSubmitted,
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id);

    // Update last_checked_at on the source
    await supabase
      .from('content_discovery_sources')
      .update({ last_checked_at: new Date().toISOString() })
      .eq('id', sourceId);

    console.log(`[content-discovery] Completed: found=${itemsFound}, submitted=${itemsSubmitted}`);
  } catch (error: any) {
    console.error('[content-discovery] Discovery failed:', error);

    await supabase
      .from('content_discovery_runs')
      .update({
        status: 'failed',
        error_message: error.message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id);
  }
}

// ============================================================================
// Source-type handlers (stubs — implement with actual API integrations)
// ============================================================================

async function submitUrls(urls: string[], sourceType: string, submittedBy: string) {
  if (urls.length === 0) return 0;

  // Check which URLs already exist
  const { data: existing } = await supabase
    .from('content_submissions')
    .select('url')
    .in('url', urls);

  const { data: existingItems } = await supabase
    .from('content_items')
    .select('url')
    .in('url', urls);

  const existingUrls = new Set([
    ...(existing || []).map(r => r.url),
    ...(existingItems || []).map(r => r.url),
  ]);

  const newUrls = urls.filter(u => !existingUrls.has(u));

  if (newUrls.length === 0) return 0;

  const submissions = newUrls.map(url => ({
    url,
    submission_type: 'url' as const,
    submitted_by: submittedBy,
    status: 'pending' as const,
  }));

  const { error } = await supabase
    .from('content_submissions')
    .insert(submissions);

  if (error) {
    console.error('[content-discovery] Failed to insert submissions:', error);
    return 0;
  }

  return newUrls.length;
}

async function discoverFromRss(source: any): Promise<{ itemsFound: number; itemsSubmitted: number }> {
  // TODO: Implement RSS feed parsing
  // Use a library like rss-parser to fetch and parse the feed
  // Extract URLs from feed items
  console.log(`[content-discovery] RSS discovery not yet implemented for: ${source.source_url}`);
  return { itemsFound: 0, itemsSubmitted: 0 };
}

async function discoverFromYoutube(source: any): Promise<{ itemsFound: number; itemsSubmitted: number }> {
  // TODO: Implement YouTube Data API integration
  // For youtube_channel: list recent videos from channel
  // For youtube_search: search for videos matching query
  console.log(`[content-discovery] YouTube discovery not yet implemented for: ${source.source_url || source.search_query}`);
  return { itemsFound: 0, itemsSubmitted: 0 };
}

async function discoverFromGithub(source: any): Promise<{ itemsFound: number; itemsSubmitted: number }> {
  // TODO: Implement GitHub API integration
  // For github_topic: search repos by topic
  // For github_repo: check for new releases/activity
  console.log(`[content-discovery] GitHub discovery not yet implemented for: ${source.source_url || source.search_query}`);
  return { itemsFound: 0, itemsSubmitted: 0 };
}

async function discoverFromHackerNews(source: any): Promise<{ itemsFound: number; itemsSubmitted: number }> {
  // TODO: Implement HN Algolia API integration
  // Search for relevant keywords in recent stories
  console.log(`[content-discovery] HN discovery not yet implemented for: ${source.search_query}`);
  return { itemsFound: 0, itemsSubmitted: 0 };
}

async function discoverFromReddit(source: any): Promise<{ itemsFound: number; itemsSubmitted: number }> {
  // TODO: Implement Reddit API integration
  // Fetch recent posts from specified subreddit filtered by keywords
  console.log(`[content-discovery] Reddit discovery not yet implemented for: ${source.source_url}`);
  return { itemsFound: 0, itemsSubmitted: 0 };
}
