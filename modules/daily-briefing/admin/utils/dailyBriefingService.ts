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
  // Single-tenant deployments (AAIF dev DB) have one row. Picking the
  // first ordered by created_at is deterministic and good enough until
  // the admin grows a site picker.
  const { data, error } = await supabase
    .from('sites')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { id?: string } | null)?.id ?? null;
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
  return data as DailyBriefingItem;
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
  return data as DailyBriefingItem;
}

export async function deleteDailyBriefingItem(id: string): Promise<void> {
  const { error } = await supabase
    .from('daily_briefing_items')
    .delete()
    .eq('id', id);
  if (error) throw error;
}
