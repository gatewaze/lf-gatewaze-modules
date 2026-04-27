import type { GatewazeModule } from '@gatewaze/shared';

const contentPipelineModule: GatewazeModule = {
  id: 'content-pipeline',
  type: 'feature',
  visibility: 'public',
  name: 'Content Pipeline',
  description: 'AI-powered content intelligence pipeline for discovering, indexing, and serving agentic AI content',
  version: '1.0.0',
  features: [
    'content-pipeline',
    'content-pipeline.submissions',
    'content-pipeline.queue',
    'content-pipeline.items',
    'content-pipeline.taxonomy',
    'content-pipeline.discovery',
    'content-pipeline.suggestions',
  ],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_content_pipeline_tables.sql',
    'migrations/002_seed_taxonomy.sql',
    'migrations/003_monitoring_suggestions.sql',
    'migrations/004_content_duplicates.sql',
    'migrations/005_content_category.sql',
    'migrations/006_idempotency_keys.sql',
    'migrations/007_triage_adapter.sql',
    'migrations/008_keyword_adapter.sql',
    'migrations/009_register_with_platform.sql',
  ],

  adminRoutes: [
    {
      path: 'content-pipeline',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'content-pipeline',
      guard: 'admin',
    },
    {
      path: 'content-pipeline/submissions',
      component: () => import('./admin/pages/submissions'),
      requiredFeature: 'content-pipeline.submissions',
      guard: 'admin',
    },
    {
      path: 'content-pipeline/queue',
      component: () => import('./admin/pages/queue'),
      requiredFeature: 'content-pipeline.queue',
      guard: 'admin',
    },
    {
      path: 'content-pipeline/items',
      component: () => import('./admin/pages/items/index'),
      requiredFeature: 'content-pipeline.items',
      guard: 'admin',
    },
    {
      path: 'content-pipeline/items/:id',
      component: () => import('./admin/pages/items/detail'),
      requiredFeature: 'content-pipeline.items',
      guard: 'admin',
    },
    {
      path: 'content-pipeline/taxonomy',
      component: () => import('./admin/pages/taxonomy'),
      requiredFeature: 'content-pipeline.taxonomy',
      guard: 'admin',
    },
    {
      path: 'content-pipeline/discovery',
      component: () => import('./admin/pages/discovery'),
      requiredFeature: 'content-pipeline.discovery',
      guard: 'admin',
    },
    {
      path: 'content-pipeline/suggestions',
      component: () => import('./admin/pages/suggestions'),
      requiredFeature: 'content-pipeline.suggestions',
      guard: 'admin',
    },
  ],

  // Surfaced inside the Content hub via adminSlots below.
  // Direct routes kept so legacy bookmarks work but no longer show in nav.
  adminNavItems: [],

  adminSlots: [
    // Submissions tab on the unified Inbox at /admin/inbox
    {
      slotName: 'content-platform:inbox-tab',
      component: () => import('./admin/pages/submissions'),
      order: 20,
      requiredFeature: 'content-pipeline.submissions',
      meta: { tabId: 'submissions', label: 'Submissions', description: 'User-submitted content awaiting decision' },
    },
    // Library: what we have
    {
      slotName: 'content-hub:library',
      component: () => import('./admin/pages/items/index'),
      order: 10,
      requiredFeature: 'content-pipeline.items',
      meta: { tabId: 'items', label: 'Content Items', description: 'Browse all ingested content' },
    },
    // Rules: how content is classified
    {
      slotName: 'content-hub:rules',
      component: () => import('./admin/pages/taxonomy'),
      order: 40,
      requiredFeature: 'content-pipeline.taxonomy',
      meta: { tabId: 'taxonomy', label: 'Taxonomy', description: 'Topic + project taxonomies for classification' },
    },
    // Sources: where content comes from + pipeline state
    {
      slotName: 'content-hub:sources',
      component: () => import('./admin/pages/index'),
      order: 5,
      requiredFeature: 'content-pipeline',
      meta: { tabId: 'pipeline-overview', label: 'Pipeline Overview', description: 'Health and stats for the content pipeline' },
    },
    {
      slotName: 'content-hub:sources',
      component: () => import('./admin/pages/discovery'),
      order: 10,
      requiredFeature: 'content-pipeline.discovery',
      meta: { tabId: 'discovery', label: 'Discovery Sources', description: 'Configured sources the pipeline ingests from' },
    },
    {
      slotName: 'content-hub:sources',
      component: () => import('./admin/pages/suggestions'),
      order: 20,
      requiredFeature: 'content-pipeline.suggestions',
      meta: { tabId: 'monitoring-suggestions', label: 'Monitoring Suggestions', description: 'Auto-suggested new sources to add' },
    },
    {
      slotName: 'content-hub:sources',
      component: () => import('./admin/pages/queue'),
      order: 30,
      requiredFeature: 'content-pipeline.queue',
      meta: { tabId: 'processing-queue', label: 'Processing Queue', description: 'In-flight pipeline jobs' },
    },
  ],

  configSchema: {
    openaiApiKey: {
      key: 'openaiApiKey',
      type: 'secret',
      required: false,
      description: 'OpenAI API key for embeddings generation',
    },
    defaultEmbeddingModel: {
      key: 'defaultEmbeddingModel',
      type: 'string',
      required: false,
      default: 'text-embedding-3-small',
      description: 'Default embedding model for vector search',
    },
    maxRetries: {
      key: 'maxRetries',
      type: 'number',
      required: false,
      default: '3',
      description: 'Maximum processing retry attempts',
    },
  },

  onInstall: async () => {
    console.log('[content-pipeline] Module installed');
  },

  onEnable: async () => {
    console.log('[content-pipeline] Module enabled');
  },

  onDisable: async () => {
    console.log('[content-pipeline] Module disabled');
  },
};

export default contentPipelineModule;
