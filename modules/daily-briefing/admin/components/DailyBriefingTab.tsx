/**
 * Admin: Daily Briefing (day-grouped).
 *
 * Each section is a single day (most recent first). Operators drag-drop
 * to reorder items within a day, and click "Generate image" to render
 * the cartoon-style cover the home page displays alongside that day's
 * cards.
 *
 * The public site shows the most-recent published day, capped at 3
 * items — the cap is enforced by the API; the admin can hold as many
 * items per day as operators want, but only the top three (by drag
 * order) actually appear on the front page.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  PencilIcon,
  TrashIcon,
  PlusIcon,
  EyeIcon,
  EyeSlashIcon,
  Bars3Icon,
  SparklesIcon,
  ArrowPathIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { toPublicUrl } from '@gatewaze/shared';

import { Button, Modal, Badge } from '@/components/ui';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  listDailyBriefingDays,
  listDailyBriefingItemsByDay,
  getDefaultSiteId,
  createDailyBriefingDay,
  updateDailyBriefingDay,
  deleteDailyBriefingDay,
  generateDailyBriefingDayImage,
  createDailyBriefingItem,
  updateDailyBriefingItem,
  deleteDailyBriefingItem,
  reorderDailyBriefingItems,
  type DailyBriefingDay,
  type DailyBriefingItem,
  type DailyBriefingStatus,
} from '../utils/dailyBriefingService';

type DayWithItems = DailyBriefingDay & { items: DailyBriefingItem[] };

// Storage paths are stored relative on the row; resolve to a public URL
// at read time using the same VITE_SUPABASE_URL-derived bucket the events
// admin uses (see gatewaze-modules/events/admin/utils/eventService.ts).
const BUCKET_URL = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/media`;

function coverUrl(day: Pick<DailyBriefingDay, 'image_storage_path'>): string | null {
  return toPublicUrl(day.image_storage_path, BUCKET_URL);
}

interface ItemDraft {
  id?: string;
  day_id: string;
  title: string;
  summary: string;
  source_label: string;
  source_href: string;
  status: DailyBriefingStatus;
}

interface DayDraft {
  id?: string;
  brief_date: string;
  status: DailyBriefingStatus;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const PUBLIC_LIMIT = 3;

export default function DailyBriefingTab() {
  const [days, setDays] = useState<DayWithItems[]>([]);
  const [loading, setLoading] = useState(true);
  const [siteId, setSiteId] = useState<string | null>(null);

  const [itemDraft, setItemDraft] = useState<ItemDraft | null>(null);
  const [dayDraft, setDayDraft] = useState<DayDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const [deletingItem, setDeletingItem] = useState<DailyBriefingItem | null>(null);
  const [deletingDay, setDeletingDay] = useState<DayWithItems | null>(null);

  const [generatingDayId, setGeneratingDayId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<DayWithItems | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const site = await getDefaultSiteId();
      setSiteId(site);
      const dayRows = await listDailyBriefingDays(site ?? undefined);
      const itemsByDay = await listDailyBriefingItemsByDay(dayRows.map((d) => d.id));
      setDays(
        dayRows.map((d) => ({ ...d, items: itemsByDay.get(d.id) ?? [] })),
      );
    } catch (err) {
      console.error('[daily-briefing] load failed', err);
      toast.error('Failed to load daily briefing');
    } finally {
      setLoading(false);
    }
  }

  // ── Day operations ──────────────────────────────────────────────────────

  function openCreateDay() {
    setDayDraft({ brief_date: todayIso(), status: 'draft' });
  }

  function openEditDay(d: DailyBriefingDay) {
    setDayDraft({ id: d.id, brief_date: d.brief_date, status: d.status });
  }

  async function handleSaveDay() {
    if (!dayDraft) return;
    if (!dayDraft.brief_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      toast.error('Brief date must be YYYY-MM-DD');
      return;
    }
    if (!siteId) {
      toast.error('No site configured');
      return;
    }
    setSaving(true);
    try {
      if (dayDraft.id) {
        await updateDailyBriefingDay(dayDraft.id, {
          brief_date: dayDraft.brief_date,
          status: dayDraft.status,
        });
        toast.success('Day updated');
      } else {
        await createDailyBriefingDay({
          site_id: siteId,
          brief_date: dayDraft.brief_date,
          status: dayDraft.status,
        });
        toast.success('Day created');
      }
      setDayDraft(null);
      await load();
    } catch (err) {
      console.error('[daily-briefing] save day failed', err);
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function toggleDayPublish(d: DayWithItems) {
    try {
      const next: DailyBriefingStatus = d.status === 'published' ? 'draft' : 'published';
      await updateDailyBriefingDay(d.id, { status: next });
      toast.success(next === 'published' ? 'Day published' : 'Day unpublished');
      await load();
    } catch (err) {
      console.error('[daily-briefing] toggle day publish failed', err);
      toast.error('Update failed');
    }
  }

  async function handleDeleteDay() {
    if (!deletingDay) return;
    try {
      await deleteDailyBriefingDay(deletingDay.id);
      toast.success('Day deleted');
      setDeletingDay(null);
      await load();
    } catch (err) {
      console.error('[daily-briefing] delete day failed', err);
      toast.error('Delete failed');
    }
  }

  async function handleGenerateImage(d: DayWithItems) {
    if (d.items.length === 0) {
      toast.error('Add at least one story before generating the cover image');
      return;
    }
    setGeneratingDayId(d.id);
    // Optimistic UI: show generating in the row immediately. The server
    // sets image_status='generating' too, so even if we reload mid-call
    // the row reflects state.
    setDays((prev) =>
      prev.map((row) =>
        row.id === d.id ? { ...row, image_status: 'generating' } : row,
      ),
    );
    try {
      const updated = await generateDailyBriefingDayImage(d.id);
      toast.success('Cover image generated');
      setDays((prev) =>
        prev.map((row) =>
          row.id === d.id ? { ...row, ...updated } : row,
        ),
      );
    } catch (err) {
      console.error('[daily-briefing] generate image failed', err);
      toast.error(err instanceof Error ? err.message : 'Image generation failed');
      // Reload to pick up the server's image_status='failed' + image_error.
      await load();
    } finally {
      setGeneratingDayId(null);
    }
  }

  // ── Item operations ─────────────────────────────────────────────────────

  function openCreateItem(dayId: string) {
    setItemDraft({
      day_id: dayId,
      title: '',
      summary: '',
      source_label: '',
      source_href: '',
      status: 'draft',
    });
  }

  function openEditItem(item: DailyBriefingItem) {
    setItemDraft({
      id: item.id,
      day_id: item.day_id,
      title: item.title,
      summary: item.summary,
      source_label: item.source_label,
      source_href: item.source_href,
      status: item.status,
    });
  }

  async function handleSaveItem() {
    if (!itemDraft) return;
    if (!itemDraft.title.trim()) return toast.error('Title is required');
    if (!itemDraft.summary.trim()) return toast.error('Summary is required');
    if (!itemDraft.source_label.trim()) return toast.error('Source label is required');
    if (!itemDraft.source_href.trim()) return toast.error('Source URL is required');

    setSaving(true);
    try {
      if (itemDraft.id) {
        await updateDailyBriefingItem(itemDraft.id, {
          title: itemDraft.title.trim(),
          summary: itemDraft.summary.trim(),
          source_label: itemDraft.source_label.trim(),
          source_href: itemDraft.source_href.trim(),
          status: itemDraft.status,
        });
        toast.success('Story updated');
      } else {
        await createDailyBriefingItem({
          day_id: itemDraft.day_id,
          title: itemDraft.title.trim(),
          summary: itemDraft.summary.trim(),
          source_label: itemDraft.source_label.trim(),
          source_href: itemDraft.source_href.trim(),
          status: itemDraft.status,
        });
        toast.success('Story added');
      }
      setItemDraft(null);
      await load();
    } catch (err) {
      console.error('[daily-briefing] save item failed', err);
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function toggleItemPublish(item: DailyBriefingItem) {
    try {
      const next: DailyBriefingStatus = item.status === 'published' ? 'draft' : 'published';
      await updateDailyBriefingItem(item.id, { status: next });
      await load();
    } catch (err) {
      console.error('[daily-briefing] toggle item publish failed', err);
      toast.error('Update failed');
    }
  }

  async function handleDeleteItem() {
    if (!deletingItem) return;
    try {
      await deleteDailyBriefingItem(deletingItem.id);
      toast.success('Story deleted');
      setDeletingItem(null);
      await load();
    } catch (err) {
      console.error('[daily-briefing] delete item failed', err);
      toast.error('Delete failed');
    }
  }

  // ── DnD: reorder items within a day ─────────────────────────────────────

  async function handleDragEnd(dayId: string, event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const day = days.find((d) => d.id === dayId);
    if (!day) return;
    const oldIndex = day.items.findIndex((i) => i.id === active.id);
    const newIndex = day.items.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Reorder locally for instant feedback, then patch display_order in
    // the new order. We renumber every item so the operator's drag is
    // captured exactly even if old values were clustered.
    const reordered = [...day.items];
    const [moved] = reordered.splice(oldIndex, 1);
    if (!moved) return;
    reordered.splice(newIndex, 0, moved);
    const patch = reordered.map((item, idx) => ({
      ...item,
      display_order: (idx + 1) * 1000,
    }));

    setDays((prev) =>
      prev.map((d) => (d.id === dayId ? { ...d, items: patch } : d)),
    );

    try {
      await reorderDailyBriefingItems(
        patch.map((i) => ({ id: i.id, display_order: i.display_order })),
      );
    } catch (err) {
      console.error('[daily-briefing] reorder failed', err);
      toast.error('Reorder failed; reloading');
      await load();
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

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
            One section per day, sorted by date (most recent first). Drag stories
            within a day to reorder; the public site shows the top {PUBLIC_LIMIT} of
            the most-recent published day alongside the day&apos;s cartoon cover image.
          </p>
        </div>
        <Button onClick={openCreateDay} disabled={!siteId}>
          <PlusIcon className="size-4 mr-2" />
          New day
        </Button>
      </header>

      {days.length === 0 ? (
        <div className="rounded-md border border-dashed p-10 text-center text-neutral-500">
          No days yet. Click <strong>New day</strong> to create today&apos;s briefing.
        </div>
      ) : (
        <div className="space-y-8">
          {days.map((day) => (
            <DaySection
              key={day.id}
              day={day}
              generating={generatingDayId === day.id}
              onEditDay={() => openEditDay(day)}
              onTogglePublish={() => toggleDayPublish(day)}
              onDeleteDay={() => setDeletingDay(day)}
              onGenerateImage={() => handleGenerateImage(day)}
              onPreviewImage={() => setPreviewImage(day)}
              onAddItem={() => openCreateItem(day.id)}
              onEditItem={openEditItem}
              onDeleteItem={setDeletingItem}
              onTogglePublishItem={toggleItemPublish}
              onDragEnd={(e) => handleDragEnd(day.id, e)}
            />
          ))}
        </div>
      )}

      {/* New / edit day modal */}
      {dayDraft && (
        <Modal
          isOpen
          onClose={() => setDayDraft(null)}
          title={dayDraft.id ? `Edit day ${dayDraft.brief_date}` : 'New day'}
          size="md"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDayDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSaveDay} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Field label="Brief date" hint="One day per date per site.">
              <input
                type="date"
                className="form-input w-full"
                value={dayDraft.brief_date}
                onChange={(e) => setDayDraft({ ...dayDraft, brief_date: e.target.value })}
              />
            </Field>
            <Field label="Status" hint="Published days appear on the front page.">
              <select
                className="form-input w-full"
                value={dayDraft.status}
                onChange={(e) =>
                  setDayDraft({
                    ...dayDraft,
                    status: e.target.value as DailyBriefingStatus,
                  })
                }
              >
                <option value="draft">draft</option>
                <option value="published">published</option>
                <option value="archived">archived</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}

      {/* New / edit item modal */}
      {itemDraft && (
        <Modal
          isOpen
          onClose={() => setItemDraft(null)}
          title={itemDraft.id ? `Edit ${itemDraft.title || 'story'}` : 'New story'}
          size="lg"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setItemDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSaveItem} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Field label="Title">
              <input
                className="form-input w-full"
                value={itemDraft.title}
                onChange={(e) => setItemDraft({ ...itemDraft, title: e.target.value })}
              />
            </Field>
            <Field label="Summary" hint="1–2 sentence description for the card">
              <textarea
                className="form-input w-full"
                rows={3}
                value={itemDraft.summary}
                onChange={(e) => setItemDraft({ ...itemDraft, summary: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Source label" hint='e.g. "Claude on X", "TechCrunch"'>
                <input
                  className="form-input w-full"
                  value={itemDraft.source_label}
                  onChange={(e) =>
                    setItemDraft({ ...itemDraft, source_label: e.target.value })
                  }
                />
              </Field>
              <Field label="Source URL">
                <input
                  className="form-input w-full"
                  value={itemDraft.source_href}
                  onChange={(e) =>
                    setItemDraft({ ...itemDraft, source_href: e.target.value })
                  }
                  placeholder="https://…"
                />
              </Field>
              <Field label="Status">
                <select
                  className="form-input w-full"
                  value={itemDraft.status}
                  onChange={(e) =>
                    setItemDraft({
                      ...itemDraft,
                      status: e.target.value as DailyBriefingStatus,
                    })
                  }
                >
                  <option value="draft">draft</option>
                  <option value="published">published</option>
                  <option value="archived">archived</option>
                </select>
              </Field>
            </div>
          </div>
        </Modal>
      )}

      {/* Image preview modal */}
      {previewImage && coverUrl(previewImage) && (
        <Modal
          isOpen
          onClose={() => setPreviewImage(null)}
          title={`Cover for ${previewImage.brief_date}`}
          size="lg"
        >
          <div className="space-y-3">
            <img
              src={coverUrl(previewImage) ?? ''}
              alt={`Daily briefing cover for ${previewImage.brief_date}`}
              className="w-full rounded-md border"
            />
            {previewImage.image_generated_at && (
              <p className="text-xs text-neutral-500">
                Generated {new Date(previewImage.image_generated_at).toLocaleString()}
              </p>
            )}
          </div>
        </Modal>
      )}

      <ConfirmModal
        show={Boolean(deletingItem)}
        onClose={() => setDeletingItem(null)}
        onConfirm={handleDeleteItem}
        title="Delete story"
        message={
          deletingItem ? `Permanently delete "${deletingItem.title}"?` : ''
        }
        confirmText="Delete"
        confirmVariant="danger"
      />
      <ConfirmModal
        show={Boolean(deletingDay)}
        onClose={() => setDeletingDay(null)}
        onConfirm={handleDeleteDay}
        title="Delete day"
        message={
          deletingDay
            ? `Permanently delete the ${deletingDay.brief_date} day and all ${deletingDay.items.length} of its stories?`
            : ''
        }
        confirmText="Delete day"
        confirmVariant="danger"
      />
    </div>
  );
}

