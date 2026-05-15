/**
 * Admin-side client for the daily-briefing module's day-grouped REST
 * surface. Talks to the /api/modules/daily-briefing/admin/* endpoints
 * with the operator's bearer token.
 *
 * The platform's webhook layer-2 system fires revalidateTag on mutation
 * automatically (see daily-briefing/migrations/004_webhook_topics_days
 * + the webhooks module), so this client does NOT need to manually
 * trigger a republish after writes — that was the pattern in v1 before
 * the webhook fan-out shipped.
 */

import { supabase } from '@/lib/supabase';

export type DailyBriefingStatus = 'draft' | 'published' | 'archived';
export type DailyBriefingImageStatus = 'idle' | 'generating' | 'ready' | 'failed';
export type ResearchThreadStatus = 'idle' | 'running' | 'ready' | 'failed';

export interface DailyBriefingDay {
  id: string;
  site_id: string;
  brief_date: string; // YYYY-MM-DD
  status: DailyBriefingStatus;
  image_storage_path: string | null;
  image_prompt: string | null;
  image_generated_at: string | null;
  image_status: DailyBriefingImageStatus;
  image_error: string | null;
  created_at: string;
  updated_at: string;
  /** Hydrated by the admin list endpoint, NOT a column. */
  item_count: number;
  /** Hydrated by the admin list endpoint, NOT a column. */
  published_item_count: number;
  /** Hydrated from daily_briefing_research_threads; null when no thread exists yet. */
  research_status: ResearchThreadStatus | null;
  /** Last error from the autopilot, if any. */
  research_error: string | null;
}

export interface DailyBriefingItem {
  id: string;
  day_id: string;
  display_order: number;
  title: string;
  summary: string;
  source_label: string;
  source_href: string;
  status: DailyBriefingStatus;
  created_at: string;
  updated_at: string;
}

export interface DailyBriefingItemInput {
  day_id: string;
  title: string;
  summary: string;
  source_label: string;
  source_href: string;
  status?: DailyBriefingStatus;
  display_order?: number;
}

export interface DailyBriefingDayInput {
  site_id: string;
  brief_date: string;
  status?: DailyBriefingStatus;
}

function apiUrl(): string {
  return (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
}

async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.message) detail = body.message;
      else if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ── Days ────────────────────────────────────────────────────────────────────

export async function listDailyBriefingDays(
  siteId?: string,
): Promise<DailyBriefingDay[]> {
  const qs = siteId ? `?site_id=${encodeURIComponent(siteId)}` : '';
  const res = await authedFetch(`/api/modules/daily-briefing/admin/days${qs}`);
  const body = await jsonOrThrow<{ days: DailyBriefingDay[] }>(res);
  return body.days;
}

