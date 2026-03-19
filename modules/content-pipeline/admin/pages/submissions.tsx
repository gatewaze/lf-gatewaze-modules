import React, { useState, useEffect } from 'react';
import {
  PlusIcon,
  TrashIcon,
  ArrowPathIcon,
  LinkIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import {
  SubmissionsService,
  type ContentSubmission,
} from '../utils/contentPipelineService';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td, ConfirmModal } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { toast } from 'sonner';

export default function SubmissionsPage() {
  const [submissions, setSubmissions] = useState<ContentSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const perPage = 20;

  // Add submission form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [statusFilter, page]);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await SubmissionsService.getAll({
        status: statusFilter || undefined,
        limit: perPage,
        offset: page * perPage,
      });
      if (result.data) {
        setSubmissions(result.data);
        setTotal(result.total ?? 0);
      }
    } catch (error) {
      console.error('Error loading submissions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl.trim()) return;

    setSubmitting(true);
    try {
      const result = await SubmissionsService.create({
        url: newUrl.trim(),
        submission_type: 'url',
        submitted_by: 'admin',
        notes: newNotes.trim() || undefined,
      });
      if (result.success) {
        toast.success('Content submitted for processing');
        setNewUrl('');
        setNewNotes('');
        setShowAddForm(false);
        loadData();
      } else {
        toast.error(result.error || 'Failed to submit');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const result = await SubmissionsService.delete(deleteId);
    if (result.success) {
      toast.success('Submission deleted');
      loadData();
    } else {
      toast.error(result.error || 'Failed to delete');
    }
    setDeleteId(null);
  };

  const handleRetriage = async (id: string) => {
    const result = await SubmissionsService.updateStatus(id, 'pending');
    if (result.success) {
      toast.success('Submission queued for re-triage');
      loadData();
    } else {
      toast.error(result.error || 'Failed to update');
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'yellow';
      case 'triaging': return 'blue';
      case 'completed': return 'green';
      case 'failed': return 'red';
      case 'duplicate': return 'gray';
      default: return 'gray';
    }
  };

  const totalPages = Math.ceil(total / perPage);

  return (
    <Page title="Content Submissions">
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Content Submissions</h1>
            <p className="text-[var(--gray-11)] mt-1">
              URLs and queries submitted for processing through the content pipeline
            </p>
          </div>
          <Button variant="solid" onClick={() => setShowAddForm(!showAddForm)}>
            <PlusIcon className="h-5 w-5 mr-2" />
            Submit Content
          </Button>
        </div>

        {/* Add Content Form */}
        {showAddForm && (
          <Card variant="surface" className="p-6 mb-6">
            <h3 className="text-lg font-medium mb-4">Submit New Content</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                  URL
                </label>
                <div className="flex items-center gap-2">
                  <LinkIcon className="h-5 w-5 text-[var(--gray-a9)]" />
                  <input
                    type="url"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://youtube.com/watch?v=... or https://blog.example.com/post"
                    className="flex-1 rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                  Notes (optional)
                </label>
                <input
                  type="text"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Any context about this content..."
                  className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" variant="solid" disabled={submitting}>
                  {submitting ? 'Submitting...' : 'Submit'}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowAddForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}

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
              <option value="triaging">Triaging</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="duplicate">Duplicate</option>
            </select>
          </div>
          <span className="text-sm text-[var(--gray-a11)]">
            {total} submission{total !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        <Card variant="surface" className="overflow-hidden">
          <ScrollableTable>
            <Table>
              <THead>
                <Tr>
                  <Th>URL / Query</Th>
                  <Th>Type</Th>
                  <Th>Status</Th>
                  <Th>Submitted By</Th>
                  <Th>Submitted</Th>
                  <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                </Tr>
              </THead>
              <TBody>
                {loading ? (
                  <Tr>
                    <Td colSpan={6} className="text-center text-[var(--gray-a11)]">Loading...</Td>
                  </Tr>
                ) : submissions.length === 0 ? (
                  <Tr>
                    <Td colSpan={6} className="text-center text-[var(--gray-a11)]">No submissions found</Td>
                  </Tr>
                ) : (
                  submissions.map((sub) => (
                    <Tr key={sub.id}>
                      <Td>
                        <div className="max-w-md">
                          {sub.url ? (
                            <a
                              href={sub.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-info-600 hover:underline truncate block"
                            >
                              {sub.url}
                            </a>
                          ) : (
                            <div className="flex items-center gap-1">
                              <MagnifyingGlassIcon className="h-4 w-4 text-[var(--gray-a9)]" />
                              <span className="text-sm">{sub.search_query}</span>
                            </div>
                          )}
                          {sub.notes && (
                            <div className="text-xs text-[var(--gray-a9)] mt-0.5">{sub.notes}</div>
                          )}
                          {sub.error_message && (
                            <div className="text-xs text-error-600 mt-0.5">{sub.error_message}</div>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <Badge color="gray" variant="soft">{sub.submission_type}</Badge>
                      </Td>
                      <Td>
                        <Badge color={statusColor(sub.status)} variant="soft">{sub.status}</Badge>
                      </Td>
                      <Td>
                        <span className="text-sm text-[var(--gray-a11)]">{sub.submitted_by}</span>
                      </Td>
                      <Td>
                        <span className="text-sm text-[var(--gray-a11)]">
                          {new Date(sub.created_at).toLocaleString()}
                        </span>
                      </Td>
                      <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                        <RowActions actions={[
                          ...(sub.status === 'failed' || sub.status === 'duplicate' ? [{
                            label: 'Re-triage',
                            icon: <ArrowPathIcon className="size-4" />,
                            onClick: () => handleRetriage(sub.id),
                          }] : []),
                          {
                            label: 'Delete',
                            icon: <TrashIcon className="size-4" />,
                            onClick: () => setDeleteId(sub.id),
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
          title="Delete Submission"
          message="Are you sure you want to delete this submission? This action cannot be undone."
          confirmText="Delete"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
