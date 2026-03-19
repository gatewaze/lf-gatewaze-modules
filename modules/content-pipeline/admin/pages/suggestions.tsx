import React, { useState, useEffect } from 'react';
import {
  PlusIcon,
  TrashIcon,
  CheckIcon,
  XMarkIcon,
  ArrowPathIcon,
  HandThumbUpIcon,
  SignalIcon,
  TagIcon,
} from '@heroicons/react/24/outline';
import {
  MonitoringSuggestionsService,
  type MonitoringSuggestion,
} from '../utils/contentPipelineService';
import { Card, Badge, Button, Table, THead, TBody, Tr, Th, Td, ConfirmModal } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { toast } from 'sonner';

const SUGGESTION_TYPES = [
  { value: 'search_query', label: 'Search Query', description: 'Keywords or phrases to search for' },
  { value: 'youtube_channel', label: 'YouTube Channel', description: 'A YouTube channel to follow' },
  { value: 'rss_feed', label: 'RSS Feed', description: 'An RSS/Atom feed to monitor' },
  { value: 'github_topic', label: 'GitHub Topic', description: 'A GitHub topic to track' },
  { value: 'github_repo', label: 'GitHub Repo', description: 'A specific GitHub repository to watch' },
  { value: 'website', label: 'Website', description: 'A website to periodically scrape' },
  { value: 'reddit_subreddit', label: 'Subreddit', description: 'A Reddit subreddit to monitor' },
  { value: 'project', label: 'New Project', description: 'Suggest a new project to track in the taxonomy' },
];

