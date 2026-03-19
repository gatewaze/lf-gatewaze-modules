import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import {
  ProjectsService,
  TopicsService,
  generateSlug,
  type ProjectTaxonomy,
  type TopicTaxonomy,
} from '../utils/contentPipelineService';
import { Card, Badge, Button, Tabs, Table, THead, TBody, Tr, Th, Td, ConfirmModal } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';
import { ScrollableTable } from '@/components/shared/table/ScrollableTable';
import { Page } from '@/components/shared/Page';
import { toast } from 'sonner';

// Inline modal for creating/editing projects and topics
function FormModal({
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

export default function TaxonomyPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const searchParams = new URLSearchParams(location.search);
  const activeTab = searchParams.get('tab') || 'projects';

  const [projects, setProjects] = useState<ProjectTaxonomy[]>([]);
  const [topics, setTopics] = useState<TopicTaxonomy[]>([]);
  const [loading, setLoading] = useState(true);

  // Project form
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectTaxonomy | null>(null);
  const [projectForm, setProjectForm] = useState({
    name: '', slug: '', description: '', category: '',
    website_url: '', github_url: '', aliases: '',
  });

  // Topic form
  const [showTopicForm, setShowTopicForm] = useState(false);
  const [editingTopic, setEditingTopic] = useState<TopicTaxonomy | null>(null);
  const [topicForm, setTopicForm] = useState({
    name: '', slug: '', description: '', parent_slug: '',
  });

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'project' | 'topic'; id: string } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [projectsResult, topicsResult] = await Promise.all([
        ProjectsService.getAll(),
        TopicsService.getAll(),
      ]);
      if (projectsResult.data) setProjects(projectsResult.data);
      if (topicsResult.data) setTopics(topicsResult.data);
    } catch (error) {
      console.error('Error loading taxonomy:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTabChange = (tab: string) => navigate(`?tab=${tab}`);

  // Project CRUD
  const openProjectForm = (project?: ProjectTaxonomy) => {
    if (project) {
      setEditingProject(project);
      setProjectForm({
        name: project.name,
        slug: project.slug,
        description: project.description || '',
        category: project.category || '',
        website_url: project.website_url || '',
        github_url: project.github_url || '',
        aliases: (project.aliases || []).join(', '),
      });
    } else {
      setEditingProject(null);
      setProjectForm({ name: '', slug: '', description: '', category: '', website_url: '', github_url: '', aliases: '' });
    }
    setShowProjectForm(true);
  };

  const handleProjectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = {
      name: projectForm.name,
      slug: projectForm.slug || generateSlug(projectForm.name),
      description: projectForm.description || null,
      category: projectForm.category || null,
      website_url: projectForm.website_url || null,
      github_url: projectForm.github_url || null,
      aliases: projectForm.aliases ? projectForm.aliases.split(',').map(a => a.trim()).filter(Boolean) : [],
    };

    const result = editingProject
      ? await ProjectsService.update(editingProject.id, data)
      : await ProjectsService.create(data);

    if (result.success) {
      toast.success(editingProject ? 'Project updated' : 'Project created');
      setShowProjectForm(false);
      loadData();
    } else {
      toast.error(result.error || 'Failed to save project');
    }
  };

  // Topic CRUD
  const openTopicForm = (topic?: TopicTaxonomy) => {
    if (topic) {
      setEditingTopic(topic);
      setTopicForm({
        name: topic.name,
        slug: topic.slug,
        description: topic.description || '',
        parent_slug: topic.parent_slug || '',
      });
    } else {
      setEditingTopic(null);
      setTopicForm({ name: '', slug: '', description: '', parent_slug: '' });
    }
    setShowTopicForm(true);
  };

  const handleTopicSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = {
      name: topicForm.name,
      slug: topicForm.slug || generateSlug(topicForm.name),
      description: topicForm.description || null,
      parent_slug: topicForm.parent_slug || null,
    };

    const result = editingTopic
      ? await TopicsService.update(editingTopic.id, data)
      : await TopicsService.create(data);

    if (result.success) {
      toast.success(editingTopic ? 'Topic updated' : 'Topic created');
      setShowTopicForm(false);
      loadData();
    } else {
      toast.error(result.error || 'Failed to save topic');
    }
  };

  // Delete
  const handleDelete = async () => {
    if (!deleteTarget) return;
    const result = deleteTarget.type === 'project'
      ? await ProjectsService.delete(deleteTarget.id)
      : await TopicsService.delete(deleteTarget.id);

    if (result.success) {
      toast.success(`${deleteTarget.type === 'project' ? 'Project' : 'Topic'} deleted`);
      loadData();
    } else {
      toast.error(result.error || 'Failed to delete');
    }
    setDeleteTarget(null);
  };

  const categoryColor = (cat?: string | null) => {
    switch (cat) {
      case 'protocol': return 'blue';
      case 'framework': return 'purple';
      case 'tool': return 'green';
      case 'standard': return 'orange';
      case 'specification': return 'yellow';
      default: return 'gray';
    }
  };

  return (
    <Page title="Taxonomy">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Taxonomy</h1>
          <p className="text-[var(--gray-11)] mt-1">
            Managed vocabulary of tracked projects and content topics
          </p>
        </div>

        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          tabs={[
            { id: 'projects', label: 'Projects', count: projects.length },
            { id: 'topics', label: 'Topics', count: topics.length },
          ]}
          className="mb-6"
        />

        {/* Projects Tab */}
        {activeTab === 'projects' && (
          <>
            <div className="flex justify-end mb-4">
              <Button variant="solid" onClick={() => openProjectForm()}>
                <PlusIcon className="h-5 w-5 mr-2" /> Add Project
              </Button>
            </div>
            <Card variant="surface" className="overflow-hidden">
              <ScrollableTable>
                <Table>
                  <THead>
                    <Tr>
                      <Th>Name</Th>
                      <Th>Slug</Th>
                      <Th>Category</Th>
                      <Th>Aliases</Th>
                      <Th>Active</Th>
                      <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                    </Tr>
                  </THead>
                  <TBody>
                    {loading ? (
                      <Tr><Td colSpan={6} className="text-center text-[var(--gray-a11)]">Loading...</Td></Tr>
                    ) : projects.length === 0 ? (
                      <Tr><Td colSpan={6} className="text-center text-[var(--gray-a11)]">No projects found</Td></Tr>
                    ) : (
                      projects.map((p) => (
                        <Tr key={p.id}>
                          <Td>
                            <div>
                              <div className="text-sm font-medium">{p.name}</div>
                              {p.description && <div className="text-xs text-[var(--gray-a9)]">{p.description}</div>}
                            </div>
                          </Td>
                          <Td><code className="text-xs">{p.slug}</code></Td>
                          <Td>
                            {p.category && <Badge color={categoryColor(p.category) as any} variant="soft">{p.category}</Badge>}
                          </Td>
                          <Td>
                            <div className="flex flex-wrap gap-1">
                              {(p.aliases || []).map((a) => (
                                <Badge key={a} color="gray" variant="soft" className="text-xs">{a}</Badge>
                              ))}
                            </div>
                          </Td>
                          <Td>
                            <Badge color={p.is_active ? 'green' : 'red'} variant="soft">
                              {p.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </Td>
                          <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                            <RowActions actions={[
                              { label: 'Edit', icon: <PencilIcon className="size-4" />, onClick: () => openProjectForm(p) },
                              { label: 'Delete', icon: <TrashIcon className="size-4" />, onClick: () => setDeleteTarget({ type: 'project', id: p.id }), color: 'red' as const },
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

        {/* Topics Tab */}
        {activeTab === 'topics' && (
          <>
            <div className="flex justify-end mb-4">
              <Button variant="solid" onClick={() => openTopicForm()}>
                <PlusIcon className="h-5 w-5 mr-2" /> Add Topic
              </Button>
            </div>
            <Card variant="surface" className="overflow-hidden">
              <ScrollableTable>
                <Table>
                  <THead>
                    <Tr>
                      <Th>Name</Th>
                      <Th>Slug</Th>
                      <Th>Parent</Th>
                      <Th>Active</Th>
                      <Th data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 2 }} />
                    </Tr>
                  </THead>
                  <TBody>
                    {loading ? (
                      <Tr><Td colSpan={5} className="text-center text-[var(--gray-a11)]">Loading...</Td></Tr>
                    ) : topics.length === 0 ? (
                      <Tr><Td colSpan={5} className="text-center text-[var(--gray-a11)]">No topics found</Td></Tr>
                    ) : (
                      topics.map((t) => (
                        <Tr key={t.id}>
                          <Td>
                            <div>
                              <div className="text-sm font-medium">{t.name}</div>
                              {t.description && <div className="text-xs text-[var(--gray-a9)]">{t.description}</div>}
                            </div>
                          </Td>
                          <Td><code className="text-xs">{t.slug}</code></Td>
                          <Td>
                            {t.parent_slug ? (
                              <Badge color="gray" variant="soft">{t.parent_slug}</Badge>
                            ) : (
                              <span className="text-[var(--gray-a9)]">-</span>
                            )}
                          </Td>
                          <Td>
                            <Badge color={t.is_active ? 'green' : 'red'} variant="soft">
                              {t.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </Td>
                          <Td data-sticky-right style={{ position: 'sticky', right: 0, background: 'var(--color-panel-solid)', zIndex: 1 }}>
                            <RowActions actions={[
                              { label: 'Edit', icon: <PencilIcon className="size-4" />, onClick: () => openTopicForm(t) },
                              { label: 'Delete', icon: <TrashIcon className="size-4" />, onClick: () => setDeleteTarget({ type: 'topic', id: t.id }), color: 'red' as const },
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

        {/* Project Form Modal */}
        <FormModal
          isOpen={showProjectForm}
          onClose={() => setShowProjectForm(false)}
          title={editingProject ? 'Edit Project' : 'Add Project'}
        >
          <form onSubmit={handleProjectSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input
                type="text"
                value={projectForm.name}
                onChange={(e) => setProjectForm(f => ({ ...f, name: e.target.value, slug: f.slug || generateSlug(e.target.value) }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Slug</label>
              <input
                type="text"
                value={projectForm.slug}
                onChange={(e) => setProjectForm(f => ({ ...f, slug: e.target.value }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <textarea
                value={projectForm.description}
                onChange={(e) => setProjectForm(f => ({ ...f, description: e.target.value }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                rows={2}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Category</label>
              <select
                value={projectForm.category}
                onChange={(e) => setProjectForm(f => ({ ...f, category: e.target.value }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="">Select...</option>
                <option value="protocol">Protocol</option>
                <option value="framework">Framework</option>
                <option value="tool">Tool</option>
                <option value="standard">Standard</option>
                <option value="specification">Specification</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Website URL</label>
                <input
                  type="url"
                  value={projectForm.website_url}
                  onChange={(e) => setProjectForm(f => ({ ...f, website_url: e.target.value }))}
                  className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">GitHub URL</label>
                <input
                  type="url"
                  value={projectForm.github_url}
                  onChange={(e) => setProjectForm(f => ({ ...f, github_url: e.target.value }))}
                  className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Aliases (comma-separated)</label>
              <input
                type="text"
                value={projectForm.aliases}
                onChange={(e) => setProjectForm(f => ({ ...f, aliases: e.target.value }))}
                placeholder="e.g. model context protocol, MCP protocol"
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button type="submit" variant="solid">
                {editingProject ? 'Update' : 'Create'}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowProjectForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </FormModal>

        {/* Topic Form Modal */}
        <FormModal
          isOpen={showTopicForm}
          onClose={() => setShowTopicForm(false)}
          title={editingTopic ? 'Edit Topic' : 'Add Topic'}
        >
          <form onSubmit={handleTopicSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name *</label>
              <input
                type="text"
                value={topicForm.name}
                onChange={(e) => setTopicForm(f => ({ ...f, name: e.target.value, slug: f.slug || generateSlug(e.target.value) }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Slug</label>
              <input
                type="text"
                value={topicForm.slug}
                onChange={(e) => setTopicForm(f => ({ ...f, slug: e.target.value }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <textarea
                value={topicForm.description}
                onChange={(e) => setTopicForm(f => ({ ...f, description: e.target.value }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                rows={2}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Parent Topic</label>
              <select
                value={topicForm.parent_slug}
                onChange={(e) => setTopicForm(f => ({ ...f, parent_slug: e.target.value }))}
                className="w-full rounded-md border border-[var(--gray-a6)] bg-[var(--color-background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="">None (top-level)</option>
                {topics.filter(t => !t.parent_slug).map((t) => (
                  <option key={t.slug} value={t.slug}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 pt-2">
              <Button type="submit" variant="solid">
                {editingTopic ? 'Update' : 'Create'}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowTopicForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </FormModal>

        {/* Delete Confirmation */}
        <ConfirmModal
          isOpen={deleteTarget !== null}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          title={`Delete ${deleteTarget?.type === 'project' ? 'Project' : 'Topic'}`}
          message={`Are you sure you want to delete this ${deleteTarget?.type}? This may affect content tagging.`}
          confirmText="Delete"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
