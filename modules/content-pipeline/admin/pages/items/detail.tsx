import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  LinkIcon,
  ClockIcon,
  TagIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
import {
  ContentItemsService,
  type ContentItem,
  type ContentSegment,
} from '../../utils/contentPipelineService';
import { Card, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';

export default function ContentItemDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<ContentItem | null>(null);
  const [segments, setSegments] = useState<ContentSegment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [itemResult, segmentsResult] = await Promise.all([
        ContentItemsService.getById(id!),
        ContentItemsService.getSegments(id!),
      ]);
      if (itemResult.data) setItem(itemResult.data);
      if (segmentsResult.data) setSegments(segmentsResult.data);
    } catch (error) {
      console.error('Error loading content item:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const getDeepLink = (url: string, startTime: number) => {
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}t=${startTime}`;
    }
    return url;
  };

  if (loading) {
    return (
      <Page title="Content Item">
        <div className="p-6 animate-pulse">
          <div className="h-8 bg-neutral-200 rounded mb-4 w-64"></div>
          <div className="h-4 bg-neutral-200 rounded mb-2 w-full"></div>
          <div className="h-4 bg-neutral-200 rounded mb-2 w-3/4"></div>
        </div>
      </Page>
    );
  }

  if (!item) {
    return (
      <Page title="Content Item">
        <div className="p-6">
          <p className="text-[var(--gray-a11)]">Content item not found.</p>
          <Button variant="outline" onClick={() => navigate('/admin/content-pipeline/items')} className="mt-4">
            Back to Content Items
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page title={item.title}>
      <div className="p-6">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => navigate('/admin/content-pipeline/items')}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-[var(--gray-a3)] border border-[var(--gray-a5)] text-[var(--gray-11)] hover:bg-[var(--gray-a4)] transition-colors mb-4"
          >
            <ArrowLeftIcon className="h-4 w-4" /> Back
          </button>

          <div className="flex items-start gap-4">
            {item.thumbnail_url && (
              <img src={item.thumbnail_url} alt="" className="w-40 h-24 object-cover rounded" />
            )}
            <div className="flex-1">
              <h1 className="text-2xl font-semibold text-[var(--gray-12)]">{item.title}</h1>
              <div className="flex items-center gap-3 mt-2 text-sm text-[var(--gray-a11)]">
                {item.author && <span>by {item.author}</span>}
                <Badge color="info" variant="soft">{item.content_type}</Badge>
                <Badge color="gray" variant="soft">{item.source_type}</Badge>
                {item.duration_seconds && (
                  <span className="flex items-center gap-1">
                    <ClockIcon className="h-4 w-4" />
                    {formatTime(item.duration_seconds)}
                  </span>
                )}
                {item.quality_score != null && (
                  <span>Quality: {(item.quality_score * 100).toFixed(0)}%</span>
                )}
              </div>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-info-600 hover:underline mt-1"
              >
                <LinkIcon className="h-4 w-4" /> {item.url}
              </a>
            </div>
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-2 mb-6">
          {item.projects.map((p) => (
            <Badge key={p} color="purple" variant="soft">{p}</Badge>
          ))}
          {item.topics.map((t) => (
            <Badge key={t} color="blue" variant="soft">{t}</Badge>
          ))}
          {item.key_people.map((p) => (
            <Badge key={p} color="green" variant="soft">{p}</Badge>
          ))}
        </div>

        {/* Summary & Hot Take */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {item.summary && (
            <Card variant="surface" className="p-5">
              <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-2">Summary</h3>
              <p className="text-sm text-[var(--gray-11)] whitespace-pre-wrap">{item.summary}</p>
            </Card>
          )}
          {item.hot_take && (
            <Card variant="surface" className="p-5">
              <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-2">Hot Take</h3>
              <p className="text-sm text-[var(--gray-11)] italic">{item.hot_take}</p>
            </Card>
          )}
        </div>

        {/* Metadata */}
        <Card variant="surface" className="p-5 mb-6">
          <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-3">Metadata</h3>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="text-[var(--gray-a9)]">Language</dt>
              <dd>{item.language}</dd>
            </div>
            <div>
              <dt className="text-[var(--gray-a9)]">Published</dt>
              <dd>{item.publish_date ? new Date(item.publish_date).toLocaleDateString() : '-'}</dd>
            </div>
            <div>
              <dt className="text-[var(--gray-a9)]">Processed</dt>
              <dd>{item.processed_at ? new Date(item.processed_at).toLocaleDateString() : '-'}</dd>
            </div>
            <div>
              <dt className="text-[var(--gray-a9)]">Sanity ID</dt>
              <dd>{item.sanity_document_id || '-'}</dd>
            </div>
          </dl>
        </Card>

        {/* Segments (Deep Video Index) */}
        {segments.length > 0 && (
          <Card variant="surface" className="p-5">
            <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-4">
              Video Segments ({segments.length} chapters)
            </h3>
            <div className="space-y-4">
              {segments.map((seg) => (
                <div key={seg.id} className="border-l-2 border-[var(--gray-a6)] pl-4 py-2">
                  <div className="flex items-center gap-3">
                    <a
                      href={getDeepLink(item.url, seg.start_time)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-info-600 hover:underline font-mono text-sm"
                    >
                      <PlayIcon className="h-4 w-4" />
                      {formatTime(seg.start_time)}
                    </a>
                    <span className="text-sm text-[var(--gray-a9)]">-</span>
                    <span className="font-mono text-sm text-[var(--gray-a11)]">{formatTime(seg.end_time)}</span>
                    <h4 className="text-sm font-medium">{seg.title}</h4>
                  </div>
                  {seg.summary && (
                    <p className="text-sm text-[var(--gray-11)] mt-1">{seg.summary}</p>
                  )}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {seg.projects.map((p) => (
                      <Badge key={p} color="purple" variant="soft" className="text-xs">{p}</Badge>
                    ))}
                    {seg.topics.map((t) => (
                      <Badge key={t} color="blue" variant="soft" className="text-xs">{t}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
