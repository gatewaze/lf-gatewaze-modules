import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
} from '@heroicons/react/24/outline';
import {
  PodcastsService,
  EpisodesService,
  GuestsService,
  generateSlug,
  type Podcast,
  type PodcastEpisode,
  type PodcastGuest,
} from '../utils/podcastService';
import { Card, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';

type Tab = 'episodes' | 'guests';

export default function PodcastDetailPage() {
  const { podcastId } = useParams<{ podcastId: string }>();
  const navigate = useNavigate();
  const [podcast, setPodcast] = useState<Podcast | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [guests, setGuests] = useState<PodcastGuest[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('episodes');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Podcast>>({});

  const loadData = useCallback(async () => {
    if (!podcastId) return;
    setLoading(true);
    try {
      const [podcastResult, episodesResult, guestsResult] = await Promise.all([
        PodcastsService.getById(podcastId),
        EpisodesService.getByPodcast(podcastId),
        GuestsService.getAll({ podcast_id: podcastId }),
      ]);
      if (podcastResult.data) {
        setPodcast(podcastResult.data);
        setEditForm(podcastResult.data);
      }
      if (episodesResult.data) setEpisodes(episodesResult.data);
      if (guestsResult.data) setGuests(guestsResult.data);
    } catch (error) {
      console.error('Error loading podcast:', error);
    } finally {
      setLoading(false);
    }
  }, [podcastId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSave = async () => {
    if (!podcastId) return;
    const result = await PodcastsService.update(podcastId, editForm);
    if (result.success && result.data) {
      setPodcast(result.data);
      setEditing(false);
    } else {
      alert(result.error || 'Failed to update podcast');
    }
  };

  const handleCreateEpisode = async () => {
    const title = prompt('Episode title:');
    if (!title || !podcastId) return;

    const result = await EpisodesService.create({ podcast_id: podcastId, title });
    if (result.success && result.data) {
      navigate(`/admin/podcasts/${podcastId}/episodes/${result.data.id}`);
    } else {
      alert(result.error || 'Failed to create episode');
    }
  };

  const handleDeleteEpisode = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation();
    if (!confirm(`Delete episode "${title}"?`)) return;
    const result = await EpisodesService.delete(id);
    if (result.success) loadData();
  };

  const handleAddGuest = async () => {
    const name = prompt('Guest name:');
    if (!name) return;
    const email = prompt('Guest email:');
    if (!email) return;

    const result = await GuestsService.create({
      podcast_id: podcastId,
      name,
      email,
      source: 'manual',
    });
    if (result.success) {
      loadData();
    } else {
      alert(result.error || 'Failed to add guest');
    }
  };

  const handleGuestStatusChange = async (id: string, status: string) => {
    const result = await GuestsService.updateStatus(id, status);
    if (result.success) loadData();
  };

  const handleDeleteGuest = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (!confirm(`Remove "${name}" from the guest list?`)) return;
    const result = await GuestsService.delete(id);
    if (result.success) loadData();
  };

  const statusColors: Record<string, string> = {
    draft: 'gray',
    scheduled: 'blue',
    recording: 'orange',
    editing: 'yellow',
    published: 'green',
    archived: 'gray',
  };

  const guestStatusColors: Record<string, string> = {
    pending: 'yellow',
    approved: 'green',
    declined: 'red',
    contacted: 'blue',
    archived: 'gray',
  };

  if (loading) {
    return (
      <Page title="Podcast">
        <div className="p-6 animate-pulse">
          <div className="h-8 bg-neutral-200 rounded mb-4 w-64" />
          <div className="h-4 bg-neutral-200 rounded mb-2 w-full" />
        </div>
      </Page>
    );
  }

  if (!podcast) {
    return (
      <Page title="Podcast">
        <div className="p-6">
          <p className="text-[var(--gray-a11)]">Podcast not found.</p>
          <Button variant="outline" onClick={() => navigate('/admin/podcasts')} className="mt-4">
            Back to Podcasts
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page title={podcast.name}>
      <div className="p-6">
        {/* Header */}
        <Button variant="ghost" color="gray" onClick={() => navigate('/admin/podcasts')} className="mb-4">
          <ArrowLeftIcon className="h-4 w-4 mr-1" /> Back to Podcasts
        </Button>

        {/* Podcast Info */}
        <Card variant="surface" className="p-6 mb-6">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-4">
              {podcast.cover_image_url ? (
                <img src={podcast.cover_image_url} alt="" className="w-16 h-16 rounded object-cover" />
              ) : (
                <div className="w-16 h-16 rounded bg-[var(--gray-a4)] flex items-center justify-center text-2xl">
                  🎙️
                </div>
              )}
              <div>
                <h1 className="text-2xl font-semibold text-[var(--gray-12)]">{podcast.name}</h1>
                <p className="text-sm text-[var(--gray-a11)]">/{podcast.slug}</p>
              </div>
            </div>
            <Button variant="outline" onClick={() => setEditing(!editing)}>
              <PencilIcon className="h-4 w-4 mr-1" /> {editing ? 'Cancel' : 'Edit'}
            </Button>
          </div>

          {editing && (
            <div className="space-y-4 border-t border-[var(--gray-a6)] pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Name</label>
                  <input
                    type="text"
                    value={editForm.name || ''}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value, slug: generateSlug(e.target.value) })}
                    className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Slug</label>
                  <input
                    type="text"
                    value={editForm.slug || ''}
                    onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })}
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
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Cover Image URL</label>
                  <input
                    type="url"
                    value={editForm.cover_image_url || ''}
                    onChange={(e) => setEditForm({ ...editForm, cover_image_url: e.target.value })}
                    className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">RSS Feed URL</label>
                  <input
                    type="url"
                    value={editForm.rss_feed_url || ''}
                    onChange={(e) => setEditForm({ ...editForm, rss_feed_url: e.target.value })}
                    className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Website URL</label>
                  <input
                    type="url"
                    value={editForm.website_url || ''}
                    onChange={(e) => setEditForm({ ...editForm, website_url: e.target.value })}
                    className="w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editForm.is_active ?? true}
                    onChange={(e) => setEditForm({ ...editForm, is_active: e.target.checked })}
                    className="rounded"
                  />
                  <label className="text-sm text-[var(--gray-11)]">Active</label>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setEditing(false); setEditForm(podcast); }}>
                  Cancel
                </Button>
                <Button onClick={handleSave}>Save Changes</Button>
              </div>
            </div>
          )}

          {!editing && podcast.description && (
            <p className="text-sm text-[var(--gray-11)] mt-2">{podcast.description}</p>
          )}
        </Card>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 border-b border-[var(--gray-a6)]">
          <button
            onClick={() => setActiveTab('episodes')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'episodes'
                ? 'border-[var(--accent-9)] text-[var(--accent-11)]'
                : 'border-transparent text-[var(--gray-a11)] hover:text-[var(--gray-12)]'
            }`}
          >
            Episodes ({episodes.length})
          </button>
          <button
            onClick={() => setActiveTab('guests')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'guests'
                ? 'border-[var(--accent-9)] text-[var(--accent-11)]'
                : 'border-transparent text-[var(--gray-a11)] hover:text-[var(--gray-12)]'
            }`}
          >
            Guest List ({guests.length})
          </button>
        </div>

        {/* Episodes Tab */}
        {activeTab === 'episodes' && (
          <div>
            <div className="flex justify-end mb-4">
              <Button onClick={handleCreateEpisode}>
                <PlusIcon className="h-4 w-4 mr-1" /> New Episode
              </Button>
            </div>

            {episodes.length === 0 ? (
              <Card variant="surface" className="p-8 text-center">
                <p className="text-[var(--gray-a11)]">No episodes yet. Create your first episode.</p>
              </Card>
            ) : (
              <div className="space-y-2">
                {episodes.map((episode) => (
                  <Card
                    key={episode.id}
                    variant="surface"
                    className="p-4 cursor-pointer hover:shadow-md transition-shadow"
                    onClick={() => navigate(`/admin/podcasts/${podcastId}/episodes/${episode.id}`)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          {episode.episode_number && (
                            <span className="text-sm font-mono text-[var(--gray-a9)]">
                              {episode.season ? `S${episode.season}E${episode.episode_number}` : `#${episode.episode_number}`}
                            </span>
                          )}
                          <h3 className="font-medium text-[var(--gray-12)]">{episode.title}</h3>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-sm text-[var(--gray-a11)]">
                          {episode.record_date && (
                            <span>Record: {new Date(episode.record_date).toLocaleDateString()}</span>
                          )}
                          {episode.publish_date && (
                            <span>Published: {new Date(episode.publish_date).toLocaleDateString()}</span>
                          )}
                          <span>{episode.guest_count || 0} guests</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge color={statusColors[episode.status] as any} variant="soft">
                          {episode.status}
                        </Badge>
                        <Button
                          variant="ghost"
                          color="red"
                          size="sm"
                          onClick={(e: React.MouseEvent) => handleDeleteEpisode(e, episode.id, episode.title)}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Guests Tab */}
        {activeTab === 'guests' && (
          <div>
            <div className="flex justify-end mb-4">
              <Button onClick={handleAddGuest}>
                <PlusIcon className="h-4 w-4 mr-1" /> Add Guest
              </Button>
            </div>

            {guests.length === 0 ? (
              <Card variant="surface" className="p-8 text-center">
                <p className="text-[var(--gray-a11)]">No guests yet. Add guests manually or share the application form.</p>
                <p className="text-sm text-[var(--gray-a9)] mt-2">
                  Guest application form: /podcasts/{podcast.slug}/apply
                </p>
              </Card>
            ) : (
              <div className="space-y-2">
                {guests.map((guest) => (
                  <Card key={guest.id} variant="surface" className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-[var(--gray-12)]">{guest.name}</h3>
                        <div className="flex items-center gap-3 mt-1 text-sm text-[var(--gray-a11)]">
                          <span>{guest.email}</span>
                          {guest.company && <span>{guest.company}</span>}
                          {guest.topic_suggestions && (
                            <span className="truncate max-w-[200px]" title={guest.topic_suggestions}>
                              Topics: {guest.topic_suggestions}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge color={guestStatusColors[guest.status] as any} variant="soft">
                          {guest.status}
                        </Badge>
                        <Badge color="gray" variant="soft">{guest.source}</Badge>
                        <select
                          value={guest.status}
                          onChange={(e) => handleGuestStatusChange(guest.id, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs rounded border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-2 py-1"
                        >
                          <option value="pending">Pending</option>
                          <option value="approved">Approved</option>
                          <option value="declined">Declined</option>
                          <option value="contacted">Contacted</option>
                          <option value="archived">Archived</option>
                        </select>
                        <Button
                          variant="ghost"
                          color="red"
                          size="sm"
                          onClick={(e: React.MouseEvent) => handleDeleteGuest(e, guest.id, guest.name)}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
