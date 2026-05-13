import { supabase } from '@/lib/supabase';

export interface PressRelease {
  id: string;
  site_id: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string | null;
  kind: 'release' | 'coverage' | 'announcement';
  publisher_name: string | null;
  publisher_logo_url: string | null;
  external_url: string | null;
  featured_image_url: string | null;
  featured_image_alt: string | null;
  tags: string[];
  status: 'draft' | 'published' | 'archived';
  is_featured: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PressReleaseInput = Partial<
  Omit<PressRelease, 'id' | 'created_at' | 'updated_at'>
> & { site_id: string; title: string; slug: string };

export async function listPressReleases(siteId?: string): Promise<PressRelease[]> {
  let query = supabase
    .from('press_releases')
    .select('*')
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('title', { ascending: true });
  if (siteId) query = query.eq('site_id', siteId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as PressRelease[];
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
    console.warn('[press] auto-republish trigger failed', err);
  }
}

export async function createPressRelease(input: PressReleaseInput): Promise<PressRelease> {
  const { data, error } = await supabase
    .from('press_releases')
    .insert(input)
    .select('*')
    .single();
  if (error) throw error;
  const row = data as PressRelease;
  void triggerRepublish(row.site_id, `press-create:${row.slug}`);
  return row;
}

export async function updatePressRelease(
  id: string,
  patch: Partial<PressReleaseInput>,
): Promise<PressRelease> {
  const { data, error } = await supabase
    .from('press_releases')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  const row = data as PressRelease;
  void triggerRepublish(row.site_id, `press-update:${row.slug}`);
  return row;
}

export async function deletePressRelease(id: string): Promise<void> {
  const { data: existing } = await supabase
    .from('press_releases')
    .select('site_id, slug')
    .eq('id', id)
    .maybeSingle();
  const { error } = await supabase.from('press_releases').delete().eq('id', id);
  if (error) throw error;
  const e = existing as { site_id?: string; slug?: string } | null;
  if (e?.site_id) {
    void triggerRepublish(e.site_id, `press-delete:${e.slug ?? id}`);
  }
}
