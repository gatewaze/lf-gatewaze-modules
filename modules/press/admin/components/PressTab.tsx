/**
 * Admin: Press releases & coverage.
 *
 * Lists every press release/coverage entry across the active site with
 * edit + delete + publish toggles. The editing UI is a simple modal form
 * — sufficient for operators authoring releases and pasting external
 * coverage links. Mirrors the ProjectsTab structure.
 */

import { useEffect, useState } from 'react';
import {
  PencilIcon,
  TrashIcon,
  PlusIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import { Button, Modal, Badge } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  listPressReleases,
  getDefaultSiteId,
  createPressRelease,
  updatePressRelease,
  deletePressRelease,
  type PressRelease,
  type PressReleaseInput,
} from '../utils/pressService';

type DraftRelease = Partial<PressRelease> & { title: string; slug: string };

const EMPTY_DRAFT: DraftRelease = {
  title: '',
  slug: '',
  kind: 'release',
  status: 'draft',
  is_featured: false,
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

export default function PressTab() {
  const [releases, setReleases] = useState<PressRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [modalRelease, setModalRelease] = useState<DraftRelease | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingRelease, setDeletingRelease] = useState<PressRelease | null>(null);
  const [tagsInput, setTagsInput] = useState('');

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const site = await getDefaultSiteId();
      setSiteId(site);
      const rows = await listPressReleases(site ?? undefined);
      setReleases(rows);
    } catch (err) {
      console.error('[press] load failed', err);
      toast.error('Failed to load press releases');
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setModalRelease({ ...EMPTY_DRAFT });
    setTagsInput('');
  }

  function openEdit(r: PressRelease) {
    setModalRelease({ ...r });
    setTagsInput((r.tags ?? []).join(', '));
  }

  async function handleSave() {
    if (!modalRelease) return;
    if (!modalRelease.title?.trim()) {
      toast.error('Title is required');
      return;
    }
    const slug = modalRelease.slug?.trim() || slugify(modalRelease.title);
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

    const patch: PressReleaseInput = {
      site_id: siteId,
      title: modalRelease.title.trim(),
      slug,
      summary: modalRelease.summary ?? null,
      body: modalRelease.body ?? null,
      kind: (modalRelease.kind ?? 'release') as PressRelease['kind'],
      publisher_name: modalRelease.publisher_name ?? null,
      publisher_logo_url: modalRelease.publisher_logo_url ?? null,
      external_url: modalRelease.external_url ?? null,
      featured_image_url: modalRelease.featured_image_url ?? null,
      featured_image_alt: modalRelease.featured_image_alt ?? null,
      tags,
      status: (modalRelease.status ?? 'draft') as PressRelease['status'],
      is_featured: Boolean(modalRelease.is_featured),
      published_at: modalRelease.published_at ?? null,
    };

    setSaving(true);
    try {
      if (modalRelease.id) {
        await updatePressRelease(modalRelease.id, patch);
        toast.success('Press release updated');
      } else {
        await createPressRelease(patch);
        toast.success('Press release created');
      }
      setModalRelease(null);
      await load();
    } catch (err) {
      console.error('[press] save failed', err);
      const msg = err instanceof Error ? err.message : 'Save failed';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deletingRelease) return;
    try {
      await deletePressRelease(deletingRelease.id);
      toast.success(`Deleted ${deletingRelease.title}`);
      setDeletingRelease(null);
      await load();
    } catch (err) {
      console.error('[press] delete failed', err);
      toast.error('Delete failed');
    }
  }

  async function togglePublish(r: PressRelease) {
    try {
      const next = r.status === 'published' ? 'draft' : 'published';
      await updatePressRelease(r.id, { status: next });
      toast.success(next === 'published' ? 'Published' : 'Unpublished');
      await load();
    } catch (err) {
      console.error('[press] publish toggle failed', err);
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
          <h1 className="text-2xl font-semibold">Press</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Press releases authored here, plus external coverage that links out.
            Renders on the home-page WrittenContentHub Press &amp; News tab.
          </p>
        </div>
        <Button onClick={openCreate} disabled={!siteId}>
          <PlusIcon className="size-4 mr-2" />
          New entry
        </Button>
      </header>

      {releases.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-neutral-500">
          No press releases yet. Click <strong>New entry</strong> to add one.
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50">
              <tr className="text-left">
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Slug</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Publisher</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Featured</th>
                <th className="px-4 py-2">Published</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id} className="border-t hover:bg-neutral-50">
                  <td className="px-4 py-2 font-medium">{r.title}</td>
                  <td className="px-4 py-2 text-neutral-500 font-mono text-xs">{r.slug}</td>
                  <td className="px-4 py-2">{r.kind}</td>
                  <td className="px-4 py-2">{r.publisher_name ?? '—'}</td>
                  <td className="px-4 py-2">
                    <Badge>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-2">{r.is_featured ? 'Yes' : '—'}</td>
                  <td className="px-4 py-2 text-neutral-500">
                    {r.published_at ? new Date(r.published_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => togglePublish(r)}
                        title={r.status === 'published' ? 'Unpublish' : 'Publish'}
                      >
                        {r.status === 'published' ? (
                          <EyeSlashIcon className="size-4" />
                        ) : (
                          <EyeIcon className="size-4" />
                        )}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(r)} title="Edit">
                        <PencilIcon className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeletingRelease(r)}
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

      {modalRelease && (
        <Modal
          isOpen
          onClose={() => setModalRelease(null)}
          title={modalRelease.id ? `Edit ${modalRelease.title}` : 'New press entry'}
          size="lg"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setModalRelease(null)} disabled={saving}>
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
                value={modalRelease.title}
                onChange={(e) =>
                  setModalRelease({ ...modalRelease, title: e.target.value })
                }
              />
            </Field>
            <Field label="Slug" hint="url-safe; auto-generated from title if empty">
              <input
                className="form-input w-full font-mono"
                value={modalRelease.slug}
                onChange={(e) =>
                  setModalRelease({ ...modalRelease, slug: e.target.value })
                }
                placeholder={slugify(modalRelease.title || '')}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Kind">
                <select
                  className="form-input w-full"
                  value={modalRelease.kind ?? 'release'}
                  onChange={(e) =>
                    setModalRelease({
                      ...modalRelease,
                      kind: e.target.value as PressRelease['kind'],
                    })
                  }
                >
                  <option value="release">release</option>
                  <option value="announcement">announcement</option>
                  <option value="coverage">coverage</option>
                </select>
              </Field>
              <Field label="Published at">
                <input
                  type="date"
                  className="form-input w-full"
                  value={modalRelease.published_at?.slice(0, 10) ?? ''}
                  onChange={(e) =>
                    setModalRelease({
                      ...modalRelease,
                      published_at: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : null,
                    })
                  }
                />
              </Field>
            </div>
            <Field label="Summary" hint="1-line description for cards">
              <textarea
                className="form-input w-full"
                rows={2}
                value={modalRelease.summary ?? ''}
                onChange={(e) =>
                  setModalRelease({ ...modalRelease, summary: e.target.value })
                }
              />
            </Field>
            <Field
              label="Body"
              hint="Markdown for the detail page. Leave empty for kind='coverage' (the card links out to external URL)."
            >
              <textarea
                className="form-input w-full font-mono text-xs"
                rows={8}
                value={modalRelease.body ?? ''}
                onChange={(e) =>
                  setModalRelease({ ...modalRelease, body: e.target.value })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Publisher name" hint='e.g. "AAIF", "TechCrunch"'>
                <input
                  className="form-input w-full"
                  value={modalRelease.publisher_name ?? ''}
                  onChange={(e) =>
                    setModalRelease({ ...modalRelease, publisher_name: e.target.value })
                  }
                />
              </Field>
              <Field label="Publisher logo URL">
                <input
                  className="form-input w-full"
                  value={modalRelease.publisher_logo_url ?? ''}
                  onChange={(e) =>
                    setModalRelease({ ...modalRelease, publisher_logo_url: e.target.value })
                  }
                />
              </Field>
              <Field label="External URL" hint="Source article (kind='coverage')">
                <input
                  className="form-input w-full"
                  value={modalRelease.external_url ?? ''}
                  onChange={(e) =>
                    setModalRelease({ ...modalRelease, external_url: e.target.value })
                  }
                />
              </Field>
              <Field label="Featured image URL">
                <input
                  className="form-input w-full"
                  value={modalRelease.featured_image_url ?? ''}
                  onChange={(e) =>
                    setModalRelease({ ...modalRelease, featured_image_url: e.target.value })
                  }
                />
              </Field>
              <Field label="Featured image alt">
                <input
                  className="form-input w-full"
                  value={modalRelease.featured_image_alt ?? ''}
                  onChange={(e) =>
                    setModalRelease({ ...modalRelease, featured_image_alt: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field label="Tags" hint="comma-separated">
              <input
                className="form-input w-full"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="foundation, launch, …"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Status">
                <select
                  className="form-input w-full"
                  value={modalRelease.status ?? 'draft'}
                  onChange={(e) =>
                    setModalRelease({
                      ...modalRelease,
                      status: e.target.value as PressRelease['status'],
                    })
                  }
                >
                  <option value="draft">draft</option>
                  <option value="published">published</option>
                  <option value="archived">archived</option>
                </select>
              </Field>
              <Field label="Featured">
                <label className="inline-flex items-center gap-2 mt-2">
                  <input
                    type="checkbox"
                    checked={Boolean(modalRelease.is_featured)}
                    onChange={(e) =>
                      setModalRelease({ ...modalRelease, is_featured: e.target.checked })
                    }
                  />
                  <span className="text-sm text-neutral-600">Featured entry</span>
                </label>
              </Field>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmModal
        isOpen={Boolean(deletingRelease)}
        onClose={() => setDeletingRelease(null)}
        onConfirm={handleDelete}
        title="Delete press entry"
        message={
          deletingRelease
            ? `Permanently delete "${deletingRelease.title}"? This cannot be undone.`
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
