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
    'migrations/006_drop_legacy_research_tables.sql',
    'migrations/007_items_why.sql',
  ],

  // Weekday autopilot — every weekday at 04:00 UTC (midnight US East /
  // 21:00 US Pacific), provision today's day (if not already created)
  // and run the AI research pass against it so the chat panel is
  // pre-populated when an operator arrives. Skips any site whose day
  // already has items or a non-empty thread (we never overwrite
  // operator work). See workers/weekday-autopilot.ts for the handler.
  workers: [
    {
      name: 'daily-briefing.weekday-autopilot',
      handler: './workers/weekday-autopilot.ts',
    },
    // spec-ai-job-runner — moves research-kickoff off the API process
    // so each model's run appears in /admin/ai/jobs and survives an
    // API restart. The chat itself still uses the AI module's runChat;
    // this handler is the daily-briefing-specific wrapper that knows
    // about structuredTool=submit_candidates + the dedup list.
    {
      name: 'daily-briefing:run-research',
      handler: './workers/run-research-handler.ts',
      concurrency: Number(process.env.DAILY_BRIEFING_RESEARCH_CONCURRENCY ?? 3),
    },
  ],
  crons: [
    {
      name: 'daily-briefing.weekday-autopilot',
      queue: 'jobs',
      schedule: { pattern: '0 4 * * 1-5', tz: 'UTC' },
      data: { kind: 'daily-briefing.weekday-autopilot' },
    },
  ],

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerRoutes(app as any, ctx as any);
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
