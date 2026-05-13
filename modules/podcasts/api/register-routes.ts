// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * Podcasts module — public apiRoutes entry.
 *
 * Mounts:
 *   - Public read endpoints under /api/podcasts/* (no JWT). Filtered to
 *     status='published'; cache-headed for the CDN. Consumed by themes
 *     (AAIF home-page WrittenContentHub "Podcasts" tab).
 *
 * The pre-existing api.ts hosts admin/portal handlers (podcast detail by
 * slug + guest-apply form). This file is layered on top and registered
 * after it from index.ts so both coexist.
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
import { createPublicPodcastsRoutes, mountPublicPodcastsRoutes } from './public-routes.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

function defaultLogger(): PlatformLogger {
  return {
    info: (msg, meta) => console.log(`[podcasts] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[podcasts] ${msg}`, meta ?? ''),
  };
}

export function registerPublicRoutes(app: Express): void {
  const logger = defaultLogger();
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    logger.warn(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — podcasts public endpoints will fail',
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Public (no JWT) read endpoints. Mount under /api so the URLs are
  // /api/podcasts/episodes and /api/podcasts/episodes/:slug — what
  // fetchPodcastEpisodes() expects.
  const publicRouter = Router();
  const publicRoutes = createPublicPodcastsRoutes({ supabase, logger });
  mountPublicPodcastsRoutes(publicRouter, publicRoutes);
  app.use('/api', publicRouter);

  logger.info('podcasts public routes registered');
}
