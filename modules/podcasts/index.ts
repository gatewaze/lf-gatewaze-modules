import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const podcastsModule: GatewazeModule = {
  id: 'podcasts',
  type: 'feature',
  visibility: 'public',
  name: 'Podcasts',
  description: 'Manage podcast series, episodes, and guest lists with public guest application forms',
  version: '1.0.0',
  features: [
    'podcasts',
    'podcasts.manage',
    'podcasts.guest-list',
  ],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_podcasts_tables.sql',
    'migrations/002_content_category.sql',
    'migrations/003_triage_adapter.sql',
    'migrations/004_keyword_adapter.sql',
    'migrations/005_register_with_platform.sql',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  adminRoutes: [
    {
      path: 'podcasts',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'podcasts',
      guard: 'admin',
    },
    {
      path: 'podcasts/guests',
      component: () => import('./admin/pages/guests/index'),
      requiredFeature: 'podcasts.guest-list',
      guard: 'admin',
    },
    {
      path: 'podcasts/:podcastId',
      component: () => import('./admin/pages/detail'),
      requiredFeature: 'podcasts.manage',
      guard: 'admin',
    },
    {
      path: 'podcasts/:podcastId/episodes/:episodeId',
      component: () => import('./admin/pages/episodes/detail'),
      requiredFeature: 'podcasts.manage',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/podcasts',
      label: 'Podcasts',
      icon: 'Microphone',
      requiredFeature: 'podcasts',
      parentGroup: 'admin',
      order: 50,
    },
    {
      path: '/admin/podcasts/guests',
      label: 'Guest List',
      icon: 'Users',
      requiredFeature: 'podcasts.guest-list',
      parentGroup: 'admin',
      order: 51,
    },
  ],

  portalRoutes: [
    {
      path: '/podcasts/:slug/apply',
      component: () => import('./portal/pages/guest-apply'),
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[podcasts] Module installed');
  },
  onEnable: async () => {
    console.log('[podcasts] Module enabled');
  },
  onDisable: async () => {
    console.log('[podcasts] Module disabled');
  },
};

export default podcastsModule;
