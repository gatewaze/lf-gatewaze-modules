/**
 * Membership HTTP API.
 *
 * - GET    /api/membership/members           list members
 * - POST   /api/membership/members           create (manual)
 * - PATCH  /api/membership/members/:id       edit tier / metadata
 * - DELETE /api/membership/members/:id       hard delete (cascades to keyword rule)
 * - GET    /api/membership/tiers             list tier ranks
 * - PATCH  /api/membership/tiers/:tier       update rank (propagates)
 * - POST   /api/membership/sync              run AAIF scraper inline (returns when done)
 * - GET    /api/membership/sync/runs         recent sync runs
 */

import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ModuleContext } from '@gatewaze/shared';

let _supabase: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[membership] SUPABASE env required');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

function err(res: Response, status: number, code: string, message: string, details?: any) {
  return res.status(status).json({ error: { code, message, details: details ?? {} } });
}

export function registerRoutes(app: Express, _ctx?: ModuleContext) {
  // -------- members CRUD --------
  app.get('/api/membership/members', async (req, res) => {
    try {
      const sb = supabase();
      const { tier, is_active } = req.query;
      let q = sb.from('member_organizations').select('*');
      if (tier) q = q.eq('tier', tier as string);
      if (is_active !== undefined) q = q.eq('is_active', is_active === 'true');
      q = q.order('tier_rank', { ascending: false }).order('name', { ascending: true });
      const { data, error } = await q;
      if (error) return err(res, 500, 'db_error', error.message);
      res.json({ data });
    } catch (e: any) { err(res, 500, 'internal', e.message ?? String(e)); }
  });

  app.post('/api/membership/members', async (req, res) => {
    try {
      const sb = supabase();
      const body = req.body ?? {};
      // Look up tier_rank from tier_ranks if not provided.
      let tier_rank = body.tier_rank;
      if (tier_rank === undefined && body.tier) {
        const { data: tr } = await sb.from('membership_tier_ranks').select('rank').eq('tier', body.tier).single();
        tier_rank = tr?.rank ?? 0;
      }
      const { data, error } = await sb
        .from('member_organizations')
        .insert({ ...body, tier_rank })
        .select()
        .single();
      if (error) return err(res, error.code === '23505' ? 409 : 500, error.code ?? 'db_error', error.message);
      res.status(201).json({ data });
    } catch (e: any) { err(res, 500, 'internal', e.message ?? String(e)); }
  });

  app.patch('/api/membership/members/:id', async (req, res) => {
    try {
      const sb = supabase();
      const body = req.body ?? {};
      // If tier changed but tier_rank wasn't explicitly provided, look it up.
      if (body.tier && body.tier_rank === undefined) {
        const { data: tr } = await sb.from('membership_tier_ranks').select('rank').eq('tier', body.tier).single();
        if (tr) body.tier_rank = tr.rank;
      }
      const { data, error } = await sb
        .from('member_organizations')
        .update(body).eq('id', req.params.id)
        .select().single();
      if (error) return err(res, 500, 'db_error', error.message);
      if (!data) return err(res, 404, 'not_found', 'member not found');
      res.json({ data });
    } catch (e: any) { err(res, 500, 'internal', e.message ?? String(e)); }
  });

  app.delete('/api/membership/members/:id', async (req, res) => {
    try {
      const sb = supabase();
      const { error } = await sb.from('member_organizations').delete().eq('id', req.params.id);
      if (error) return err(res, 500, 'db_error', error.message);
      res.status(204).end();
    } catch (e: any) { err(res, 500, 'internal', e.message ?? String(e)); }
  });

  // -------- tier ranks --------
  app.get('/api/membership/tiers', async (_req, res) => {
    try {
      const sb = supabase();
      const { data, error } = await sb.from('membership_tier_ranks').select('*').order('sort_order');
      if (error) return err(res, 500, 'db_error', error.message);
      res.json({ data });
    } catch (e: any) { err(res, 500, 'internal', e.message ?? String(e)); }
  });

  app.patch('/api/membership/tiers/:tier', async (req, res) => {
    try {
      const sb = supabase();
      const { data, error } = await sb
        .from('membership_tier_ranks')
        .update(req.body ?? {}).eq('tier', req.params.tier)
        .select().single();
      if (error) return err(res, 500, 'db_error', error.message);
      res.json({ data });
    } catch (e: any) { err(res, 500, 'internal', e.message ?? String(e)); }
  });

  // -------- sync runs --------
  app.post('/api/membership/sync', async (req, res) => {
    try {
      const { runAaifSync } = await import('./scripts/aaif-member-scraper.js');
      const sourceUrl = (req.body?.source_url as string) ?? 'https://aaif.io/members/';
      const result = await runAaifSync({ sourceUrl });
      res.json({ data: result });
    } catch (e: any) {
      err(res, 500, 'sync_failed', e.message ?? String(e));
    }
  });

  app.get('/api/membership/sync/runs', async (_req, res) => {
    try {
      const sb = supabase();
      const { data, error } = await sb
        .from('membership_sync_runs').select('*')
        .order('created_at', { ascending: false }).limit(20);
      if (error) return err(res, 500, 'db_error', error.message);
      res.json({ data });
    } catch (e: any) { err(res, 500, 'internal', e.message ?? String(e)); }
  });
}
