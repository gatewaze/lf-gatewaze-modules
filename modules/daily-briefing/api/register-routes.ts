// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * Daily-briefing module — apiRoutes entry.
 *
 * Mounts:
 *   - Public read endpoints under /api/daily-briefing/* (no JWT).
 *     Filtered to status='published'; cache-headed for the CDN.
 *   - Admin CRUD under /api/modules/daily-briefing/admin/* (the
 *     platform's /api/modules/<id> prefix is labelled 'jwt' by the API
 *     server, so the upstream JWT middleware runs first).
 */

// supabase-js >= 2.50 auto-initialises @supabase/realtime-js which probes
// for a native WebSocket constructor. Node 20 doesn't ship one, and this
// module never uses realtime — supply a no-op stand-in so client
// construction doesn't throw. Safe because no subscribe() call is made.
if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class FakeWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  };
}

import { Router, type Express } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  createPublicDailyBriefingRoutes,
  mountPublicDailyBriefingRoutes,
} from './public-routes.js';
import {
  createAdminDailyBriefingRoutes,
  mountAdminDailyBriefingRoutes,
} from './admin-routes.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

function defaultLogger(): PlatformLogger {
  return {
    info: (msg, meta) => console.log(`[daily-briefing] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[daily-briefing] ${msg}`, meta ?? ''),
  };
}

export function registerRoutes(app: Express): void {
  const logger = defaultLogger();
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    logger.warn(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — daily-briefing endpoints will fail',
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Public (no JWT) read endpoints. Mount under /api so the URLs are
  // /api/daily-briefing and /api/daily-briefing/:id — what
  // fetchDailyBriefingItems() expects.
  const publicRouter = Router();
  const publicRoutes = createPublicDailyBriefingRoutes({ supabase, logger });
  mountPublicDailyBriefingRoutes(publicRouter, publicRoutes);
  app.use('/api', publicRouter);

  // Admin CRUD. The platform labels /api/modules/<id> as 'jwt', so
  // the JWT middleware gates these handlers before they run.
  const adminRouter = Router();
  const adminRoutes = createAdminDailyBriefingRoutes({ supabase, logger });
  mountAdminDailyBriefingRoutes(adminRouter, adminRoutes);
  app.use('/api/modules/daily-briefing', adminRouter);

  logger.info('routes registered');
}
