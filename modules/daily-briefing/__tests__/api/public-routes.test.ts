/**
 * Daily-briefing module — public-routes unit tests.
 *
 * We mount `createPublicDailyBriefingRoutes` against an Express app with
 * a hand-rolled supabase chain stub. The stub records every chained call
 * so tests can assert on the actual PostgREST builder used (status filter,
 * order, range, .or() sanitisation, etc.) without touching a real DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  createPublicDailyBriefingRoutes,
  mountPublicDailyBriefingRoutes,
} from '../../api/public-routes.js';

interface ChainState {
  table: string;
  ops: Array<{ op: string; args: unknown[] }>;
  result: { data: unknown; error: unknown };
  singleResult: { data: unknown; error: unknown } | null;
}

function makeStubSupabase() {
  const calls: ChainState[] = [];
  let nextListResult: { data: unknown; error: unknown } = { data: [], error: null };
  let nextSingleResult: { data: unknown; error: unknown } | null = null;

  function makeChain(table: string): {
    chain: Record<string, unknown>;
    state: ChainState;
  } {
    const state: ChainState = {
      table,
      ops: [],
      result: nextListResult,
      singleResult: nextSingleResult,
    };

    // The chain proxy supports `await chain` (PromiseLike) for list
    // queries, and explicit `.maybeSingle()` for single-row reads.
    const chain: Record<string, unknown> = {};
    const record = (op: string) =>
      (...args: unknown[]) => {
        state.ops.push({ op, args });
        return chain;
      };
    for (const op of ['select', 'eq', 'order', 'range', 'or']) {
      chain[op] = record(op);
    }
    chain.maybeSingle = () => {
      state.ops.push({ op: 'maybeSingle', args: [] });
      return Promise.resolve(state.singleResult ?? state.result);
    };
    chain.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(state.result).then(onFulfilled, onRejected);

    return { chain, state };
  }

  const client = {
    from(table: string) {
      const { chain, state } = makeChain(table);
      calls.push(state);
      return chain;
    },
  };

  return {
    client,
    calls,
    mockListResult(data: unknown, error: unknown = null) {
      nextListResult = { data, error };
    },
    mockSingleResult(data: unknown, error: unknown = null) {
      nextSingleResult = { data, error };
    },
    reset() {
      calls.length = 0;
      nextListResult = { data: [], error: null };
      nextSingleResult = null;
    },
  };
}

function makeApp(supabase: ReturnType<typeof makeStubSupabase>) {
  const app = express();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const routes = createPublicDailyBriefingRoutes({ supabase: supabase.client, logger });
  const router = express.Router();
  mountPublicDailyBriefingRoutes(router, routes);
  app.use('/api', router);
  return app;
}

const SAMPLE_UUID = '11111111-1111-4111-8111-111111111111';

describe('daily-briefing public routes', () => {
  let supabase: ReturnType<typeof makeStubSupabase>;
  let app: express.Express;

  beforeEach(() => {
    supabase = makeStubSupabase();
    app = makeApp(supabase);
  });

  describe('GET /api/daily-briefing', () => {
    it('returns the list envelope with default limit/offset', async () => {
      const rows = [
        {
          id: 'i1',
          title: 'A',
          summary: 'A summary',
          brief_date: '2026-04-24',
          source_label: 'X',
          source_href: 'https://x.com',
          is_pinned: false,
        },
      ];
      supabase.mockListResult(rows);

      const res = await request(app).get('/api/daily-briefing');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: rows, limit: 20, offset: 0 });
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(res.headers['cache-control']).toContain('stale-if-error=86400');
      expect(res.headers['surrogate-key']).toBe('daily-briefing');
      expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);

      const state = supabase.calls[0];
      expect(state.table).toBe('daily_briefing_items');
      const eqOps = state.ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['status', 'published'] });
      // Sort order: pinned first, then brief_date desc, then created_at desc.
      const orderOps = state.ops.filter((o) => o.op === 'order');
      expect(orderOps[0]?.args[0]).toBe('is_pinned');
      expect(orderOps[1]?.args[0]).toBe('brief_date');
      expect(orderOps[2]?.args[0]).toBe('created_at');
    });

    it('clamps an oversized limit to 100', async () => {
      supabase.mockListResult([]);
      const res = await request(app).get('/api/daily-briefing?limit=9999');
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100);
      const rangeOp = supabase.calls[0].ops.find((o) => o.op === 'range');
      expect(rangeOp?.args).toEqual([0, 99]);
    });

    it('honours limit=3 (theme home-page query)', async () => {
      supabase.mockListResult([]);
      const res = await request(app).get('/api/daily-briefing?limit=3');
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(3);
      const rangeOp = supabase.calls[0].ops.find((o) => o.op === 'range');
      expect(rangeOp?.args).toEqual([0, 2]);
    });

    it('filters by pinned=true', async () => {
      supabase.mockListResult([]);
      await request(app).get('/api/daily-briefing?pinned=true');
      const eqOps = supabase.calls[0].ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['is_pinned', true] });
    });

    it('filters by site_id when valid', async () => {
      supabase.mockListResult([]);
      await request(app).get(`/api/daily-briefing?site_id=${SAMPLE_UUID}`);
      const eqOps = supabase.calls[0].ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['site_id', SAMPLE_UUID] });
    });

    it('rejects a non-uuid site_id with 400', async () => {
      const res = await request(app).get('/api/daily-briefing?site_id=not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
    });

    it('sanitises PostgREST `.or()` injection in search', async () => {
      supabase.mockListResult([]);
      await request(app).get(
        '/api/daily-briefing?search=' + encodeURIComponent('lf,id.gt.0(*\\)'),
      );
      const orOp = supabase.calls[0].ops.find((o) => o.op === 'or');
      const arg = orOp?.args[0] as string | undefined;
      expect(arg).toBeDefined();
      expect(arg).toContain('%lfid.gt.0%');
      expect(arg).not.toContain('%lf,');
      expect(arg).not.toContain('(*');
      expect(arg).not.toContain('\\)');
    });

    it('surfaces a 500 when the supabase call errors', async () => {
      supabase.mockListResult(null, { message: 'boom' });
      const res = await request(app).get('/api/daily-briefing');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
    });
  });

  describe('GET /api/daily-briefing/:id', () => {
    it('returns the single row', async () => {
      const row = {
        id: SAMPLE_UUID,
        title: 'Hello',
        summary: 'World',
        brief_date: '2026-04-24',
        source_label: 'X',
        source_href: 'https://x.com',
        is_pinned: false,
      };
      supabase.mockSingleResult(row);

      const res = await request(app).get(`/api/daily-briefing/${SAMPLE_UUID}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(row);
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(res.headers['surrogate-key']).toBe(
        `daily-briefing daily-briefing:${SAMPLE_UUID}`,
      );
      expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);

      const eqOps = supabase.calls[0].ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['id', SAMPLE_UUID] });
      expect(eqOps).toContainEqual({ op: 'eq', args: ['status', 'published'] });
    });

    it('returns 404 when the row is missing', async () => {
      supabase.mockSingleResult(null);
      const res = await request(app).get(`/api/daily-briefing/${SAMPLE_UUID}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('returns 404 for ids that fail the uuid regex (no DB call)', async () => {
      const res = await request(app).get('/api/daily-briefing/bad-id');
      expect(res.status).toBe(404);
      expect(supabase.calls).toHaveLength(0);
    });

    it('surfaces a 500 when the supabase call errors', async () => {
      supabase.mockSingleResult(null, { message: 'db dead' });
      const res = await request(app).get(`/api/daily-briefing/${SAMPLE_UUID}`);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
    });

    it('returns 304 when If-None-Match matches the computed ETag', async () => {
      const row = {
        id: SAMPLE_UUID,
        title: 'Hello',
        summary: 'World',
        brief_date: '2026-04-24',
        source_label: 'X',
        source_href: 'https://x.com',
        is_pinned: false,
      };
      supabase.mockSingleResult(row);
      const first = await request(app).get(`/api/daily-briefing/${SAMPLE_UUID}`);
      expect(first.status).toBe(200);
      const etag = first.headers['etag'];
      expect(etag).toBeDefined();

      supabase.mockSingleResult(row);
      const second = await request(app)
        .get(`/api/daily-briefing/${SAMPLE_UUID}`)
        .set('If-None-Match', etag);
      expect(second.status).toBe(304);
      expect(second.text).toBe('');
    });
  });
});
