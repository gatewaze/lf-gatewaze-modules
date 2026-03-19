import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  InboxArrowDownIcon,
  QueueListIcon,
  DocumentTextIcon,
  FilmIcon,
  TagIcon,
  SignalIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  LightBulbIcon,
} from '@heroicons/react/24/outline';
import { PipelineStatsService, type PipelineStats } from '../utils/contentPipelineService';
import { Card, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';

export default function ContentPipelineDashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    setLoading(true);
    try {
      const result = await PipelineStatsService.getStats();
      if (result.data) setStats(result.data);
    } catch (error) {
      console.error('Error loading pipeline stats:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Page title="Content Pipeline">
        <div className="p-6 animate-pulse">
          <div className="h-8 bg-neutral-200 rounded mb-6 w-64"></div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="p-6">
                <div className="h-4 bg-neutral-200 rounded mb-2"></div>
                <div className="h-8 bg-neutral-200 rounded"></div>
              </div>
            ))}
          </div>
        </div>
      </Page>
    );
  }

  const statCards = [
    {
      label: 'Total Content Items',
      value: stats?.total_items ?? 0,
      icon: DocumentTextIcon,
      color: 'text-info-600',
      link: '/admin/content-pipeline/items',
    },
    {
      label: 'Videos',
      value: stats?.total_videos ?? 0,
      icon: FilmIcon,
      color: 'text-error-600',
      link: '/admin/content-pipeline/items?type=video',
    },
    {
      label: 'Articles',
      value: stats?.total_articles ?? 0,
      icon: DocumentTextIcon,
      color: 'text-success-600',
      link: '/admin/content-pipeline/items?type=article',
    },
    {
      label: 'Video Segments',
      value: stats?.total_segments ?? 0,
      icon: ClockIcon,
      color: 'text-purple-600',
    },
    {
      label: 'Pending Submissions',
      value: stats?.pending_submissions ?? 0,
      icon: InboxArrowDownIcon,
      color: 'text-warning-600',
      link: '/admin/content-pipeline/submissions',
    },
    {
      label: 'Queue (Pending)',
      value: stats?.pending_queue ?? 0,
      icon: QueueListIcon,
      color: 'text-info-600',
      link: '/admin/content-pipeline/queue',
    },
    {
      label: 'Queue (Failed)',
      value: stats?.failed_queue ?? 0,
      icon: ExclamationTriangleIcon,
      color: 'text-error-600',
      link: '/admin/content-pipeline/queue?status=failed',
    },
    {
      label: 'Active Sources',
      value: stats?.active_sources ?? 0,
      icon: SignalIcon,
      color: 'text-success-600',
      link: '/admin/content-pipeline/discovery',
    },
  ];

  const metaCards = [
    { label: 'New Items (24h)', value: stats?.items_last_24h ?? 0 },
    { label: 'Discovery Runs (24h)', value: stats?.discovery_runs_last_24h ?? 0 },
    { label: 'Tracked Projects', value: stats?.tracked_projects ?? 0 },
    { label: 'Tracked Topics', value: stats?.tracked_topics ?? 0 },
    { label: 'Pending Suggestions', value: stats?.pending_suggestions ?? 0, link: '/admin/content-pipeline/suggestions' },
  ];

  return (
    <Page title="Content Pipeline">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Content Pipeline</h1>
          <p className="text-[var(--gray-11)] mt-1">
            AI-powered content discovery, indexing, and deep video search
          </p>
        </div>

        {/* Primary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          {statCards.map((card) => (
            <Card
              key={card.label}
              variant="surface"
              className={`p-5 ${card.link ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
              onClick={() => card.link && navigate(card.link)}
            >
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

        {/* Secondary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          {metaCards.map((card) => (
            <Card
              key={card.label}
              variant="surface"
              className={`p-5 ${(card as any).link ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
              onClick={() => (card as any).link && navigate((card as any).link)}
            >
              <div className="text-sm font-medium text-neutral-500">{card.label}</div>
              <div className="text-xl font-bold">{card.value.toLocaleString()}</div>
            </Card>
          ))}
        </div>

        {/* Quick Actions */}
        <Card variant="surface" className="p-6">
          <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Pipeline Overview</h2>
          <div className="text-sm text-[var(--gray-11)] space-y-2">
            <p>The content pipeline processes content through three stages:</p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>
                <strong>Discovery</strong> — Automated agents scan configured sources (YouTube, blogs, GitHub, RSS, Reddit, HN) for new agentic AI content
              </li>
              <li>
                <strong>Triage</strong> — Submissions are classified, deduplicated, and expanded (e.g., playlists into individual videos)
              </li>
              <li>
                <strong>Processing</strong> — Content is scraped, summarized, tagged with projects/topics, and deep-indexed with timestamped video segments
              </li>
            </ol>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Badge color="info" variant="soft">
              {stats?.processing_queue ?? 0} currently processing
            </Badge>
            {(stats?.failed_queue ?? 0) > 0 && (
              <Badge color="red" variant="soft">
                {stats?.failed_queue} failed items need attention
              </Badge>
            )}
          </div>
        </Card>
      </div>
    </Page>
  );
}