// ─── Day section ────────────────────────────────────────────────────────────

function DaySection({
  day,
  generating,
  onEditDay,
  onTogglePublish,
  onDeleteDay,
  onGenerateImage,
  onPreviewImage,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onTogglePublishItem,
  onDragEnd,
}: {
  day: DayWithItems;
  generating: boolean;
  onEditDay: () => void;
  onTogglePublish: () => void;
  onDeleteDay: () => void;
  onGenerateImage: () => void;
  onPreviewImage: () => void;
  onAddItem: () => void;
  onEditItem: (item: DailyBriefingItem) => void;
  onDeleteItem: (item: DailyBriefingItem) => void;
  onTogglePublishItem: (item: DailyBriefingItem) => void;
  onDragEnd: (e: DragEndEvent) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const itemIds = useMemo(() => day.items.map((i) => i.id), [day.items]);

  return (
    <section className="rounded-lg border">
      <header className="flex items-start gap-4 p-4 border-b bg-neutral-50">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {coverUrl(day) ? (
            <button
              type="button"
              onClick={onPreviewImage}
              className="block size-16 rounded-md border overflow-hidden bg-neutral-100 shrink-0"
              title="Preview cover"
            >
              <img
                src={coverUrl(day) ?? ''}
                alt={`Cover for ${day.brief_date}`}
                className="size-full object-cover"
              />
            </button>
          ) : (
            <div className="size-16 rounded-md border border-dashed bg-neutral-100 grid place-items-center shrink-0">
              <PhotoIcon className="size-6 text-neutral-400" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tabular-nums">{day.brief_date}</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              {day.published_item_count} of {day.item_count} stories published
              {day.image_status === 'failed' && day.image_error && (
                <span className="ml-2 text-red-600">· image: {day.image_error}</span>
              )}
            </p>
          </div>
          <Badge>{day.status}</Badge>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onGenerateImage}
            disabled={generating || day.image_status === 'generating'}
            title={coverUrl(day) ? 'Regenerate cover image' : 'Generate cover image'}
          >
            {generating || day.image_status === 'generating' ? (
              <ArrowPathIcon className="size-4 animate-spin" />
            ) : (
              <SparklesIcon className="size-4" />
            )}
            <span className="ml-1.5 text-xs">
              {coverUrl(day) ? 'Regenerate' : 'Generate image'}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onTogglePublish}
            title={day.status === 'published' ? 'Unpublish day' : 'Publish day'}
          >
            {day.status === 'published' ? (
              <EyeSlashIcon className="size-4" />
            ) : (
              <EyeIcon className="size-4" />
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={onEditDay} title="Edit day">
            <PencilIcon className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onDeleteDay} title="Delete day">
            <TrashIcon className="size-4 text-red-600" />
          </Button>
        </div>
      </header>

      <div className="p-4 space-y-3">
        {day.items.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-neutral-500">
            No stories yet for this day.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {day.items.map((item, idx) => (
                  <SortableItemRow
                    key={item.id}
                    item={item}
                    showsPublicly={idx < PUBLIC_LIMIT && day.status === 'published' && item.status === 'published'}
                    onEdit={() => onEditItem(item)}
                    onTogglePublish={() => onTogglePublishItem(item)}
                    onDelete={() => onDeleteItem(item)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}

        <div className="flex justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onAddItem}>
            <PlusIcon className="size-4 mr-1" />
            Add story
          </Button>
        </div>
      </div>
    </section>
  );
}

// ─── Sortable item row ──────────────────────────────────────────────────────

function SortableItemRow({
  item,
  showsPublicly,
  onEdit,
  onTogglePublish,
  onDelete,
}: {
  item: DailyBriefingItem;
  showsPublicly: boolean;
  onEdit: () => void;
  onTogglePublish: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-md border bg-white px-3 py-2 hover:bg-neutral-50"
    >
      <button
        type="button"
        className="cursor-grab active:cursor-grabbing touch-none p-1 text-neutral-400 hover:text-neutral-600"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <Bars3Icon className="size-4" />
      </button>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{item.title}</div>
        <div className="text-xs text-neutral-500 truncate">
          {item.source_label} · {item.summary}
        </div>
      </div>
      {showsPublicly ? (
        <Badge title="This story is visible on the front page">on site</Badge>
      ) : (
        <Badge>{item.status}</Badge>
      )}
      <div className="inline-flex gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onTogglePublish}
          title={item.status === 'published' ? 'Unpublish' : 'Publish'}
        >
          {item.status === 'published' ? (
            <EyeSlashIcon className="size-4" />
          ) : (
            <EyeIcon className="size-4" />
          )}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit} title="Edit">
          <PencilIcon className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} title="Delete">
          <TrashIcon className="size-4 text-red-600" />
        </Button>
      </div>
    </li>
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
