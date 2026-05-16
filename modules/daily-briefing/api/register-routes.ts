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
import { makeDayImageGenerator } from '../lib/gemini-image.js';
import { makeResearchRunner } from '../lib/research-runner.js';

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

  // Image-gen — bridged through @gatewaze-modules/ai's aiGenerateImage.
  // The ai module's credential router handles GEMINI_API_KEY resolution
  // (via the daily-briefing-cover use-case credential pin or env), so
  // the bridge here is unconditional; if the key is missing the admin
  // endpoint surfaces a clean 503 from the ai module instead of a 500.
  const generateDayImage = makeDayImageGenerator({ supabase });

  // Research autopilot — bridged through @gatewaze-modules/ai per
  // spec-ai-module.md Phase B. The new module's runChat handles
  // credentials, cost ledger, retries, and the per-use-case daily cap.
  // We still need the scrapling-fetcher resolver for the fetch_url
  // tool (the ai module accepts it as an optional dep).
  const scraplingFetcherUrl = process.env.SCRAPLING_FETCHER_URL ?? '';
  const scraplingInternalToken = process.env.SCRAPLING_INTERNAL_TOKEN ?? '';
  const resolveFetchUrl = scraplingFetcherUrl && scraplingInternalToken
    ? buildScraplingFetchResolver(scraplingFetcherUrl, scraplingInternalToken)
    : undefined;
  if (!resolveFetchUrl) {
    logger.warn(
      'SCRAPLING_FETCHER_URL / SCRAPLING_INTERNAL_TOKEN not set — research autopilot will run without fetch_url (model relies on web_search alone)',
    );
  }
  const runResearch = makeResearchRunner({ supabase, resolveFetchUrl, logger });

  // Admin CRUD. The platform labels /api/modules/<id> as 'jwt', so
  // the JWT middleware gates these handlers before they run.
  const adminRouter = Router();
  const adminRoutes = createAdminDailyBriefingRoutes({
    supabase,
    logger,
    generateDayImage,
    runResearch,
  });
  mountAdminDailyBriefingRoutes(adminRouter, adminRoutes);
  app.use('/api/modules/daily-briefing', adminRouter);

  logger.info('routes registered');
}

/**
 * Build a scrapling-fetcher resolver matching the shape the ai module's
 * runChat expects. Returns wrapped content for safe model consumption.
 */
function buildScraplingFetchResolver(
  baseUrl: string,
  token: string,
): (url: string, reason: string) => Promise<{
  ok: boolean;
  content: string;
  bytesIn: number;
  finalUrl: string;
  error?: string;
}> {
  const MAX_BYTES = 200_000;
  const TIMEOUT_MS = 20_000;
  return async (url, reason) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': token },
        body: JSON.stringify({ url, mode: 'fast', extract: ['html'], timeout_ms: TIMEOUT_MS - 1000 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ok: false, content: '', bytesIn: 0, finalUrl: url,
          error: `upstream ${response.status}`,
        };
      }
      const data = (await response.json()) as {
        data?: { html?: string; final_url?: string; bytes_in?: number };
      };
      const html = data.data?.html ?? '';
      const truncated = html.length > MAX_BYTES ? html.slice(0, MAX_BYTES) + '\n[…truncated]' : html;
      return {
        ok: true,
        content: `<fetched_content url="${data.data?.final_url ?? url}" reason="${reason}">\n${truncated}\n</fetched_content>`,
        bytesIn: data.data?.bytes_in ?? html.length,
        finalUrl: data.data?.final_url ?? url,
      };
    } catch (err) {
      return {
        ok: false, content: '', bytesIn: 0, finalUrl: url,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
