import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import { Switch as RadixSwitch } from '@radix-ui/themes';
import {
  DiscoverySourcesService,
  type DiscoverySource,
  type DiscoveryRun,
} from '../utils/contentPipelineService';
import { Card, Badge, Button, Tabs, Table, THead, TBody, Tr, Th, Td, ConfirmModal } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { toast } from 'sonner';

function SourceFormModal({
  isOpen,
  onClose,
  title,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--color-background)] rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h3 className="text-lg font-semibold mb-4">{title}</h3>
          {children}
        </div>
      </div>
    </div>
  );
}

const SOURCE_TYPES = [
  { value: 'rss', label: 'RSS Feed' },
  { value: 'youtube_channel', label: 'YouTube Channel' },
  { value: 'youtube_search', label: 'YouTube Search' },
  { value: 'google_search', label: 'Google Search' },
  { value: 'github_topic', label: 'GitHub Topic' },
  { value: 'github_repo', label: 'GitHub Repo' },
  { value: 'twitter_account', label: 'Twitter/X Account' },
  { value: 'reddit_subreddit', label: 'Reddit Subreddit' },
  { value: 'hackernews', label: 'Hacker News' },
  { value: 'website', label: 'Website' },
];

const FREQUENCIES = [
  { value: '1 hour', label: 'Every hour' },
  { value: '3 hours', label: 'Every 3 hours' },
  { value: '6 hours', label: 'Every 6 hours' },
  { value: '12 hours', label: 'Every 12 hours' },
  { value: '1 day', label: 'Daily' },
  { value: '7 days', label: 'Weekly' },
];

