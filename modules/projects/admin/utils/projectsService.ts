import { supabase } from '@/lib/supabase';

export interface Project {
  id: string;
  site_id: string;
  slug: string;
  title: string;
  short_description: string | null;
  long_description: string | null;
  logo_url: string | null;
  logo_alt: string | null;
  cover_image_url: string | null;
  website_url: string | null;
  github_url: string | null;
  docs_url: string | null;
  category: string | null;
  tags: string[];
  status: 'draft' | 'published' | 'archived';
  is_featured: boolean;
  sort_order: number;
  maintainer_org: string | null;
  license: string | null;
  founded_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ProjectInput = Partial<
  Omit<Project, 'id' | 'created_at' | 'updated_at'>
> & { site_id: string; title: string; slug: string };

export async function listProjects(siteId?: string): Promise<Project[]> {
  let query = supabase
    .from('projects')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('title', { ascending: true });
  if (siteId) query = query.eq('site_id', siteId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Project[];
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
 * Errors are swallowed (toast on the caller side is the surface); the
 * mutation itself has already succeeded by the time we get here.
 *
 * Hits the same admin/sites/:id/publish endpoint that SitePublishingTab
 * uses — same auth shape (Bearer access_token from the supabase session).
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
    console.warn('[projects] auto-republish trigger failed', err);
  }
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert(input)
    .select('*')
    .single();
  if (error) throw error;
  const row = data as Project;
  void triggerRepublish(row.site_id, `project-create:${row.slug}`);
  return row;
}

export async function updateProject(
  id: string,
  patch: Partial<ProjectInput>,
): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  const row = data as Project;
  void triggerRepublish(row.site_id, `project-update:${row.slug}`);
  return row;
}

export async function deleteProject(id: string): Promise<void> {
  // Fetch the row before deletion to know which site to republish.
  const { data: existing } = await supabase
    .from('projects')
    .select('site_id, slug')
    .eq('id', id)
    .maybeSingle();
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
  const e = existing as { site_id?: string; slug?: string } | null;
  if (e?.site_id) {
    void triggerRepublish(e.site_id, `project-delete:${e.slug ?? id}`);
  }
}
