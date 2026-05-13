import type { GatewazeModule } from '@gatewaze/shared';

const pressModule: GatewazeModule = {
  id: 'press',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Press',
  description:
    'Press releases and external press coverage rendered by the home-page WrittenContentHub "Press & News" tab.',
  version: '1.0.0',
  features: [
    'press',
    'press.manage',
  ],

  migrations: [
    'migrations/001_press_init.sql',
    'migrations/002_webhook_topic.sql',
  ],

  apiRoutes: async (app: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any);
  },

  adminRoutes: [
    {
      path: 'press',
      component: () => import('./admin/components/PressTab'),
      requiredFeature: 'press',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/press',
      label: 'Press',
      icon: 'Newspaper',
      requiredFeature: 'press',
      order: 19,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[press] Module installed');
  },
  onEnable: async () => {
    console.log('[press] Module enabled');
  },
  onDisable: async () => {
    console.log('[press] Module disabled');
  },
};

export default pressModule;