export default function DiscoveryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const activeTab = searchParams.get('tab') || 'sources';

  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingSource, setEditingSource] = useState<DiscoverySource | null>(null);
  const [form, setForm] = useState({
    name: '', source_type: 'rss', source_url: '', search_query: '',
    check_frequency: '6 hours', priority: 3,
  });

  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [sourcesResult, runsResult] = await Promise.all([
        DiscoverySourcesService.getAll(),
        DiscoverySourcesService.getRecentRuns(undefined, 50),
      ]);
      if (sourcesResult.data) setSources(sourcesResult.data);
      if (runsResult.data) setRuns(runsResult.data);
    } catch (error) {
      console.error('Error loading discovery data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTabChange = (tab: string) => navigate(`?tab=${tab}`);

  const openForm = (source?: DiscoverySource) => {
    if (source) {
      setEditingSource(source);
      setForm({
        name: source.name,
        source_type: source.source_type,
        source_url: source.source_url || '',
        search_query: source.search_query || '',
        check_frequency: source.check_frequency,
        priority: source.priority,
      });
    } else {
      setEditingSource(null);
      setForm({ name: '', source_type: 'rss', source_url: '', search_query: '', check_frequency: '6 hours', priority: 3 });
    }
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = {
      name: form.name,
      source_type: form.source_type,
      source_url: form.source_url || null,
      search_query: form.search_query || null,
      check_frequency: form.check_frequency,
      priority: form.priority,
    };

    const result = editingSource
      ? await DiscoverySourcesService.update(editingSource.id, data)
      : await DiscoverySourcesService.create(data);

    if (result.success) {
      toast.success(editingSource ? 'Source updated' : 'Source created');
      setShowForm(false);
      loadData();
    } else {
      toast.error(result.error || 'Failed to save');
    }
  };

  const handleToggle = async (id: string, isActive: boolean) => {
    const result = await DiscoverySourcesService.update(id, { is_active: isActive });
    if (result.success) {
      setSources(prev => prev.map(s => s.id === id ? { ...s, is_active: isActive } : s));
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    const result = await DiscoverySourcesService.delete(deleteId);
    if (result.success) {
      toast.success('Source deleted');
      loadData();
    } else {
      toast.error(result.error || 'Failed to delete');
    }
    setDeleteId(null);
  };

  const sourceTypeLabel = (type: string) =>
    SOURCE_TYPES.find(t => t.value === type)?.label || type;

  const runStatusIcon = (status: string) => {
    switch (status) {
      case 'running': return <ClockIcon className="h-4 w-4 text-yellow-500" style={{ animation: 'spin 3s linear infinite' }} />;
      case 'completed': return <CheckCircleIcon className="h-4 w-4 text-success-500" />;
      case 'failed': return <XCircleIcon className="h-4 w-4 text-error-500" />;
      default: return null;
    }
  };

  return (
    <Page title="Discovery Sources">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Discovery Sources</h1>
          <p className="text-[var(--gray-11)] mt-1">
            Configure content sources that the discovery agent monitors for new agentic AI content
          </p>
        </div>

        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          tabs={[
            { id: 'sources', label: 'Sources', count: sources.length },
            { id: 'runs', label: 'Recent Runs', count: runs.length },
          ]}
          className="mb-6"
        />

        {/* Sources Tab */}
        {activeTab === 'sources' && (
          <>
            <div className="flex justify-end mb-4">
              <Button variant="solid" onClick={() => openForm()}>
                <PlusIcon className="h-5 w-5 mr-2" /> Add Source
              </Button>
            </div>
            <Card variant="surface" className="overflow-hidden">
              <ScrollableTable>
                <Table>
                  <THead>
                    <Tr>
                      <Th>Name</Th>
                      <Th>Type</Th>
                      <Th>URL / Query</Th>
                      <Th>Frequency</Th>
                      <Th>Priority</Th>
                      <Th>Last Checked</Th>
                      <Th>Active</Th>
                      <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                    </Tr>
                  </THead>
                  <TBody>
                    {loading ? (
                      <Tr><Td colSpan={8} className="text-center text-[var(--gray-a11)]">Loading...</Td></Tr>
                    ) : sources.length === 0 ? (
                      <Tr><Td colSpan={8} className="text-center text-[var(--gray-a11)]">No sources configured</Td></Tr>
                    ) : (
                      sources.map((source) => (
                        <Tr key={source.id}>
                          <Td>
                            <span className="text-sm font-medium">{source.name}</span>
                          </Td>
                          <Td>
                            <Badge color="info" variant="soft">{sourceTypeLabel(source.source_type)}</Badge>
                          </Td>
                          <Td>
                            <span className="text-sm text-[var(--gray-a11)] truncate block max-w-xs">
                              {source.source_url || source.search_query || '-'}
                            </span>
                          </Td>
                          <Td>
                            <span className="text-sm">{source.check_frequency}</span>
                          </Td>
                          <Td>
                            <span className="text-sm">P{source.priority}</span>
                          </Td>
                          <Td>
                            <span className="text-sm text-[var(--gray-a11)]">
                              {source.last_checked_at ? new Date(source.last_checked_at).toLocaleString() : 'Never'}
                            </span>
                          </Td>
                          <Td>
                            <RadixSwitch
                              checked={source.is_active}
                              onCheckedChange={(checked) => handleToggle(source.id, checked)}
                            />
                          </Td>
                          <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                            <RowActions actions={[
                              { label: 'Edit', icon: <PencilIcon className="size-4" />, onClick: () => openForm(source) },
                              { label: 'Delete', icon: <TrashIcon className="size-4" />, onClick: () => setDeleteId(source.id), color: 'red' as const },
                            ]} />
                          </Td>
                        </Tr>
                      ))
                    )}
                  </TBody>
                </Table>
              </ScrollableTable>
            </Card>
          </>
        )}

        {/* Runs Tab */}
        {activeTab === 'runs' && (
          <Card variant="surface" className="overflow-hidden">
            <ScrollableTable>
              <Table>
                <THead>
                  <Tr>
                    <Th>Source</Th>
                    <Th>Status</Th>
                    <Th>Items Found</Th>
                    <Th>Items Submitted</Th>
                    <Th>Started</Th>
                    <Th>Completed</Th>
                    <Th>Error</Th>
                  </Tr>
                </THead>
                <TBody>
                  {loading ? (
                    <Tr><Td colSpan={7} className="text-center text-[var(--gray-a11)]">Loading...</Td></Tr>
                  ) : runs.length === 0 ? (
                    <Tr><Td colSpan={7} className="text-center text-[var(--gray-a11)]">No discovery runs yet</Td></Tr>
                  ) : (
                    runs.map((run) => (
                      <Tr key={run.id}>
                        <Td>
                          <span className="text-sm font-medium">{run.source?.name || '-'}</span>
                        </Td>
                        <Td>
                          <div className="flex items-center gap-1">
                            {runStatusIcon(run.status)}
                            <span className="text-sm">{run.status}</span>
                          </div>
                        </Td>
                        <Td><span className="text-sm">{run.items_found}</span></Td>
                        <Td><span className="text-sm">{run.items_submitted}</span></Td>
                        <Td>
                          <span className="text-sm text-[var(--gray-a11)]">
                            {new Date(run.started_at).toLocaleString()}
                          </span>
                        </Td>
                        <Td>
                          <span className="text-sm text-[var(--gray-a11)]">
                            {run.completed_at ? new Date(run.completed_at).toLocaleString() : '-'}
                          </span>
                        </Td>
                        <Td>
                          {run.error_message && (
                            <span className="text-xs text-error-600 truncate block max-w-xs">{run.error_message}</span>
                          )}
                        </Td>
                      </Tr>
                    ))
                  )}
                </TBody>
              </Table>
            </ScrollableTable>
          </Card>
        )}

        {/* Source Form Modal */}
        <SourceFormModal
          isOpen={showForm}
          onClose={() => setShowForm(false)}
          title={editingSource ? 'Edit Discovery Source' : 'Add Discovery Source'}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Anthropic Blog RSS"
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Source Type *</label>
              <select
                value={form.source_type}
                onChange={(e) => setForm(f => ({ ...f, source_type: e.target.value }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {SOURCE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Source URL</label>
              <input
                type="url"
                value={form.source_url}
                onChange={(e) => setForm(f => ({ ...f, source_url: e.target.value }))}
                placeholder="https://..."
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Search Query</label>
              <input
                type="text"
                value={form.search_query}
                onChange={(e) => setForm(f => ({ ...f, search_query: e.target.value }))}
                placeholder="e.g. MCP model context protocol"
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Check Frequency</label>
                <select
                  value={form.check_frequency}
                  onChange={(e) => setForm(f => ({ ...f, check_frequency: e.target.value }))}
                  className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Priority</label>
                <select
                  value={form.priority}
                  onChange={(e) => setForm(f => ({ ...f, priority: parseInt(e.target.value) }))}
                  className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value={1}>1 - Highest</option>
                  <option value={2}>2 - High</option>
                  <option value={3}>3 - Normal</option>
                  <option value={4}>4 - Low</option>
                  <option value={5}>5 - Lowest</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button type="submit" variant="solid">
                {editingSource ? 'Update' : 'Create'}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </SourceFormModal>

        <ConfirmModal
          isOpen={deleteId !== null}
          onClose={() => setDeleteId(null)}
          onConfirm={handleDelete}
          title="Delete Discovery Source"
          message="Are you sure you want to delete this discovery source and all its run history? This action cannot be undone."
          confirmText="Delete"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
