import { supabase } from '@/lib/supabase';

export interface DailyBriefingItem {
  id: string;
  site_id: string;
  title: string;
  summary: string;
  brief_date: string; // ISO date 'YYYY-MM-DD'
  source_label: string;
  source_href: string;
  status: 'draft' | 'published' | 'archived';
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export type DailyBriefingItemInput = Partial<
  Omit<DailyBriefingItem, 'id' | 'created_at' | 'updated_at'>
> & {
  site_id: string;
  title: string;
  summary: string;
  brief_date: string;
  source_label: string;
  source_href: string;
};

export async function listDailyBriefingItems(
  siteId?: string,
): Promise<DailyBriefingItem[]> {
  let query = supabase
    .from('daily_briefing_items')
    .select('*')
    .order('is_pinned', { ascending: false })
    .order('brief_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (siteId) query = query.eq('site_id', siteId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as DailyBriefingItem[];
}

export async function getDefaultSiteId(): Promise<string | null> {
  // Pick the most-recently-created site. Dev DBs accumulate stub
  // "site one / two / three" rows from earlier testing; the actual
  // active site (AAIF) is the most recent one. Replace with a proper
  // site picker once the admin grows multi-site UX.
  const { data, error } = await supabase
    .from('sites')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Fire-and-forget republish trigger. Called after a successful mutation
 * so the published site picks up the change without a manual click.
 * Errors are swallowed; the mutation has already succeeded by then.
 */
async function triggerRepublish(siteId: string, reason: string): Promise<void> {
  try {
    const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    await fetch(`${apiUrl}/api/admin/sites/${siteId}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ reason, force: false }),
      keepalive: true,
    });
  } catch (err) {
    console.warn('[daily-briefing] auto-republish trigger failed', err);
  }
}

export async function createDailyBriefingItem(
  input: DailyBriefingItemInput,
): Promise<DailyBriefingItem> {
  const { data, error } = await supabase
    .from('daily_briefing_items')
    .insert(input)
    .select('*')
    .single();
  if (error) throw error;
  const row = data as DailyBriefingItem;
  void triggerRepublish(row.site_id, `daily-briefing-create:${row.brief_date}`);
  return row;
}

export async function updateDailyBriefingItem(
  id: string,
  patch: Partial<DailyBriefingItemInput>,
): Promise<DailyBriefingItem> {
  const { data, error } = await supabase
    .from('daily_briefing_items')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  const row = data as DailyBriefingItem;
  void triggerRepublish(row.site_id, `daily-briefing-update:${row.brief_date}`);
  return row;
}

export async function deleteDailyBriefingItem(id: string): Promise<void> {
  const { data: existing } = await supabase
    .from('daily_briefing_items')
    .select('site_id, brief_date')
    .eq('id', id)
    .maybeSingle();
  const { error } = await supabase
    .from('daily_briefing_items')
    .delete()
    .eq('id', id);
  if (error) throw error;
  const e = existing as { site_id?: string; brief_date?: string } | null;
  if (e?.site_id) {
    void triggerRepublish(e.site_id, `daily-briefing-delete:${e.brief_date ?? id}`);
  }
}
