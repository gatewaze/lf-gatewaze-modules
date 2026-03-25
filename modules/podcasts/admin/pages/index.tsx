import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MicrophoneIcon,
  FilmIcon,
  UsersIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import {
  PodcastsService,
  PodcastStatsService,
  type Podcast,
  type PodcastStats,
} from '../utils/podcastService';
import { Card, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';

export default function PodcastsListPage() {
  const navigate = useNavigate();
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [stats, setStats] = useState<PodcastStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [podcastsResult, statsResult] = await Promise.all([
        PodcastsService.getAll({ search: search || undefined }),
        PodcastStatsService.getStats(),
      ]);
      if (podcastsResult.data) setPodcasts(podcastsResult.data);
      if (statsResult.data) setStats(statsResult.data);
    } catch (error) {
      console.error('Error loading podcasts:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => loadData(), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const handleCreate = async () => {
    const name = prompt('Podcast name:');
    if (!name) return;

    const result = await PodcastsService.create({ name });
    if (result.success && result.data) {
      navigate(`/admin/podcasts/${result.data.id}`);
    } else {
      alert(result.error || 'Failed to create podcast');
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (!confirm(`Delete "${name}"? This will also delete all episodes and guest assignments.`)) return;

    const result = await PodcastsService.delete(id);
    if (result.success) {
      loadData();
    } else {
      alert(result.error || 'Failed to delete podcast');
    }
  };

  const statCards = [
    { label: 'Active Podcasts', value: stats?.total_podcasts ?? 0, icon: MicrophoneIcon, color: 'text-info-600' },
    { label: 'Total Episodes', value: stats?.total_episodes ?? 0, icon: FilmIcon, color: 'text-success-600' },
    { label: 'Published Episodes', value: stats?.published_episodes ?? 0, icon: FilmIcon, color: 'text-purple-600' },
    { label: 'Total Guests', value: stats?.total_guests ?? 0, icon: UsersIcon, color: 'text-warning-600' },
    { label: 'Pending Guests', value: stats?.pending_guests ?? 0, icon: UsersIcon, color: 'text-error-600' },
  ];

  if (loading && podcasts.length === 0) {
    return (
      <Page title="Podcasts">
        <div className="p-6 animate-pulse">
          <div className="h-8 bg-neutral-200 rounded mb-6 w-64" />
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="p-5">
                <div className="h-4 bg-neutral-200 rounded mb-2" />
                <div className="h-8 bg-neutral-200 rounded" />
              </div>
            ))}
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Podcasts">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Podcasts</h1>
            <p className="text-[var(--gray-11)] mt-1">
              Manage podcast series, episodes, and guest lists
            </p>
          </div>
          <Button onClick={handleCreate}>
            <PlusIcon className="h-4 w-4 mr-1" /> New Podcast
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
          {statCards.map((card) => (
            <Card key={card.label} variant="surface" className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-neutral-500">{card.label}</div>
                  <div className={`text-2xl font-bold ${card.color}`}>
                    {card.value.toLocaleString()}
                  </div>
                </div>
                <card.icon className={`h-8 w-8 ${card.color} opacity-50`} />
              </div>
            </Card>
          ))}
        </div>

        {/* Search */}
        <div className="mb-4">
          <input
            type="text"
            placeholder="Search podcasts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-md rounded-lg border border-[var(--gray-a6)] bg-[var(--gray-a2)] px-4 py-2 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-a9)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-a8)]"
          />
        </div>

        {/* Podcast List */}
        <div className="space-y-3">
          {podcasts.length === 0 ? (
            <Card variant="surface" className="p-8 text-center">
              <MicrophoneIcon className="h-12 w-12 text-[var(--gray-a8)] mx-auto mb-3" />
              <p className="text-[var(--gray-a11)]">No podcasts yet. Create your first podcast to get started.</p>
            </Card>
          ) : (
            podcasts.map((podcast) => (
              <Card
                key={podcast.id}
                variant="surface"
                className="p-5 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/admin/podcasts/${podcast.id}`)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    {podcast.cover_image_url ? (
                      <img src={podcast.cover_image_url} alt="" className="w-12 h-12 rounded object-cover" />
                    ) : (
                      <div className="w-12 h-12 rounded bg-[var(--gray-a4)] flex items-center justify-center">
                        <MicrophoneIcon className="h-6 w-6 text-[var(--gray-a9)]" />
                      </div>
                    )}
                    <div>
                      <h3 className="font-medium text-[var(--gray-12)]">{podcast.name}</h3>
                      <div className="flex items-center gap-3 mt-1 text-sm text-[var(--gray-a11)]">
                        <span>{podcast.episode_count || 0} episodes</span>
                        <span>{podcast.guest_count || 0} guests</span>
                        <span className="text-[var(--gray-a9)]">/{podcast.slug}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge color={podcast.is_active ? 'green' : 'gray'} variant="soft">
                      {podcast.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                    <Button
                      variant="ghost"
                      color="red"
                      size="sm"
                      onClick={(e: React.MouseEvent) => handleDelete(e, podcast.id, podcast.name)}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </Page>
  );
}
