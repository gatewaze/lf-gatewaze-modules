/**
 * Discovery Scheduler
 *
 * Runs on a cron schedule (hourly) to check which discovery sources
 * are due for a check and enqueues discovery jobs for each.
 *
 * This integrates with the existing scheduler module infrastructure.
 */

import { supabase } from '@/lib/supabase';

export default async function discoveryScheduler() {
  console.log('[content-discovery] Running scheduled discovery check');

  try {
    // Find all active sources that are due for a check
    // A source is "due" if last_checked_at + check_frequency < now()
    const { data: sources, error } = await supabase
      .from('content_discovery_sources')
      .select('*')
      .eq('is_active', true);

    if (error) {
      console.error('[content-discovery] Failed to fetch sources:', error);
      return;
    }

    if (!sources || sources.length === 0) {
      console.log('[content-discovery] No active sources to check');
      return;
    }

    const now = new Date();
    let enqueued = 0;

    for (const source of sources) {
      const lastChecked = source.last_checked_at ? new Date(source.last_checked_at) : new Date(0);
      const frequencyMs = parseInterval(source.check_frequency);
      const nextCheck = new Date(lastChecked.getTime() + frequencyMs);

      if (now >= nextCheck) {
        // This source is due — create a discovery job
        // The BullMQ worker will pick this up
        console.log(`[content-discovery] Source "${source.name}" is due for check`);

        // Create a discovery run directly (in production, this would enqueue a BullMQ job)
        const { error: runError } = await supabase
          .from('content_discovery_runs')
          .insert({
            source_id: source.id,
            status: 'running',
          });

        if (!runError) {
          enqueued++;
        }
      }
    }

    console.log(`[content-discovery] Enqueued ${enqueued} discovery jobs`);
  } catch (error) {
    console.error('[content-discovery] Scheduler error:', error);
  }
}

/**
 * Parse a PostgreSQL interval string to milliseconds.
 */
function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)\s*(hour|hours|day|days|minute|minutes)$/i);
  if (!match) {
    // Default to 6 hours
    return 6 * 60 * 60 * 1000;
  }

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'minute':
    case 'minutes':
      return value * 60 * 1000;
    case 'hour':
    case 'hours':
      return value * 60 * 60 * 1000;
    case 'day':
    case 'days':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 6 * 60 * 60 * 1000;
  }
}
