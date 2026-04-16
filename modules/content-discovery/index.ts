import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

/**
 * Content Discovery module.
 *
 * Thin admin-facing control plane. Exposes the HTTP endpoints that admins
 * call to trigger discovery runs and that Prefect calls back via webhook
 * to update run status. All actual discovery work runs in the self-hosted
 * Prefect worker (see `@premium-gatewaze-modules/prefect-worker`).
 *
 * Depends on `content-pipeline` for the database schema (submissions,
 * queue, items, discovery_sources, discovery_runs).
 */
const contentDiscoveryModule: GatewazeModule = {
  id: 'content-discovery',
  type: 'feature',
  visibility: 'hidden',
  name: 'Content Discovery',
  description:
    'Admin control plane for AI-powered content discovery. Dispatches work to the self-hosted Prefect worker and receives signed webhook callbacks.',
  version: '3.0.0',

  dependencies: ['content-pipeline', 'prefect-worker'],

  features: ['content-discovery', 'content-discovery.run'],

  migrations: [],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  configSchema: {
    PREFECT_API_URL: {
      key: 'PREFECT_API_URL',
      type: 'string',
      required: true,
      description:
        'URL of the in-cluster self-hosted Prefect Server API (e.g. http://gatewaze-prefect-server.gatewaze.svc.cluster.local:4200/api)',
    },
    PREFECT_DISCOVERY_DEPLOYMENT_ID: {
      key: 'PREFECT_DISCOVERY_DEPLOYMENT_ID',
      type: 'string',
      required: true,
      description:
        'Prefect deployment ID for the content-discovery flow. Populated by the prefect-worker module during initial deploy.',
    },
    PREFECT_WEBHOOK_SECRET: {
      key: 'PREFECT_WEBHOOK_SECRET',
      type: 'secret',
      required: true,
      description:
        'Shared HMAC-SHA256 secret used by the Prefect worker to sign webhook callbacks and by this module to verify them.',
    },
  },

  onInstall: async () => {
    console.log(
      '[content-discovery] Module installed — ensure prefect-worker module is also installed and its Prefect Server is reachable at PREFECT_API_URL'
    );
  },

  onEnable: async () => {
    console.log('[content-discovery] Module enabled');
  },

  onDisable: async () => {
    console.log(
      '[content-discovery] Module disabled — in-flight Prefect runs will continue; pause the flow from the Prefect UI if needed'
    );
  },
};

export default contentDiscoveryModule;
