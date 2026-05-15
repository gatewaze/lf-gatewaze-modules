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
    'migrations/003_restructure_to_days.sql',
    'migrations/004_webhook_topics_days.sql',
    'migrations/005_research_threads.sql',
  ],

  // TODO(daily-briefing): wire the weekday autopilot cron once the
  // research-runner + worker handler land. Planned shape:
  //   crons: [{
  //     name: 'daily-briefing.weekday-autopilot',
  //     queue: 'jobs',
  //     schedule: { pattern: '0 4 * * 1-5', tz: 'UTC' },
  //     data: { kind: 'daily-briefing.weekday-autopilot' },
  //   }],
  //   workers: [{
  //     name: 'daily-briefing.weekday-autopilot',
  //     handler: 'workers/weekday-autopilot.ts',
  //   }],
  // Declaring the cron without a handler crashes the scheduler at boot,
  // so the wiring lands together with the handler.

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
