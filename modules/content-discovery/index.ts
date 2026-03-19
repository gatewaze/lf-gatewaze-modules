import type { GatewazeModule } from '@gatewaze/shared';

const contentDiscoveryModule: GatewazeModule = {
  id: 'content-discovery',
  type: 'feature',
  visibility: 'hidden',
  name: 'Content Discovery',
  description: 'Automated content discovery agent that monitors configured sources for new agentic AI content',
  version: '1.0.0',

  dependencies: ['content-pipeline'],

  features: [
    'content-discovery',
    'content-discovery.run',
  ],

  // Workers process discovery, triage, and content processing jobs
  workers: [
    {
      name: 'content-discovery',
      handler: './workers/discovery-worker.ts',
      concurrency: 2,
    },
    {
      name: 'content-triage',
      handler: './workers/triage-worker.ts',
      concurrency: 3,
    },
    {
      name: 'content-processing',
      handler: './workers/processing-worker.ts',
      concurrency: 2,
    },
  ],

  // Schedulers run discovery on configured intervals
  schedulers: [
    {
      name: 'content-discovery-hourly',
      cron: '0 * * * *', // Every hour
      handler: './schedulers/discovery-scheduler.ts',
    },
    {
      name: 'content-refresh-weekly',
      cron: '0 3 * * 0', // Sunday at 3am
      handler: './schedulers/refresh-scheduler.ts',
    },
  ],

  migrations: [],

  configSchema: {
    youtubeApiKey: {
      key: 'youtubeApiKey',
      type: 'secret',
      required: false,
      description: 'YouTube Data API key for channel/search discovery',
    },
    googleSearchApiKey: {
      key: 'googleSearchApiKey',
      type: 'secret',
      required: false,
      description: 'Google Custom Search API key',
    },
    googleSearchCx: {
      key: 'googleSearchCx',
      type: 'string',
      required: false,
      description: 'Google Custom Search engine ID',
    },
    anthropicApiKey: {
      key: 'anthropicApiKey',
      type: 'secret',
      required: false,
      description: 'Anthropic API key for content summarization and segmentation',
    },
  },

  onInstall: async () => {
    console.log('[content-discovery] Module installed');
  },

  onEnable: async () => {
    console.log('[content-discovery] Module enabled — discovery schedulers will start');
  },

  onDisable: async () => {
    console.log('[content-discovery] Module disabled — discovery schedulers stopped');
  },
};

export default contentDiscoveryModule;
