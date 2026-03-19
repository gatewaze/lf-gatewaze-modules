import React, { useState, useEffect } from 'react';
import {
  TrashIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import {
  QueueService,
  type ContentQueueItem,
} from '../utils/contentPipelineService';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td, ConfirmModal } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { toast } from 'sonner';

export default function QueuePage() {
  const [items, setItems] = useState<ContentQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const perPage = 20;
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    // Read initial filter from URL
    const params = new URLSearchParams(window.location.search);
    const urlStatus = params.get('status');
    if (urlStatus) setStatusFilter(urlStatus);
  }, []);

  useEffect(() => {
    loadData();
  }, [statusFilter, page]);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await QueueService.getAll({
        status: statusFilter || undefined,
        limit: perPage,
        offset: page * perPage,
      });
      if (result.data) {
        setItems(result.data);
        setTotal(result.total ?? 0);
      }
    } catch (error) {
      console.error('Error loading queue:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (id: string) => {
    const result = await QueueService.retry(id);
    if (result.success) {
      toast.success('Item queued for retry');
      loadData();
    } else {
      toast.error(result.error || 'Failed to retry');
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const result = await QueueService.delete(deleteId);
    if (result.success) {
      toast.success('Queue item deleted');
      loadData();
    } else {
      toast.error(result.error || 'Failed to delete');
    }
    setDeleteId(null);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'yellow';
      case 'processing': return 'blue';
      case 'completed': return 'green';
      case 'failed': return 'red';
      default: return 'gray';
    }
  };

  const priorityLabel = (priority: number) => {
    switch (priority) {
      case 1: return { text: 'Highest', color: 'red' as const };
      case 2: return { text: 'High', color: 'orange' as const };
      case 3: return { text: 'Normal', color: 'gray' as const };
      case 4: return { text: 'Low', color: 'blue' as const };
      case 5: return { text: 'Lowest', color: 'gray' as const };
      default: return { text: `P${priority}`, color: 'gray' as const };
    }
  };

  const totalPages = Math.ceil(total / perPage);

  return (
    <Page title="Processing Queue">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Processing Queue</h1>
          <p className="text-[var(--gray-11)] mt-1">
            Content items awaiting or currently being processed by the processing agent
          </p>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            <label className="text-sm text-[var(--gray-a11)]">Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
              className="rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
          </div>
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
                  <Th>URL</Th>
                  <Th>Title</Th>
                  <Th>Type</Th>
                  <Th>Source</Th>
                  <Th>Priority</Th>
                  <Th>Status</Th>
                  <Th>Retries</Th>
                  <Th>Created</Th>
                  <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                </Tr>
              </THead>
              <TBody>
                {loading ? (
                  <Tr>
                    <Td colSpan={9} className="text-center text-[var(--gray-a11)]">Loading...</Td>
                  </Tr>
                ) : items.length === 0 ? (
                  <Tr>
                    <Td colSpan={9} className="text-center text-[var(--gray-a11)]">No queue items found</Td>
                  </Tr>
                ) : (
                  items.map((item) => {
                    const prio = priorityLabel(item.priority);
                    return (
                      <Tr key={item.id}>
                        <Td>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-info-600 hover:underline truncate block max-w-xs"
                          >
                            {item.url}
                          </a>
                          {item.error_message && (
                            <div className="flex items-center gap-1 mt-0.5">
                              <ExclamationTriangleIcon className="h-3 w-3 text-error-500" />
                              <span className="text-xs text-error-600 truncate max-w-xs">{item.error_message}</span>
                            </div>
                          )}
                        </Td>
                        <Td>
                          <span className="text-sm truncate block max-w-xs">{item.title || '-'}</span>
                        </Td>
                        <Td>
                          {item.content_type ? (
                            <Badge color="info" variant="soft">{item.content_type}</Badge>
                          ) : (
                            <span className="text-[var(--gray-a9)]">-</span>
                          )}
                        </Td>
                        <Td>
                          {item.source_type ? (
                            <Badge color="gray" variant="soft">{item.source_type}</Badge>
                          ) : (
                            <span className="text-[var(--gray-a9)]">-</span>
                          )}
                        </Td>
                        <Td>
                          <Badge color={prio.color} variant="soft">{prio.text}</Badge>
                        </Td>
                        <Td>
                          <Badge color={statusColor(item.status)} variant="soft">{item.status}</Badge>
                        </Td>
                        <Td>
                          <span className="text-sm">{item.retry_count}/{item.max_retries}</span>
                        </Td>
                        <Td>
                          <span className="text-sm text-[var(--gray-a11)]">
                            {new Date(item.created_at).toLocaleString()}
                          </span>
                        </Td>
                        <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                          <RowActions actions={[
                            ...(item.status === 'failed' ? [{
                              label: 'Retry',
                              icon: <ArrowPathIcon className="size-4" />,
                              onClick: () => handleRetry(item.id),
                            }] : []),
                            {
                              label: 'Delete',
                              icon: <TrashIcon className="size-4" />,
                              onClick: () => setDeleteId(item.id),
                              color: 'red' as const,
                            },
                          ]} />
                        </Td>
                      </Tr>
                    );
                  })
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
          title="Delete Queue Item"
          message="Are you sure you want to delete this queue item? This action cannot be undone."
          confirmText="Delete"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
