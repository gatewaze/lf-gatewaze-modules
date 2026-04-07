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

  migrations: [
    'migrations/001_content_pipeline_tables.sql',
    'migrations/002_seed_taxonomy.sql',
    'migrations/003_monitoring_suggestions.sql',
    'migrations/004_content_duplicates.sql',
    'migrations/005_content_category.sql',
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

  adminNavItems: [
    {
      path: '/admin/content-pipeline',
      label: 'Content Pipeline',
      icon: 'Workflow',
      requiredFeature: 'content-pipeline',
      parentGroup: 'admin',
      order: 40,
    },
    {
      path: '/admin/content-pipeline/submissions',
      label: 'Submissions',
      icon: 'Inbox',
      requiredFeature: 'content-pipeline.submissions',
      parentGroup: 'admin',
      order: 41,
    },
    {
      path: '/admin/content-pipeline/queue',
      label: 'Processing Queue',
      icon: 'ListOrdered',
      requiredFeature: 'content-pipeline.queue',
      parentGroup: 'admin',
      order: 42,
    },
    {
      path: '/admin/content-pipeline/items',
      label: 'Content Items',
      icon: 'Library',
      requiredFeature: 'content-pipeline.items',
      parentGroup: 'admin',
      order: 43,
    },
    {
      path: '/admin/content-pipeline/taxonomy',
      label: 'Taxonomy',
      icon: 'Tags',
      requiredFeature: 'content-pipeline.taxonomy',
      parentGroup: 'admin',
      order: 44,
    },
    {
      path: '/admin/content-pipeline/discovery',
      label: 'Discovery Sources',
      icon: 'Radar',
      requiredFeature: 'content-pipeline.discovery',
      parentGroup: 'admin',
      order: 45,
    },
    {
      path: '/admin/content-pipeline/suggestions',
      label: 'Monitoring Suggestions',
      icon: 'Lightbulb',
      requiredFeature: 'content-pipeline.suggestions',
      parentGroup: 'admin',
      order: 46,
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
