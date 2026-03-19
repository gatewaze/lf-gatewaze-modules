import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrashIcon,
  EyeIcon,
  FilmIcon,
  DocumentTextIcon,
  CodeBracketIcon,
  MicrophoneIcon,
} from '@heroicons/react/24/outline';
import {
  ContentItemsService,
  type ContentItem,
} from '../../utils/contentPipelineService';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td, ConfirmModal } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { toast } from 'sonner';

export default function ContentItemsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [contentTypeFilter, setContentTypeFilter] = useState('');
  const [sourceTypeFilter, setSourceTypeFilter] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const perPage = 20;
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const type = params.get('type');
    if (type) setContentTypeFilter(type);
  }, []);

  useEffect(() => {
    loadData();
  }, [contentTypeFilter, sourceTypeFilter, search, page]);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await ContentItemsService.getAll({
        content_type: contentTypeFilter || undefined,
        source_type: sourceTypeFilter || undefined,
        search: search || undefined,
        limit: perPage,
        offset: page * perPage,
      });
      if (result.data) {
        setItems(result.data);
        setTotal(result.total ?? 0);
      }
    } catch (error) {
      console.error('Error loading content items:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const result = await ContentItemsService.delete(deleteId);
    if (result.success) {
      toast.success('Content item deleted');
      loadData();
    } else {
      toast.error(result.error || 'Failed to delete');
    }
    setDeleteId(null);
  };

  const contentTypeIcon = (type: string) => {
    switch (type) {
      case 'video':
      case 'talk': return <FilmIcon className="h-4 w-4" />;
      case 'podcast': return <MicrophoneIcon className="h-4 w-4" />;
      case 'repo': return <CodeBracketIcon className="h-4 w-4" />;
      default: return <DocumentTextIcon className="h-4 w-4" />;
    }
  };

  const formatDuration = (seconds?: number | null) => {
    if (!seconds) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const totalPages = Math.ceil(total / perPage);

  return (
    <Page title="Content Items">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Content Items</h1>
          <p className="text-[var(--gray-11)] mt-1">
            Fully processed content in the Gatewaze database
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search by title or summary..."
            className="rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <select
            value={contentTypeFilter}
            onChange={(e) => { setContentTypeFilter(e.target.value); setPage(0); }}
            className="rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="">All Types</option>
            <option value="article">Article</option>
            <option value="video">Video</option>
            <option value="repo">Repository</option>
            <option value="tutorial">Tutorial</option>
            <option value="talk">Talk</option>
            <option value="podcast">Podcast</option>
            <option value="documentation">Documentation</option>
          </select>
          <select
            value={sourceTypeFilter}
            onChange={(e) => { setSourceTypeFilter(e.target.value); setPage(0); }}
            className="rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="">All Sources</option>
            <option value="youtube">YouTube</option>
            <option value="blog">Blog</option>
            <option value="github">GitHub</option>
            <option value="conference">Conference</option>
            <option value="podcast">Podcast</option>
            <option value="rss">RSS</option>
            <option value="reddit">Reddit</option>
            <option value="hackernews">Hacker News</option>
          </select>
          <span className="text-sm text-[var(--gray-a11)]">
            {total} item{total !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        <Card variant="surface" className="overflow-hidden">
          <ScrollableTable>
            <Table>
              <THead>
                <Tr>
                  <Th>Content</Th>
                  <Th>Type</Th>
                  <Th>Source</Th>
                  <Th>Projects</Th>
                  <Th>Quality</Th>
                  <Th>Segments</Th>
                  <Th>Published</Th>
                  <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                </Tr>
              </THead>
              <TBody>
                {loading ? (
                  <Tr>
                    <Td colSpan={8} className="text-center text-[var(--gray-a11)]">Loading...</Td>
                  </Tr>
                ) : items.length === 0 ? (
                  <Tr>
                    <Td colSpan={8} className="text-center text-[var(--gray-a11)]">No content items found</Td>
                  </Tr>
                ) : (
                  items.map((item) => (
                    <Tr key={item.id}>
                      <Td>
                        <div className="max-w-md">
                          <div className="flex items-center gap-2">
                            {item.thumbnail_url && (
                              <img
                                src={item.thumbnail_url}
                                alt=""
                                className="w-16 h-10 object-cover rounded flex-shrink-0"
                              />
                            )}
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">{item.title}</div>
                              {item.author && (
                                <div className="text-xs text-[var(--gray-a9)]">{item.author}</div>
                              )}
                              {item.duration_seconds && (
                                <div className="text-xs text-[var(--gray-a9)]">{formatDuration(item.duration_seconds)}</div>
                              )}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1">
                          {contentTypeIcon(item.content_type)}
                          <Badge color="info" variant="soft">{item.content_type}</Badge>
                        </div>
                      </Td>
                      <Td>
                        <Badge color="gray" variant="soft">{item.source_type}</Badge>
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {item.projects.slice(0, 3).map((p) => (
                            <Badge key={p} color="purple" variant="soft" className="text-xs">{p}</Badge>
                          ))}
                          {item.projects.length > 3 && (
                            <Badge color="gray" variant="soft" className="text-xs">+{item.projects.length - 3}</Badge>
                          )}
                        </div>
                      </Td>
                      <Td>
                        {item.quality_score != null ? (
                          <span className="text-sm">{(item.quality_score * 100).toFixed(0)}%</span>
                        ) : (
                          <span className="text-[var(--gray-a9)]">-</span>
                        )}
                      </Td>
                      <Td>
                        {item.has_segments ? (
                          <Badge color="green" variant="soft">Yes</Badge>
                        ) : (
                          <span className="text-[var(--gray-a9)]">-</span>
                        )}
                      </Td>
                      <Td>
                        <span className="text-sm text-[var(--gray-a11)]">
                          {item.publish_date ? new Date(item.publish_date).toLocaleDateString() : '-'}
                        </span>
                      </Td>
                      <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                        <RowActions actions={[
                          {
                            label: 'View Details',
                            icon: <EyeIcon className="size-4" />,
                            onClick: () => navigate(`/admin/content-pipeline/items/${item.id}`),
                          },
                          {
                            label: 'Delete',
                            icon: <TrashIcon className="size-4" />,
                            onClick: () => setDeleteId(item.id),
                            color: 'red' as const,
                          },
                        ]} />
                      </Td>
                    </Tr>
                  ))
                )}
              </TBody>
            </Table>
          </ScrollableTable>

          {totalPages > 1 && (
            <div className="px-6 py-4 border-t border-[var(--gray-a6)] flex items-center justify-between">
              <span className="text-sm text-[var(--gray-a11)]">Page {page + 1} of {totalPages}</span>
              <div className="flex gap-2">
                <Button variant="outline" color="gray" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
                  Previous
                </Button>
                <Button variant="outline" color="gray" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>

        <ConfirmModal
          isOpen={deleteId !== null}
          onClose={() => setDeleteId(null)}
          onConfirm={handleDelete}
          title="Delete Content Item"
          message="Are you sure you want to delete this content item and all its segments? This action cannot be undone."
          confirmText="Delete"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
