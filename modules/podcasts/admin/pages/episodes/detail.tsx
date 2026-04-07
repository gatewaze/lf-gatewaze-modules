import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  PlusIcon,
  TrashIcon,
  PaperAirplaneIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import {
  EpisodesService,
  EpisodeGuestsService,
  GuestsService,
  PodcastsService,
  type PodcastEpisode,
  type EpisodeGuestWithDetails,
  type PodcastGuest,
  type Podcast,
} from '../../utils/podcastService';
import { Card, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { useContentCategories } from '@/hooks/useContentCategories';

export default function EpisodeDetailPage() {
  const { podcastId, episodeId } = useParams<{ podcastId: string; episodeId: string }>();
  const navigate = useNavigate();
  const [podcast, setPodcast] = useState<Podcast | null>(null);
  const [episode, setEpisode] = useState<PodcastEpisode | null>(null);
  const [assignedGuests, setAssignedGuests] = useState<EpisodeGuestWithDetails[]>([]);
  const [availableGuests, setAvailableGuests] = useState<PodcastGuest[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const { contentCategories } = useContentCategories();
  const [editForm, setEditForm] = useState<Partial<PodcastEpisode>>({});

  const loadData = useCallback(async () => {
    if (!podcastId || !episodeId) return;
    setLoading(true);
    try {
      const [podcastResult, episodeResult, guestsResult, allGuestsResult] = await Promise.all([
        PodcastsService.getById(podcastId),
        EpisodesService.getById(episodeId),
        EpisodeGuestsService.getByEpisode(episodeId),
        GuestsService.getAll({ podcast_id: podcastId, status: 'approved' }),
      ]);
      if (podcastResult.data) setPodcast(podcastResult.data);
      if (episodeResult.data) {
        setEpisode(episodeResult.data);
        setEditForm(episodeResult.data);
      }
      if (guestsResult.data) setAssignedGuests(guestsResult.data);
      if (allGuestsResult.data) setAvailableGuests(allGuestsResult.data);
    } catch (error) {
      console.error('Error loading episode:', error);
    } finally {
      setLoading(false);
    }
  }, [podcastId, episodeId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSave = async () => {
    if (!episodeId) return;
    setSaving(true);
    try {
      const { id, podcast_id, created_at, updated_at, guest_count, ...updates } = editForm as any;
      const result = await EpisodesService.update(episodeId, updates);
      if (result.success && result.data) {
        setEpisode(result.data);
        setEditForm(result.data);
      } else {
        alert(result.error || 'Failed to save');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleAssignGuest = async (guestId: string, role: string = 'guest') => {
    if (!episodeId) return;
    const result = await EpisodeGuestsService.assign(episodeId, guestId, role);
    if (result.success) {
      setShowAssignModal(false);
      loadData();
    } else {
      alert(result.error || 'Failed to assign guest');
    }
  };

  const handleUnassign = async (id: string, name: string) => {
    if (!confirm(`Remove ${name} from this episode?`)) return;
    const result = await EpisodeGuestsService.unassign(id);
    if (result.success) loadData();
  };

  const handleRoleChange = async (id: string, role: string) => {
    const result = await EpisodeGuestsService.updateRole(id, role);
    if (result.success) loadData();
  };

  const handleConfirm = async (id: string) => {
    const result = await EpisodeGuestsService.markConfirmed(id);
    if (result.success) loadData();
  };

  const handleSendNotification = async () => {
    if (!episodeId) return;
    if (!episode?.record_date) {
      alert('Please set a record date before sending notifications.');
      return;
    }
    if (assignedGuests.length === 0) {
      alert('No guests assigned to this episode.');
      return;
    }

    const recordDate = new Date(episode.record_date).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    if (!confirm(
      `Send recording date notification to ${assignedGuests.length} guest(s) for "${episode.title}" on ${recordDate}?`
    )) return;

    setNotifying(true);
    try {
      const result = await EpisodeGuestsService.sendRecordDateNotification(episodeId);
      if (result.success) {
        alert(result.message);
        loadData();
      } else {
        alert(result.error || 'Failed to send notifications');
      }
    } finally {
      setNotifying(false);
    }
  };

  // Guests not yet assigned to this episode
  const unassignedGuests = availableGuests.filter(
    (g) => !assignedGuests.some((ag) => ag.guest_id === g.id)
  );

  const statusOptions = ['draft', 'scheduled', 'recording', 'editing', 'published', 'archived'];

  if (loading) {
    return (
      <Page title="Episode">
        <div className="p-6 animate-pulse">
          <div className="h-8 bg-neutral-200 rounded mb-4 w-64" />
          <div className="h-4 bg-neutral-200 rounded mb-2 w-full" />
        </div>
      </Page>
    );
  }

  if (!episode) {
    return (
      <Page title="Episode">
        <div className="p-6">
          <p className="text-[var(--gray-a11)]">Episode not found.</p>
          <Button variant="outline" onClick={() => navigate(`/admin/podcasts/${podcastId}`)} className="mt-4">
            Back to Podcast
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page title={episode.title}>
      <div className="p-6">
        {/* Header */}
        <button
          onClick={() => navigate(`/admin/podcasts/${podcastId}`)}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-[var(--gray-a3)] border border-[var(--gray-a5)] text-[var(--gray-11)] hover:bg-[var(--gray-a4)] transition-colors mb-4"
        >
          <ArrowLeftIcon className="h-4 w-4" /> Back
        </button>

        {/* Episode Details Form */}
        <Card variant="surface" className="p-6 mb-6">
          <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Episode Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Title</label>
              <input
                type="text"
                value={editForm.title || ''}
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Episode Number</label>
              <input
                type="number"
                value={editForm.episode_number ?? ''}
                onChange={(e) => setEditForm({ ...editForm, episode_number: e.target.value ? parseInt(e.target.value) : null })}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Season</label>
              <input
                type="number"
                value={editForm.season ?? ''}
                onChange={(e) => setEditForm({ ...editForm, season: e.target.value ? parseInt(e.target.value) : null })}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Status</label>
              <select
                value={editForm.status || 'draft'}
                onChange={(e) => setEditForm({ ...editForm, status: e.target.value as any })}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
              >
                {statusOptions.map((s) => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Record Date</label>
              <input
                type="datetime-local"
                value={editForm.record_date ? new Date(editForm.record_date).toISOString().slice(0, 16) : ''}
                onChange={(e) => setEditForm({ ...editForm, record_date: e.target.value ? new Date(e.target.value).toISOString() : null })}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Publish Date</label>
              <input
                type="datetime-local"
                value={editForm.publish_date ? new Date(editForm.publish_date).toISOString().slice(0, 16) : ''}
                onChange={(e) => setEditForm({ ...editForm, publish_date: e.target.value ? new Date(e.target.value).toISOString() : null })}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Audio URL</label>
              <input
                type="url"
                value={editForm.audio_url || ''}
                onChange={(e) => setEditForm({ ...editForm, audio_url: e.target.value })}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Video URL</label>
              <input
                type="url"
                value={editForm.video_url || ''}
                onChange={(e) => setEditForm({ ...editForm, video_url: e.target.value })}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Description</label>
              <textarea
                value={editForm.description || ''}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                rows={3}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm resize-y"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Show Notes</label>
              <textarea
                value={editForm.show_notes || ''}
                onChange={(e) => setEditForm({ ...editForm, show_notes: e.target.value })}
                rows={4}
                className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm resize-y"
              />
            </div>
            {contentCategories.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Content Category</label>
                <select
                  value={(editForm as any).content_category || ''}
                  onChange={(e) => setEditForm({ ...editForm, content_category: e.target.value || null } as any)}
                  className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
                >
                  <option value="">No category</option>
                  {contentCategories.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="flex justify-end mt-4">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </Card>

        {/* Assigned Guests */}
        <Card variant="surface" className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">
              Assigned Guests ({assignedGuests.length})
            </h2>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleSendNotification}
                disabled={notifying || !episode.record_date || assignedGuests.length === 0}
              >
                <PaperAirplaneIcon className="h-4 w-4 mr-1" />
                {notifying ? 'Sending...' : 'Send Record Date Notification'}
              </Button>
              <Button onClick={() => setShowAssignModal(true)} disabled={unassignedGuests.length === 0}>
                <PlusIcon className="h-4 w-4 mr-1" /> Assign Guest
              </Button>
            </div>
          </div>

          {!episode.record_date && assignedGuests.length > 0 && (
            <div className="mb-4 p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-800">
              Set a record date above to enable sending notifications to assigned guests.
            </div>
          )}

          {assignedGuests.length === 0 ? (
            <p className="text-[var(--gray-a11)] text-sm">
              No guests assigned yet. Assign approved guests from the podcast's guest list.
            </p>
          ) : (
            <div className="space-y-2">
              {assignedGuests.map((ag) => (
                <div
                  key={ag.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)]"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--gray-12)]">{ag.guest_name}</span>
                      {ag.is_confirmed && (
                        <CheckCircleIcon className="h-4 w-4 text-green-600" />
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-sm text-[var(--gray-a11)]">
                      <span>{ag.guest_email}</span>
                      {ag.guest_company && <span>{ag.guest_company}</span>}
                      {ag.notified_at && (
                        <span className="text-green-600">
                          Notified {new Date(ag.notified_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={ag.role}
                      onChange={(e) => handleRoleChange(ag.id, e.target.value)}
                      className="text-xs rounded border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-2 py-1"
                    >
                      <option value="guest">Guest</option>
                      <option value="host">Host</option>
                      <option value="co-host">Co-host</option>
                      <option value="moderator">Moderator</option>
                    </select>
                    {!ag.is_confirmed && (
                      <Button variant="outline" size="sm" onClick={() => handleConfirm(ag.id)}>
                        Confirm
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      color="red"
                      size="sm"
                      onClick={() => handleUnassign(ag.id, ag.guest_name)}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Assign Guest Modal */}
        {showAssignModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <Card variant="surface" className="p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto">
              <h3 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Assign Guest to Episode</h3>
              <p className="text-sm text-[var(--gray-a11)] mb-4">
                Select an approved guest from the podcast's guest list.
              </p>

              {unassignedGuests.length === 0 ? (
                <p className="text-sm text-[var(--gray-a11)]">
                  No available guests. All approved guests are already assigned, or there are no approved guests yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {unassignedGuests.map((guest) => (
                    <div
                      key={guest.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-[var(--gray-a6)] hover:bg-[var(--gray-a3)] cursor-pointer"
                      onClick={() => handleAssignGuest(guest.id)}
                    >
                      <div>
                        <span className="font-medium text-[var(--gray-12)]">{guest.name}</span>
                        <div className="text-sm text-[var(--gray-a11)]">
                          {guest.email}
                          {guest.company && ` · ${guest.company}`}
                        </div>
                        {guest.topic_suggestions && (
                          <div className="text-xs text-[var(--gray-a9)] mt-1 truncate max-w-[350px]">
                            Topics: {guest.topic_suggestions}
                          </div>
                        )}
                      </div>
                      <PlusIcon className="h-5 w-5 text-[var(--gray-a9)]" />
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end mt-4">
                <Button variant="outline" onClick={() => setShowAssignModal(false)}>
                  Close
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>
    </Page>
  );
}
