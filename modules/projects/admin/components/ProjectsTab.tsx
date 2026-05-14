/**
 * Admin: Projects portfolio.
 *
 * Lists every project across the active site with edit + delete + publish
 * affordances. The editing UI is a simple modal form — for now the
 * audience is operators, not designers. If/when the projects feature
 * grows ordering / inline images / rich text, this can graduate to a
 * dedicated page like blog/admin/pages/posts.
 */

import { useEffect, useState } from 'react';
import { PencilIcon, TrashIcon, PlusIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { Button, Modal, Badge } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  listProjects,
  getDefaultSiteId,
  createProject,
  updateProject,
  deleteProject,
  type Project,
  type ProjectInput,
} from '../utils/projectsService';

type DraftProject = Partial<Project> & { title: string; slug: string };

const EMPTY_DRAFT: DraftProject = {
  title: '',
  slug: '',
  status: 'draft',
  is_featured: false,
  sort_order: 0,
  tags: [],
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

export default function ProjectsTab() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [modalProject, setModalProject] = useState<DraftProject | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [tagsInput, setTagsInput] = useState('');

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const site = await getDefaultSiteId();
      setSiteId(site);
      const rows = await listProjects(site ?? undefined);
      setProjects(rows);
    } catch (err) {
      console.error('[projects] load failed', err);
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setModalProject({ ...EMPTY_DRAFT });
    setTagsInput('');
  }

  function openEdit(p: Project) {
    setModalProject({ ...p });
    setTagsInput((p.tags ?? []).join(', '));
  }

  async function handleSave() {
    if (!modalProject) return;
    if (!modalProject.title?.trim()) {
      toast.error('Title is required');
      return;
    }
    const slug = modalProject.slug?.trim() || slugify(modalProject.title);
    if (!slug) {
      toast.error('Slug is required');
      return;
    }
    if (!siteId) {
      toast.error('No site configured');
      return;
    }

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const patch: ProjectInput = {
      site_id: siteId,
      title: modalProject.title.trim(),
      slug,
      short_description: modalProject.short_description ?? null,
      long_description: modalProject.long_description ?? null,
      logo_url: modalProject.logo_url ?? null,
      logo_alt: modalProject.logo_alt ?? null,
      cover_image_url: modalProject.cover_image_url ?? null,
      website_url: modalProject.website_url ?? null,
      github_url: modalProject.github_url ?? null,
      docs_url: modalProject.docs_url ?? null,
      category: modalProject.category ?? null,
      tags,
      status: (modalProject.status ?? 'draft') as Project['status'],
      is_featured: Boolean(modalProject.is_featured),
      sort_order: Number(modalProject.sort_order ?? 0) || 0,
      maintainer_org: modalProject.maintainer_org ?? null,
      license: modalProject.license ?? null,
      founded_at: modalProject.founded_at ?? null,
    };

    setSaving(true);
    try {
      if (modalProject.id) {
        await updateProject(modalProject.id, patch);
        toast.success('Project updated');
      } else {
        await createProject(patch);
        toast.success('Project created');
      }
      setModalProject(null);
      await load();
    } catch (err) {
      console.error('[projects] save failed', err);
      const msg = err instanceof Error ? err.message : 'Save failed';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deletingProject) return;
    try {
      await deleteProject(deletingProject.id);
      toast.success(`Deleted ${deletingProject.title}`);
      setDeletingProject(null);
      await load();
    } catch (err) {
      console.error('[projects] delete failed', err);
      toast.error('Delete failed');
    }
  }

  async function togglePublish(p: Project) {
    try {
      const next = p.status === 'published' ? 'draft' : 'published';
      await updateProject(p.id, { status: next });
      toast.success(next === 'published' ? 'Published' : 'Unpublished');
      await load();
    } catch (err) {
      console.error('[projects] publish toggle failed', err);
      toast.error('Update failed');
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Open-source / standards projects rendered by the home-page ProjectsSection.
          </p>
        </div>
        <Button onClick={openCreate} disabled={!siteId}>
          <PlusIcon className="size-4 mr-2" />
          New project
        </Button>
      </header>

      {projects.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-neutral-500">
          No projects yet. Click <strong>New project</strong> to add one.
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50">
              <tr className="text-left">
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Slug</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Featured</th>
                <th className="px-4 py-2">Order</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-t hover:bg-neutral-50">
                  <td className="px-4 py-2 font-medium">{p.title}</td>
                  <td className="px-4 py-2 text-neutral-500 font-mono text-xs">{p.slug}</td>
                  <td className="px-4 py-2">{p.category ?? '—'}</td>
                  <td className="px-4 py-2">
                    <Badge>{p.status}</Badge>
                  </td>
                  <td className="px-4 py-2">{p.is_featured ? 'Yes' : '—'}</td>
                  <td className="px-4 py-2">{p.sort_order}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => togglePublish(p)}
                        title={p.status === 'published' ? 'Unpublish' : 'Publish'}
                      >
                        {p.status === 'published' ? (
                          <EyeSlashIcon className="size-4" />
                        ) : (
                          <EyeIcon className="size-4" />
                        )}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)} title="Edit">
                        <PencilIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeletingProject(p)}
                        title="Delete"
                      >
                        <TrashIcon className="size-4 text-red-600" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalProject && (
        <Modal
          isOpen
          onClose={() => setModalProject(null)}
          title={modalProject.id ? `Edit ${modalProject.title}` : 'New project'}
          size="lg"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setModalProject(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Field label="Title">
              <input
                className="form-input w-full"
                value={modalProject.title}
                onChange={(e) =>
                  setModalProject({ ...modalProject, title: e.target.value })
                }
              />
            </Field>
            <Field label="Slug" hint="url-safe; auto-generated from title if empty">
              <input
                className="form-input w-full font-mono"
                value={modalProject.slug}
                onChange={(e) =>
                  setModalProject({ ...modalProject, slug: e.target.value })
                }
                placeholder={slugify(modalProject.title || '')}
              />
            </Field>
            <Field label="Short description" hint="1-line summary for cards">
              <textarea
                className="form-input w-full"
                rows={2}
                value={modalProject.short_description ?? ''}
                onChange={(e) =>
                  setModalProject({ ...modalProject, short_description: e.target.value })
                }
              />
            </Field>
            <Field label="Long description" hint="Markdown for the detail page">
              <textarea
                className="form-input w-full font-mono text-xs"
                rows={6}
                value={modalProject.long_description ?? ''}
                onChange={(e) =>
                  setModalProject({ ...modalProject, long_description: e.target.value })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Logo URL">
                <input
                  className="form-input w-full"
                  value={modalProject.logo_url ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, logo_url: e.target.value })
                  }
                />
              </Field>
              <Field label="Logo alt">
                <input
                  className="form-input w-full"
                  value={modalProject.logo_alt ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, logo_alt: e.target.value })
                  }
                />
              </Field>
              <Field label="Website URL">
                <input
                  className="form-input w-full"
                  value={modalProject.website_url ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, website_url: e.target.value })
                  }
                />
              </Field>
              <Field label="GitHub URL">
                <input
                  className="form-input w-full"
                  value={modalProject.github_url ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, github_url: e.target.value })
                  }
                />
              </Field>
              <Field label="Docs URL">
                <input
                  className="form-input w-full"
                  value={modalProject.docs_url ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, docs_url: e.target.value })
                  }
                />
              </Field>
              <Field label="Cover image URL">
                <input
                  className="form-input w-full"
                  value={modalProject.cover_image_url ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, cover_image_url: e.target.value })
                  }
                />
              </Field>
              <Field label="Category">
                <input
                  className="form-input w-full"
                  value={modalProject.category ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, category: e.target.value })
                  }
                  placeholder="protocol, tooling, agent-runtime…"
                />
              </Field>
              <Field label="Maintainer org">
                <input
                  className="form-input w-full"
                  value={modalProject.maintainer_org ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, maintainer_org: e.target.value })
                  }
                />
              </Field>
              <Field label="License (SPDX)">
                <input
                  className="form-input w-full"
                  value={modalProject.license ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, license: e.target.value })
                  }
                  placeholder="Apache-2.0 / MIT / …"
                />
              </Field>
              <Field label="Founded">
                <input
                  type="date"
                  className="form-input w-full"
                  value={modalProject.founded_at ?? ''}
                  onChange={(e) =>
                    setModalProject({ ...modalProject, founded_at: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="Tags" hint="comma-separated">
              <input
                className="form-input w-full"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="spec, agent-runtime, …"
              />
            </Field>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Status">
                <select
                  className="form-input w-full"
                  value={modalProject.status ?? 'draft'}
                  onChange={(e) =>
                    setModalProject({
                      ...modalProject,
                      status: e.target.value as Project['status'],
                    })
                  }
                >
                  <option value="draft">draft</option>
                  <option value="published">published</option>
                  <option value="archived">archived</option>
                </select>
              </Field>
              <Field label="Sort order">
                <input
                  type="number"
                  className="form-input w-full"
                  value={modalProject.sort_order ?? 0}
                  onChange={(e) =>
                    setModalProject({
                      ...modalProject,
                      sort_order: parseInt(e.target.value, 10) || 0,
                    })
                  }
                />
              </Field>
              <Field label="Featured">
                <label className="inline-flex items-center gap-2 mt-2">
                  <input
                    type="checkbox"
                    checked={Boolean(modalProject.is_featured)}
                    onChange={(e) =>
                      setModalProject({ ...modalProject, is_featured: e.target.checked })
                    }
                  />
                  <span className="text-sm text-neutral-600">Featured project</span>
                </label>
              </Field>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmModal
        isOpen={Boolean(deletingProject)}
        onClose={() => setDeletingProject(null)}
        onConfirm={handleDelete}
        title="Delete project"
        message={
          deletingProject
            ? `Permanently delete "${deletingProject.title}"? This cannot be undone.`
            : ''
        }
        confirmText="Delete"
        confirmColor="red"
      />
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-neutral-700 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-neutral-500 mt-1">{hint}</span>}
    </label>
  );
}
