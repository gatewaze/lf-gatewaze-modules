import { getApiBaseUrl } from '@/config/brands';

export interface MemberOrganization {
  id: string;
  name: string;
  slug: string;
  website_url: string | null;
  description: string | null;
  tier: string;
  tier_rank: number;
  logo_source_url: string | null;
  logo_url: string | null;
  logo_synced_at: string | null;
  source_url: string | null;
  last_synced_at: string | null;
  metadata: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MembershipTier {
  tier: string;
  rank: number;
  display_label: string;
  color: string | null;
  description: string | null;
  sort_order: number;
}

export interface SyncRun {
  id: string;
  source_url: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'canceled';
  members_seen: number;
  members_inserted: number;
  members_updated: number;
  members_deactivated: number;
  logos_downloaded: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

const base = () => getApiBaseUrl();

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}${input}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(body?.error?.message ?? r.statusText), {
      code: body?.error?.code ?? `http_${r.status}`,
      status: r.status,
    });
  }
  return r.json();
}

export const membershipService = {
  async listMembers(opts: { tier?: string; is_active?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.tier) q.set('tier', opts.tier);
    if (opts.is_active !== undefined) q.set('is_active', String(opts.is_active));
    const r = await jsonFetch<{ data: MemberOrganization[] }>(`/membership/members?${q}`);
    return r.data;
  },
  async createMember(payload: Partial<MemberOrganization>) {
    const r = await jsonFetch<{ data: MemberOrganization }>(`/membership/members`, {
      method: 'POST', body: JSON.stringify(payload),
    });
    return r.data;
  },
  async updateMember(id: string, patch: Partial<MemberOrganization>) {
    const r = await jsonFetch<{ data: MemberOrganization }>(`/membership/members/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    });
    return r.data;
  },
  async deleteMember(id: string) {
    await jsonFetch<void>(`/membership/members/${id}`, { method: 'DELETE' });
  },
  async listTiers() {
    const r = await jsonFetch<{ data: MembershipTier[] }>(`/membership/tiers`);
    return r.data;
  },
  async updateTier(tier: string, patch: Partial<MembershipTier>) {
    const r = await jsonFetch<{ data: MembershipTier }>(`/membership/tiers/${tier}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    });
    return r.data;
  },
  async runSync(sourceUrl?: string) {
    const r = await jsonFetch<{ data: { run_id: string; seen: number; inserted: number; updated: number; deactivated: number; logos: number } }>(
      `/membership/sync`,
      { method: 'POST', body: JSON.stringify({ source_url: sourceUrl }) },
    );
    return r.data;
  },
  async listSyncRuns() {
    const r = await jsonFetch<{ data: SyncRun[] }>(`/membership/sync/runs`);
    return r.data;
  },
};
