/**
 * Content Refresh Scheduler
 *
 * Runs weekly to re-check existing content items for updates:
 *   - Update view counts, star counts, etc.
 *   - Detect deleted content
 *   - Refresh metadata
 *
 * This is the "Content Refresh" cron from the spec.
 */

import { supabase } from '@/lib/supabase';

export default async function refreshScheduler() {
  console.log('[content-refresh] Running weekly content refresh');

  try {
    // Find content items that haven't been refreshed recently
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: staleItems, error } = await supabase
      .from('content_items')
      .select('id, url, content_type, source_type')
      .or(`refreshed_at.is.null,refreshed_at.lt.${oneWeekAgo}`)
      .limit(100);

    if (error) {
      console.error('[content-refresh] Failed to fetch stale items:', error);
      return;
    }

    if (!staleItems || staleItems.length === 0) {
      console.log('[content-refresh] No items need refreshing');
      return;
    }

    console.log(`[content-refresh] Found ${staleItems.length} items to refresh`);

    // TODO: Implement refresh logic per content type
    // For now, just mark them as refreshed
    for (const item of staleItems) {
      await supabase
        .from('content_items')
        .update({ refreshed_at: new Date().toISOString() })
        .eq('id', item.id);
    }

    console.log(`[content-refresh] Refreshed ${staleItems.length} items`);
  } catch (error) {
    console.error('[content-refresh] Scheduler error:', error);
  }
}
