/**
 * Admin: Daily Briefing items.
 *
 * Lists every daily-briefing entry across the active site with edit +
 * delete + publish toggles. The editing UI is a simple modal form —
 * sufficient for operators authoring the daily AI newsletter cards.
 * Mirrors the PressTab structure.
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
  listDailyBriefingItems,
  getDefaultSiteId,
  createDailyBriefingItem,
  updateDailyBriefingItem,
  deleteDailyBriefingItem,
  type DailyBriefingItem,
  type DailyBriefingItemInput,
} from '../utils/dailyBriefingService';

type DraftItem = Partial<DailyBriefingItem> & {
  title: string;
  summary: string;
  brief_date: string;
  source_label: string;
  source_href: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const EMPTY_DRAFT: DraftItem = {
  title: '',
  summary: '',
  brief_date: todayIso(),
  source_label: '',
  source_href: '',
  status: 'draft',
  is_pinned: false,
};

export default function DailyBriefingTab() {
  const [items, setItems] = useState<DailyBriefingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [modalItem, setModalItem] = useState<DraftItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingItem, setDeletingItem] = useState<DailyBriefingItem | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const site = await getDefaultSiteId();
      setSiteId(site);
      const rows = await listDailyBriefingItems(site ?? undefined);
      setItems(rows);
    } catch (err) {
      console.error('[daily-briefing] load failed', err);
      toast.error('Failed to load briefing items');
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setModalItem({ ...EMPTY_DRAFT, brief_date: todayIso() });
  }

  function openEdit(r: DailyBriefingItem) {
    setModalItem({ ...r });
  }

  async function handleSave() {
    if (!modalItem) return;
    if (!modalItem.title?.trim()) {
      toast.error('Title is required');
      return;
    }
    if (!modalItem.summary?.trim()) {
      toast.error('Summary is required');
      return;
    }
    if (!modalItem.brief_date) {
      toast.error('Brief date is required');
      return;
    }
    if (!modalItem.source_label?.trim()) {
      toast.error('Source label is required');
      return;
    }
    if (!modalItem.source_href?.trim()) {
      toast.error('Source URL is required');
      return;
    }
    if (!siteId) {
      toast.error('No site configured');
      return;
    }

    const patch: DailyBriefingItemInput = {
      site_id: siteId,
      title: modalItem.title.trim(),
      summary: modalItem.summary.trim(),
      brief_date: modalItem.brief_date,
      source_label: modalItem.source_label.trim(),
      source_href: modalItem.source_href.trim(),
      status: (modalItem.status ?? 'draft') as DailyBriefingItem['status'],
      is_pinned: Boolean(modalItem.is_pinned),
    };

    setSaving(true);
    try {
      if (modalItem.id) {
        await updateDailyBriefingItem(modalItem.id, patch);
        toast.success('Briefing item updated');
      } else {
        await createDailyBriefingItem(patch);
        toast.success('Briefing item created');
      }
      setModalItem(null);
      await load();
    } catch (err) {
      console.error('[daily-briefing] save failed', err);
      const msg = err instanceof Error ? err.message : 'Save failed';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deletingItem) return;
    try {
      await deleteDailyBriefingItem(deletingItem.id);
      toast.success(`Deleted ${deletingItem.title}`);
      setDeletingItem(null);
      await load();
    } catch (err) {
      console.error('[daily-briefing] delete failed', err);
      toast.error('Delete failed');
    }
  }

  async function togglePublish(r: DailyBriefingItem) {
    try {
      const next = r.status === 'published' ? 'draft' : 'published';
      await updateDailyBriefingItem(r.id, { status: next });
      toast.success(next === 'published' ? 'Published' : 'Unpublished');
      await load();
    } catch (err) {
      console.error('[daily-briefing] publish toggle failed', err);
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
          <h1 className="text-2xl font-semibold">Daily Briefing</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Short-form daily AI news cards rendered by the home-page Hero
            sidebar (&ldquo;Daily Agentic AI LinkedIn Newsletter&rdquo;).
            The theme fetches the most recent 3 published items.
          </p>
        </div>
        <Button onClick={openCreate} disabled={!siteId}>
          <PlusIcon className="size-4 mr-2" />
          New item
        </Button>
      </header>

      {items.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-neutral-500">
          No briefing items yet. Click <strong>New item</strong> to add one.
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50">
              <tr className="text-left">
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Pinned</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-t hover:bg-neutral-50">
                  <td className="px-4 py-2 text-neutral-500 font-mono text-xs">
                    {r.brief_date}
                  </td>
                  <td className="px-4 py-2 font-medium">{r.title}</td>
                  <td className="px-4 py-2 text-neutral-500">{r.source_label}</td>
                  <td className="px-4 py-2">
                    <Badge>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-2">{r.is_pinned ? 'Yes' : '—'}</td>
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
                        onClick={() => setDeletingItem(r)}
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

      {modalItem && (
        <Modal
          isOpen
          onClose={() => setModalItem(null)}
          title={modalItem.id ? `Edit ${modalItem.title}` : 'New briefing item'}
          size="lg"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setModalItem(null)} disabled={saving}>
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
                value={modalItem.title}
                onChange={(e) => setModalItem({ ...modalItem, title: e.target.value })}
              />
            </Field>
            <Field label="Summary" hint="1-2 sentence description for the card">
              <textarea
                className="form-input w-full"
                rows={3}
                value={modalItem.summary}
                onChange={(e) => setModalItem({ ...modalItem, summary: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Brief date" hint="Displayed as 'Apr 24, 2026'">
                <input
                  type="date"
                  className="form-input w-full"
                  value={modalItem.brief_date}
                  onChange={(e) =>
                    setModalItem({ ...modalItem, brief_date: e.target.value })
                  }
                />
              </Field>
              <Field label="Status">
                <select
                  className="form-input w-full"
                  value={modalItem.status ?? 'draft'}
                  onChange={(e) =>
                    setModalItem({
                      ...modalItem,
                      status: e.target.value as DailyBriefingItem['status'],
                    })
                  }
                >
                  <option value="draft">draft</option>
                  <option value="published">published</option>
                  <option value="archived">archived</option>
                </select>
              </Field>
              <Field label="Source label" hint='e.g. "Claude on X", "TechCrunch"'>
                <input
                  className="form-input w-full"
                  value={modalItem.source_label}
                  onChange={(e) =>
                    setModalItem({ ...modalItem, source_label: e.target.value })
                  }
                />
              </Field>
              <Field label="Source URL" hint="External link the card points to">
                <input
                  className="form-input w-full"
                  value={modalItem.source_href}
                  onChange={(e) =>
                    setModalItem({ ...modalItem, source_href: e.target.value })
                  }
                  placeholder="https://…"
                />
              </Field>
            </div>
            <Field label="Pinned" hint="Forces this item to the top regardless of date">
              <label className="inline-flex items-center gap-2 mt-2">
                <input
                  type="checkbox"
                  checked={Boolean(modalItem.is_pinned)}
                  onChange={(e) =>
                    setModalItem({ ...modalItem, is_pinned: e.target.checked })
                  }
                />
                <span className="text-sm text-neutral-600">Pin to top</span>
              </label>
            </Field>
          </div>
        </Modal>
      )}

      <ConfirmModal
        isOpen={Boolean(deletingItem)}
        onClose={() => setDeletingItem(null)}
        onConfirm={handleDelete}
        title="Delete briefing item"
        message={
          deletingItem
            ? `Permanently delete "${deletingItem.title}"? This cannot be undone.`
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
