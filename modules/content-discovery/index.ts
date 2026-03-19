import type { GatewazeModule } from '@gatewaze/shared';

const contentDiscoveryModule: GatewazeModule = {
  id: 'content-discovery',
  type: 'feature',
  visibility: 'hidden',
  name: 'Content Discovery',
  description: 'Automated content discovery powered by Helix.ml agents that monitor configured sources for new agentic AI content',
  version: '2.0.0',

  dependencies: ['content-pipeline'],

  features: [
    'content-discovery',
    'content-discovery.run',
  ],

  // Workers and schedulers are handled by Helix agents (see helix/ directory).
  // The discovery, triage, and processing agents connect directly to Supabase
  // via the Supabase MCP server and are triggered by Helix cron schedules:
  //   - Discovery Agent: hourly (0 * * * *)
  //   - Triage Agent: every 5 minutes (*/5 * * * *)
  //   - Processing Agent: every 5 minutes (*/5 * * * *)

  migrations: [],

  configSchema: {
    helixApiUrl: {
      key: 'helixApiUrl',
      type: 'string',
      required: false,
      default: 'https://app.tryhelix.ai',
      description: 'Helix API base URL (cloud or self-hosted)',
    },
    helixDiscoveryAgentKey: {
      key: 'helixDiscoveryAgentKey',
      type: 'secret',
      required: false,
      description: 'API key for the Helix Discovery Agent',
    },
    helixTriageAgentKey: {
      key: 'helixTriageAgentKey',
      type: 'secret',
      required: false,
      description: 'API key for the Helix Triage Agent',
    },
    helixProcessingAgentKey: {
      key: 'helixProcessingAgentKey',
      type: 'secret',
      required: false,
      description: 'API key for the Helix Processing Agent',
    },
  },

  onInstall: async () => {
    console.log('[content-discovery] Module installed — deploy Helix agents from helix/ directory');
  },

  onEnable: async () => {
    console.log('[content-discovery] Module enabled — ensure Helix agents are deployed and running');
  },

  onDisable: async () => {
    console.log('[content-discovery] Module disabled — consider pausing Helix agent cron triggers');
  },
};

export default contentDiscoveryModule;
