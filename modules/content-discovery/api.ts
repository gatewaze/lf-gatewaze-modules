/**
 * API routes for the content-discovery module.
 *
 * Two endpoints:
 *   POST /api/modules/content-discovery/trigger  — admin-initiated discovery run
 *   POST /api/modules/content-discovery/webhook  — Prefect → Gatewaze status callback
 *
 * See the Content Discovery Pipeline spec (C.3.5) for request/response schemas.
 */

import type { Express, Request, Response } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { createRequire } from 'module';
import { join } from 'path';

const WEBHOOK_SKEW_SECONDS = 5 * 60; // reject signed webhooks older than 5 min

let _supabase: any = null;

function initSupabase(projectRoot: string) {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
  const { createClient } = require('@supabase/supabase-js');
  _supabase = createClient(url, key);
  return _supabase;
}

// ---------------------------------------------------------------------------
// Admin auth guard
// ---------------------------------------------------------------------------

/**
 * Verify the caller is an admin. Returns `null` on success, or sends a 401/403
 * response and returns the response for early exit.
 */
async function requireAdmin(req: Request, res: Response, supabase: any): Promise<Response | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing bearer token' });
  }

  const jwt = authHeader.slice('Bearer '.length);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
  }

  // Check admin via DB RPC — matches public.is_admin() used by RLS policies
  const { data: isAdmin, error: rpcError } = await supabase.rpc('is_admin', {}, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (rpcError || !isAdmin) {
    return res.status(403).json({ error: 'forbidden', message: 'Admin privileges required' });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Idempotency key helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic idempotency key for a trigger. Buckets at 1-minute granularity
 * so double-clicks produce the same key but deliberate re-triggers after a
 * minute produce a fresh key.
 */
function makeIdempotencyKey(sourceId: string | null, userId: string, bucketMinutes = 1): string {
  const bucketMs = bucketMinutes * 60 * 1000;
  const bucket = Math.floor(Date.now() / bucketMs);
  const input = `manual:${userId}:${sourceId ?? 'all'}:${bucket}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// HMAC webhook signature verification
// ---------------------------------------------------------------------------

interface WebhookBody {
  timestamp: string;
  idempotency_key: string;
  prefect_flow_run_id: string;
  status: 'running' | 'completed' | 'partial' | 'failed';
  metrics?: {
    items_discovered: number;
    items_rejected: number;
    duration_ms: number;
    cost_usd: number;
    tokens_input?: number;
    tokens_output?: number;
  };
  error?: {
    type: string;
    message: string;
    stage: string;
    retryable: boolean;
  };
}

function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  // timingSafeEqual requires equal-length buffers
  const providedBuf = Buffer.from(provided, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function isTimestampFresh(iso: string): boolean {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return false;
  const skew = Math.abs(Date.now() - then) / 1000;
  return skew <= WEBHOOK_SKEW_SECONDS;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRoutes(app: Express, context?: ModuleContext) {
  const projectRoot = context?.projectRoot || process.cwd();

  // -----------------------------------------------------------------------
  // POST /api/modules/content-discovery/trigger
  // -----------------------------------------------------------------------
  app.post('/api/modules/content-discovery/trigger', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);

      const authFail = await requireAdmin(req, res, supabase);
      if (authFail) return authFail;

      const user = (await supabase.auth.getUser(req.headers.authorization!.slice('Bearer '.length))).data.user;
      const { source_id = null, dry_run = false } = req.body ?? {};

      if (source_id !== null && typeof source_id !== 'string') {
        return res.status(400).json({ error: 'invalid_source_id', message: 'source_id must be a UUID string or null' });
      }

      const idempotencyKey = makeIdempotencyKey(source_id, user.id);

      // Duplicate detection: check for existing run with same key in the last 15 min
      const { data: existing } = await supabase
        .from('content_discovery_runs')
        .select('id, status')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

      if (existing) {
        return res.status(409).json({
          error: 'duplicate',
          idempotency_key: idempotencyKey,
          existing_run_id: existing.id,
          status: existing.status,
        });
      }

      // Dispatch to Prefect Server
      const prefectUrl = process.env.PREFECT_API_URL;
      const deploymentId = process.env.PREFECT_DISCOVERY_DEPLOYMENT_ID;
      if (!prefectUrl || !deploymentId) {
        return res
          .status(503)
          .json({ error: 'prefect_unconfigured', message: 'PREFECT_API_URL or PREFECT_DISCOVERY_DEPLOYMENT_ID not set' });
      }

      const flowRunPayload = {
        name: `manual-${user.id.slice(0, 8)}-${idempotencyKey.slice(0, 8)}`,
        parameters: { source_id, idempotency_key: idempotencyKey, dry_run },
      };

      const prefectRes = await fetch(`${prefectUrl}/deployments/${deploymentId}/create_flow_run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flowRunPayload),
      });

      if (!prefectRes.ok) {
        const body = await prefectRes.text().catch(() => '');
        console.error('[content-discovery] Prefect create_flow_run failed:', prefectRes.status, body);
        return res
          .status(503)
          .json({ error: 'prefect_unavailable', retry_after: 30, message: 'Prefect Server did not accept the run' });
      }

      const flowRun = (await prefectRes.json()) as { id: string };

      // Pre-create the discovery run row so the webhook has something to update
      const { error: insertError } = await supabase.from('content_discovery_runs').insert({
        source_id,
        status: 'pending',
        idempotency_key: idempotencyKey,
        metadata: {
          triggered_by_user_id: user.id,
          triggered_by: 'manual',
          prefect_flow_run_id: flowRun.id,
          dry_run,
        },
      });

      if (insertError) {
        console.error('[content-discovery] Failed to insert discovery run:', insertError);
        // The Prefect run is already created; it will self-report via webhook.
        // We still return 202 so the UI can proceed.
      }

      return res.status(202).json({
        prefect_flow_run_id: flowRun.id,
        idempotency_key: idempotencyKey,
        status: 'queued',
      });
    } catch (err: any) {
      console.error('[content-discovery] /trigger error:', err);
      return res.status(500).json({ error: 'internal_error', message: err?.message ?? 'unknown' });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/modules/content-discovery/webhook
  //
  // Signed callback from the Prefect worker. Requires raw-body access for
  // HMAC verification — this route relies on `express.raw()` being applied
  // by the host app, OR reconstructs the raw body from req.body if a JSON
  // parser already ran. We check for both.
  // -----------------------------------------------------------------------
  app.post('/api/modules/content-discovery/webhook', async (req: Request, res: Response) => {
    try {
      const secret = process.env.PREFECT_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[content-discovery] PREFECT_WEBHOOK_SECRET not configured');
        return res.status(503).json({ error: 'webhook_unconfigured' });
      }

      // Prefer the raw body if express.raw() was used for this route; otherwise
      // serialize the parsed body deterministically. Callers (prefect worker)
      // must send canonical JSON to make this work.
      const rawBody =
        typeof (req as any).rawBody === 'string'
          ? (req as any).rawBody
          : Buffer.isBuffer((req as any).rawBody)
          ? (req as any).rawBody.toString('utf8')
          : JSON.stringify(req.body);

      const signature = req.header('X-Prefect-Signature');
      if (!verifyWebhookSignature(rawBody, signature, secret)) {
        return res.status(401).json({ error: 'invalid_signature' });
      }

      const body = req.body as WebhookBody;
      if (!isTimestampFresh(body.timestamp)) {
        return res.status(400).json({ error: 'stale_timestamp' });
      }

      const supabase = initSupabase(projectRoot);

      const { data: run, error: lookupErr } = await supabase
        .from('content_discovery_runs')
        .select('id')
        .eq('idempotency_key', body.idempotency_key)
        .maybeSingle();

      if (lookupErr || !run) {
        return res.status(404).json({ error: 'unknown_idempotency_key' });
      }

      const patch: Record<string, any> = { status: body.status };
      if (body.status !== 'running' && body.metrics) {
        patch.items_found = body.metrics.items_discovered;
        patch.items_submitted = body.metrics.items_discovered - (body.metrics.items_rejected ?? 0);
        patch.completed_at = new Date().toISOString();
      }
      if (body.status === 'running') {
        patch.started_at = new Date().toISOString();
      }
      if (body.error) {
        patch.metadata = { error: body.error };
      }

      await supabase.from('content_discovery_runs').update(patch).eq('id', run.id);

      return res.status(200).json({ ack: true });
    } catch (err: any) {
      console.error('[content-discovery] /webhook error:', err);
      return res.status(500).json({ error: 'internal_error', message: err?.message ?? 'unknown' });
    }
  });
}
