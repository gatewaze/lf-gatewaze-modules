// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * Press module — apiRoutes entry.
 *
 * Mounts:
 *   - Public read endpoints under /api/press/* (no JWT). Filtered to
 *     status='published'; cache-headed for the CDN.
 *   - Admin CRUD under /api/modules/press/admin/* (the platform's
 *     /api/modules/<id> prefix is labelled 'jwt' by the API server,
 *     so the upstream JWT middleware runs first).
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
import { createPublicPressRoutes, mountPublicPressRoutes } from './public-routes.js';
import { createAdminPressRoutes, mountAdminPressRoutes } from './admin-routes.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

function defaultLogger(): PlatformLogger {
  return {
    info: (msg, meta) => console.log(`[press] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[press] ${msg}`, meta ?? ''),
  };
}

export function registerRoutes(app: Express): void {
  const logger = defaultLogger();
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    logger.warn(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — press endpoints will fail',
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Public (no JWT) read endpoints. Mount under /api so the URLs are
  // /api/press and /api/press/:slug — what fetchPressReleases() expects.
  const publicRouter = Router();
  const publicRoutes = createPublicPressRoutes({ supabase, logger });
  mountPublicPressRoutes(publicRouter, publicRoutes);
  app.use('/api', publicRouter);

  // Admin CRUD. The platform labels /api/modules/<id> as 'jwt', so
  // the JWT middleware gates these handlers before they run.
  const adminRouter = Router();
  const adminRoutes = createAdminPressRoutes({ supabase, logger });
  mountAdminPressRoutes(adminRouter, adminRoutes);
  app.use('/api/modules/press', adminRouter);

  logger.info('press module routes registered');
}
