import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

/**
 * Membership module — tracks AAIF (or other) member organizations and their
 * tier. Auto-syncs each member as a content-keywords rule so events / blog
 * posts / podcasts that mention them get tagged + ranked by tier.
 */
const membershipModule: GatewazeModule = {
  id: 'membership',
  type: 'feature',
  visibility: 'hidden',
  name: 'Membership',
  description: 'Tracks member organizations + tiers, auto-syncs to content-keywords rules so member-mentioning content gets categorized + ranked by tier.',
  version: '1.0.0',
  features: [
    'membership',
    'membership.manage',
    'membership.sync',
  ],

  dependencies: ['content-keywords'],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  workers: [
    {
      name: 'membership:sync',
      handler: './worker/sync-aaif.js',
      concurrency: 1,
    },
  ],

  migrations: [
    'migrations/001_member_organizations.sql',
    'migrations/002_keyword_rule_sync.sql',
    'migrations/003_extend_events_adapter.sql',
    'migrations/004_seed_aaif_tier_ranks.sql',
  ],

  // Surfaced inside the Content hub via adminSlots — Library tab.
  adminRoutes: [
    {
      path: 'membership',
      component: () => import('./admin/pages/MembersPage'),
      requiredFeature: 'membership',
      guard: 'admin',
    },
    {
      path: 'membership/:id',
      component: () => import('./admin/pages/MemberDetailPage'),
      requiredFeature: 'membership.manage',
      guard: 'admin',
    },
  ],

  adminNavItems: [],

  adminSlots: [
    {
      slotName: 'content-hub:library',
      component: () => import('./admin/pages/MembersPage'),
      order: 30,
      requiredFeature: 'membership',
      meta: { tabId: 'members', label: 'Members', description: 'Member organizations + tiers' },
    },
  ],

  configSchema: {
    aaif_members_url: {
      key: 'aaif_members_url',
      type: 'string',
      required: false,
      default: 'https://aaif.io/members/',
      description: 'URL the AAIF members scraper hits each sync run.',
    },
  },

  onInstall: async () => {
    console.log('[membership] Module installed — run a sync to populate members.');
  },
};

export default membershipModule;
