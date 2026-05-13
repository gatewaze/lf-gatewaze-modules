import type { GatewazeModule } from '@gatewaze/shared';

const dailyBriefingModule: GatewazeModule = {
  id: 'daily-briefing',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Daily Briefing',
  description:
    'Short-form daily AI news items rendered by the AAIF home-page Hero sidebar (Daily Agentic AI LinkedIn Newsletter).',
  version: '1.0.0',
  features: [
    'daily-briefing',
    'daily-briefing.manage',
  ],

  migrations: [
    'migrations/001_daily_briefing_init.sql',
    'migrations/002_webhook_topic.sql',
  ],

  apiRoutes: async (app: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any);
  },

  adminRoutes: [
    {
      path: 'daily-briefing',
      component: () => import('./admin/components/DailyBriefingTab'),
      requiredFeature: 'daily-briefing',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/daily-briefing',
      label: 'Daily Briefing',
      // navigationIcons resolves short Heroicon names; `NewspaperClipping`
      // is a Phosphor icon and didn't render. `Rss` is a Heroicon, fits
      // the "feed of briefings" mental model, and differs from press
      // (`Newspaper`) so the two sidebar entries are distinguishable.
      icon: 'Rss',
      requiredFeature: 'daily-briefing',
      order: 20,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[daily-briefing] Module installed');
  },
  onEnable: async () => {
    console.log('[daily-briefing] Module enabled');
  },
  onDisable: async () => {
    console.log('[daily-briefing] Module disabled');
  },
};

export default dailyBriefingModule;