export default function SuggestionsPage() {
  const [suggestions, setSuggestions] = useState<MonitoringSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [typeFilter, setTypeFilter] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const perPage = 20;

  // Add form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    suggestion_type: 'search_query',
    title: '',
    description: '',
    search_query: '',
    url: '',
  });
  const [submitting, setSubmitting] = useState(false);

  // Admin notes
  const [notesId, setNotesId] = useState<string | null>(null);
  const [adminNotes, setAdminNotes] = useState('');

  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [statusFilter, typeFilter, page]);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await MonitoringSuggestionsService.getAll({
        status: statusFilter || undefined,
        suggestion_type: typeFilter || undefined,
        limit: perPage,
        offset: page * perPage,
      });
      if (result.data) {
        setSuggestions(result.data);
        setTotal(result.total ?? 0);
      }
    } catch (error) {
      console.error('Error loading suggestions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await MonitoringSuggestionsService.create({
        suggestion_type: form.suggestion_type,
        title: form.title,
        description: form.description || undefined,
        search_query: form.search_query || undefined,
        url: form.url || undefined,
        submitted_by: 'admin',
      });
      if (result.success) {
        toast.success('Suggestion submitted');
        setForm({ suggestion_type: 'search_query', title: '', description: '', search_query: '', url: '' });
        setShowForm(false);
        loadData();
      } else {
        toast.error(result.error || 'Failed to submit');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprove = async (id: string) => {
    const result = await MonitoringSuggestionsService.updateStatus(id, 'approved');
    if (result.success) {
      toast.success('Suggestion approved');
      loadData();
    }
  };

  const handleReject = async (id: string) => {
    const result = await MonitoringSuggestionsService.updateStatus(id, 'rejected', adminNotes || undefined);
    if (result.success) {
      toast.success('Suggestion rejected');
      setNotesId(null);
      setAdminNotes('');
      loadData();
    }
  };

  const handleConvertToSource = async (suggestion: MonitoringSuggestion) => {
    const result = await MonitoringSuggestionsService.convertToSource(suggestion.id, suggestion);
    if (result.success) {
      toast.success('Converted to discovery source');
      loadData();
    } else {
      toast.error(result.error || 'Failed to convert');
    }
  };

  const handleConvertToProject = async (suggestion: MonitoringSuggestion) => {
    const result = await MonitoringSuggestionsService.convertToProject(suggestion.id, suggestion);
    if (result.success) {
      toast.success('Converted to tracked project');
      loadData();
    } else {
      toast.error(result.error || 'Failed to convert');
    }
  };

  const handleUpvote = async (id: string) => {
    const result = await MonitoringSuggestionsService.upvote(id);
    if (result.success) {
      setSuggestions(prev => prev.map(s => s.id === id ? { ...s, vote_count: s.vote_count + 1 } : s));
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const result = await MonitoringSuggestionsService.delete(deleteId);
    if (result.success) {
      toast.success('Suggestion deleted');
      loadData();
    }
    setDeleteId(null);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'yellow';
      case 'approved': return 'green';
      case 'rejected': return 'red';
      case 'converted': return 'blue';
      default: return 'gray';
    }
  };

  const typeLabel = (type: string) =>
    SUGGESTION_TYPES.find(t => t.value === type)?.label || type;

  const needsUrl = ['youtube_channel', 'rss_feed', 'github_repo', 'website', 'reddit_subreddit'].includes(form.suggestion_type);
  const needsQuery = ['search_query', 'github_topic'].includes(form.suggestion_type);

  const totalPages = Math.ceil(total / perPage);

  return (
    <Page title="Monitoring Suggestions">
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Monitoring Suggestions</h1>
            <p className="text-[var(--gray-11)] mt-1">
              User-submitted suggestions for topics, channels, and search criteria to monitor
            </p>
          </div>
          <Button variant="solid" onClick={() => setShowForm(!showForm)}>
            <PlusIcon className="h-5 w-5 mr-2" />
            Add Suggestion
          </Button>
        </div>

        {/* Add Suggestion Form */}
        {showForm && (
          <Card variant="surface" className="p-6 mb-6">
            <h3 className="text-lg font-medium mb-4">Submit Monitoring Suggestion</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">What would you like us to monitor? *</label>
                <select
                  value={form.suggestion_type}
                  onChange={(e) => setForm(f => ({ ...f, suggestion_type: e.target.value }))}
                  className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {SUGGESTION_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label} — {t.description}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Title *</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder={form.suggestion_type === 'project' ? 'e.g. OpenHands' : 'e.g. MCP authentication patterns'}
                  className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  required
                />
              </div>
              {needsQuery && (
                <div>
                  <label className="block text-sm font-medium mb-1">Search Query / Keywords</label>
                  <input
                    type="text"
                    value={form.search_query}
                    onChange={(e) => setForm(f => ({ ...f, search_query: e.target.value }))}
                    placeholder="e.g. MCP server authentication OAuth"
                    className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              )}
              {needsUrl && (
                <div>
                  <label className="block text-sm font-medium mb-1">URL</label>
                  <input
                    type="url"
                    value={form.url}
                    onChange={(e) => setForm(f => ({ ...f, url: e.target.value }))}
                    placeholder="https://..."
                    className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium mb-1">Why should we monitor this?</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Explain why this is relevant to the agentic AI community..."
                  className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  rows={3}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" variant="solid" disabled={submitting}>
                  {submitting ? 'Submitting...' : 'Submit Suggestion'}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            <label className="text-sm text-[var(--gray-a11)]">Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
              className="rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="converted">Converted</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-[var(--gray-a11)]">Type:</label>
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}
              className="rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">All Types</option>
              {SUGGESTION_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <span className="text-sm text-[var(--gray-a11)]">
            {total} suggestion{total !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table */}
        <Card variant="surface" className="overflow-hidden">
          <ScrollableTable>
            <Table>
              <THead>
                <Tr>
                  <Th>Suggestion</Th>
                  <Th>Type</Th>
                  <Th>Votes</Th>
                  <Th>Status</Th>
                  <Th>Submitted By</Th>
                  <Th>Submitted</Th>
                  <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                </Tr>
              </THead>
              <TBody>
                {loading ? (
                  <Tr><Td colSpan={7} className="text-center text-[var(--gray-a11)]">Loading...</Td></Tr>
                ) : suggestions.length === 0 ? (
                  <Tr><Td colSpan={7} className="text-center text-[var(--gray-a11)]">No suggestions found</Td></Tr>
                ) : (
                  suggestions.map((s) => (
                    <Tr key={s.id}>
                      <Td>
                        <div className="max-w-md">
                          <div className="text-sm font-medium">{s.title}</div>
                          {s.description && <div className="text-xs text-[var(--gray-a9)] mt-0.5">{s.description}</div>}
                          {s.search_query && (
                            <div className="text-xs text-info-600 mt-0.5">Query: {s.search_query}</div>
                          )}
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-xs text-info-600 hover:underline mt-0.5 block truncate">
                              {s.url}
                            </a>
                          )}
                          {s.admin_notes && (
                            <div className="text-xs text-warning-600 mt-1">Admin: {s.admin_notes}</div>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <Badge color="gray" variant="soft">{typeLabel(s.suggestion_type)}</Badge>
                      </Td>
                      <Td>
                        <button
                          onClick={() => handleUpvote(s.id)}
                          className="flex items-center gap-1 text-sm hover:text-info-600"
                        >
                          <HandThumbUpIcon className="h-4 w-4" />
                          {s.vote_count}
                        </button>
                      </Td>
                      <Td>
                        <Badge color={statusColor(s.status)} variant="soft">{s.status}</Badge>
                      </Td>
                      <Td>
                        <span className="text-sm text-[var(--gray-a11)]">{s.submitted_by}</span>
                      </Td>
                      <Td>
                        <span className="text-sm text-[var(--gray-a11)]">
                          {new Date(s.created_at).toLocaleString()}
                        </span>
                      </Td>
                      <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                        <RowActions actions={[
                          ...(s.status === 'pending' ? [
                            ...(s.suggestion_type !== 'project' ? [{
                              label: 'Convert to Source',
                              icon: <SignalIcon className="size-4" />,
                              onClick: () => handleConvertToSource(s),
                            }] : []),
                            ...(s.suggestion_type === 'project' ? [{
                              label: 'Convert to Project',
                              icon: <TagIcon className="size-4" />,
                              onClick: () => handleConvertToProject(s),
                            }] : []),
                            {
                              label: 'Approve',
                              icon: <CheckIcon className="size-4" />,
                              onClick: () => handleApprove(s.id),
                            },
                            {
                              label: 'Reject',
                              icon: <XMarkIcon className="size-4" />,
                              onClick: () => handleReject(s.id),
                              color: 'red' as const,
                            },
                          ] : []),
                          {
                            label: 'Delete',
                            icon: <TrashIcon className="size-4" />,
                            onClick: () => setDeleteId(s.id),
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
          title="Delete Suggestion"
          message="Are you sure you want to delete this suggestion?"
          confirmText="Delete"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
