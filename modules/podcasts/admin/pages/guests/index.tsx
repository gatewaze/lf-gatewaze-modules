import React, { useState, useEffect } from 'react';
import {
  TrashIcon,
} from '@heroicons/react/24/outline';
import {
  GuestsService,
  PodcastsService,
  type PodcastGuest,
  type Podcast,
} from '../../utils/podcastService';
import { Card, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';

export default function GuestListPage() {
  const [guests, setGuests] = useState<PodcastGuest[]>([]);
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterPodcast, setFilterPodcast] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSource, setFilterSource] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const [guestsResult, podcastsResult] = await Promise.all([
        GuestsService.getAll({
          search: search || undefined,
          podcast_id: filterPodcast || undefined,
          status: filterStatus || undefined,
          source: filterSource || undefined,
        }),
        PodcastsService.getAll(),
      ]);
      if (guestsResult.data) setGuests(guestsResult.data);
      if (podcastsResult.data) setPodcasts(podcastsResult.data);
    } catch (error) {
      console.error('Error loading guests:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => loadData(), 300);
    return () => clearTimeout(timer);
  }, [search, filterPodcast, filterStatus, filterSource]);

  const handleStatusChange = async (id: string, status: string) => {
    const result = await GuestsService.updateStatus(id, status);
    if (result.success) loadData();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete guest "${name}"?`)) return;
    const result = await GuestsService.delete(id);
    if (result.success) loadData();
  };

  const statusColors: Record<string, string> = {
    pending: 'yellow',
    approved: 'green',
    declined: 'red',
    contacted: 'blue',
    archived: 'gray',
  };

  return (
    <Page title="Podcast Guest List">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Guest List</h1>
          <p className="text-[var(--gray-11)] mt-1">
            All podcast guest applications and manually added guests
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-4 py-2 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-a9)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-a8)] w-64"
          />
          <select
            value={filterPodcast}
            onChange={(e) => setFilterPodcast(e.target.value)}
            className="rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
          >
            <option value="">All Podcasts</option>
            {podcasts.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
          >
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
            <option value="contacted">Contacted</option>
            <option value="archived">Archived</option>
          </select>
          <select
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value)}
            className="rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-3 py-2 text-sm"
          >
            <option value="">All Sources</option>
            <option value="form">Form</option>
            <option value="manual">Manual</option>
            <option value="import">Import</option>
          </select>
        </div>

        {/* Results count */}
        <p className="text-sm text-[var(--gray-a11)] mb-4">
          {guests.length} guest{guests.length !== 1 ? 's' : ''}
        </p>

        {/* Guest List */}
        {loading && guests.length === 0 ? (
          <div className="animate-pulse space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-neutral-200 rounded" />
            ))}
          </div>
        ) : guests.length === 0 ? (
          <Card variant="surface" className="p-8 text-center">
            <p className="text-[var(--gray-a11)]">No guests found matching your filters.</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {guests.map((guest) => (
              <Card key={guest.id} variant="surface" className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-[var(--gray-12)]">{guest.name}</h3>
                      {guest.podcast_name && (
                        <Badge color="blue" variant="soft" className="text-xs">
                          {guest.podcast_name}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-sm text-[var(--gray-a11)]">
                      <span>{guest.email}</span>
                      {guest.company && <span>{guest.company}</span>}
                      {guest.title && <span>{guest.title}</span>}
                    </div>
                    {guest.topic_suggestions && (
                      <p className="text-xs text-[var(--gray-a9)] mt-1 truncate">
                        Topics: {guest.topic_suggestions}
                      </p>
                    )}
                    <div className="text-xs text-[var(--gray-a9)] mt-1">
                      Applied {new Date(guest.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                    <Badge color={statusColors[guest.status] as any} variant="soft">
                      {guest.status}
                    </Badge>
                    <Badge color="gray" variant="soft">{guest.source}</Badge>
                    <select
                      value={guest.status}
                      onChange={(e) => handleStatusChange(guest.id, e.target.value)}
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
                      onClick={() => handleDelete(guest.id, guest.name)}
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
    </Page>
  );
}
