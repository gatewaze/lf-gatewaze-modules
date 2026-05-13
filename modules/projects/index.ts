import type { GatewazeModule } from '@gatewaze/shared';

const projectsModule: GatewazeModule = {
  id: 'projects',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Projects',
  description: 'Portfolio of open-source / standards projects rendered by the home-page ProjectsSection.',
  version: '1.0.0',
  features: [
    'projects',
    'projects.manage',
  ],

  migrations: [
    'migrations/001_projects_init.sql',
    'migrations/002_webhook_topic.sql',
  ],

  apiRoutes: async (app: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any);
  },

  adminRoutes: [
    {
      path: 'projects',
      component: () => import('./admin/components/ProjectsTab'),
      requiredFeature: 'projects',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/projects',
      label: 'Projects',
      icon: 'Squares2X2',
      requiredFeature: 'projects',
      order: 18,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[projects] Module installed');
  },
  onEnable: async () => {
    console.log('[projects] Module enabled');
  },
  onDisable: async () => {
    console.log('[projects] Module disabled');
  },
};

export default projectsModule;