export async function createDailyBriefingDay(
  input: DailyBriefingDayInput,
): Promise<DailyBriefingDay> {
  const res = await authedFetch(`/api/modules/daily-briefing/admin/days`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow<DailyBriefingDay>(res);
}

export async function updateDailyBriefingDay(
  id: string,
  patch: Partial<Pick<DailyBriefingDay, 'brief_date' | 'status'>>,
): Promise<DailyBriefingDay> {
  const res = await authedFetch(`/api/modules/daily-briefing/admin/days/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<DailyBriefingDay>(res);
}

export async function deleteDailyBriefingDay(id: string): Promise<void> {
  const res = await authedFetch(`/api/modules/daily-briefing/admin/days/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

export async function generateDailyBriefingDayImage(
  id: string,
): Promise<DailyBriefingDay> {
  const res = await authedFetch(
    `/api/modules/daily-briefing/admin/days/${id}/generate-image`,
    { method: 'POST' },
  );
  return jsonOrThrow<DailyBriefingDay>(res);
}

// ── Items ───────────────────────────────────────────────────────────────────

/**
 * Lists items grouped by day. Each day's items are pre-sorted by
 * display_order ASC. Querying Supabase directly (admin RLS allows
 * authenticated SELECT). The API would just proxy the same query.
 */
export async function listDailyBriefingItemsByDay(
  dayIds: string[],
): Promise<Map<string, DailyBriefingItem[]>> {
  const grouped = new Map<string, DailyBriefingItem[]>();
  for (const id of dayIds) grouped.set(id, []);
  if (dayIds.length === 0) return grouped;

  const { data, error } = await supabase
    .from('daily_briefing_items')
    .select('*')
    .in('day_id', dayIds)
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  for (const row of (data ?? []) as DailyBriefingItem[]) {
    const arr = grouped.get(row.day_id);
    if (arr) arr.push(row);
  }
  return grouped;
}

export async function createDailyBriefingItem(
  input: DailyBriefingItemInput,
): Promise<DailyBriefingItem> {
  const res = await authedFetch(`/api/modules/daily-briefing/admin/items`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow<DailyBriefingItem>(res);
}

export async function updateDailyBriefingItem(
  id: string,
  patch: Partial<Omit<DailyBriefingItemInput, 'day_id'>>,
): Promise<DailyBriefingItem> {
  const res = await authedFetch(
    `/api/modules/daily-briefing/admin/items/${id}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return jsonOrThrow<DailyBriefingItem>(res);
}

export async function deleteDailyBriefingItem(id: string): Promise<void> {
  const res = await authedFetch(
    `/api/modules/daily-briefing/admin/items/${id}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

export async function reorderDailyBriefingItems(
  items: Array<{ id: string; display_order: number }>,
): Promise<void> {
  const res = await authedFetch(
    `/api/modules/daily-briefing/admin/items/reorder`,
    { method: 'POST', body: JSON.stringify({ items }) },
  );
  await jsonOrThrow<{ reordered: number }>(res);
}

// ── Research autopilot ──────────────────────────────────────────────────────

export interface ResearchCandidate {
  title: string;
  summary: string;
  source_label: string;
  source_href: string;
  why: string;
}

export interface ResearchThread {
  id: string;
  day_id: string;
  status: ResearchThreadStatus;
  last_error: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  updated_at: string;
}

export interface ResearchMessage {
  id: string;
  thread_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool_summary';
  content: string;
  candidates: ResearchCandidate[] | null;
  created_at: string;
}

export async function getResearchThread(
  dayId: string,
): Promise<{ thread: ResearchThread; messages: ResearchMessage[] }> {
  const res = await authedFetch(
    `/api/modules/daily-briefing/admin/days/${dayId}/research`,
  );
  return jsonOrThrow<{ thread: ResearchThread; messages: ResearchMessage[] }>(res);
}

export async function deleteResearchThread(dayId: string): Promise<void> {
  const res = await authedFetch(
    `/api/modules/daily-briefing/admin/days/${dayId}/research`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

/**
 * Send a message to the autopilot. Pass `message` empty/omitted to
 * trigger the autopilot kickoff (used by the auto-research entry).
 */
export async function postResearchMessage(
  dayId: string,
  message?: string,
): Promise<{ thread: ResearchThread; message: ResearchMessage }> {
  const res = await authedFetch(
    `/api/modules/daily-briefing/admin/days/${dayId}/research/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ message: message ?? '' }),
    },
  );
  return jsonOrThrow<{ thread: ResearchThread; message: ResearchMessage }>(res);
}

export async function approveResearchCandidate(
  dayId: string,
  messageId: string,
  candidateIndex: number,
): Promise<DailyBriefingItem> {
  const res = await authedFetch(
    `/api/modules/daily-briefing/admin/days/${dayId}/research/approve`,
    {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId, candidate_index: candidateIndex }),
    },
  );
  return jsonOrThrow<DailyBriefingItem>(res);
}

// ── Site picker ─────────────────────────────────────────────────────────────

export async function getDefaultSiteId(): Promise<string | null> {
  // Most-recently-created site (dev DBs accumulate stub rows).
  const { data, error } = await supabase
    .from('sites')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { id?: string } | null)?.id ?? null;
}
