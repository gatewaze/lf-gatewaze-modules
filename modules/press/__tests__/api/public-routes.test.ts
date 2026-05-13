/**
 * Press module — public-routes unit tests.
 *
 * We mount `createPublicPressRoutes` against an Express app with a hand-
 * rolled supabase chain stub. The stub records every chained call so
 * tests can assert on the actual PostgREST builder used (status filter,
 * order, range, .or() sanitisation, etc.) without touching a real DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  createPublicPressRoutes,
  mountPublicPressRoutes,
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
    for (const op of ['select', 'eq', 'order', 'range', 'contains', 'or']) {
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
  const routes = createPublicPressRoutes({ supabase: supabase.client, logger });
  const router = express.Router();
  mountPublicPressRoutes(router, routes);
  app.use('/api', router);
  return app;
}

describe('press public routes', () => {
  let supabase: ReturnType<typeof makeStubSupabase>;
  let app: express.Express;

  beforeEach(() => {
    supabase = makeStubSupabase();
    app = makeApp(supabase);
  });

  describe('GET /api/press', () => {
    it('returns the list envelope with default limit/offset', async () => {
      const rows = [
        { id: 'r1', slug: 'a', title: 'A', kind: 'release' },
        { id: 'r2', slug: 'b', title: 'B', kind: 'coverage' },
      ];
      supabase.mockListResult(rows);

      const res = await request(app).get('/api/press');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ releases: rows, limit: 20, offset: 0 });
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(res.headers['cache-control']).toContain('stale-if-error=86400');
      expect(res.headers['surrogate-key']).toBe('press');
      expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);

      // Confirm the query was filtered to status='published' and ordered
      // by published_at desc.
      const state = supabase.calls[0];
      expect(state.table).toBe('press_releases');
      const eqOps = state.ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({
        op: 'eq',
        args: ['status', 'published'],
      });
      const orderOps = state.ops.filter((o) => o.op === 'order');
      expect(orderOps[0]?.args[0]).toBe('published_at');
    });

    it('clamps an oversized limit to 100', async () => {
      supabase.mockListResult([]);
      const res = await request(app).get('/api/press?limit=9999');
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100);
      const rangeOp = supabase.calls[0].ops.find((o) => o.op === 'range');
      expect(rangeOp?.args).toEqual([0, 99]);
    });

    it('filters by kind', async () => {
      supabase.mockListResult([]);
      await request(app).get('/api/press?kind=coverage');
      const eqOps = supabase.calls[0].ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['kind', 'coverage'] });
    });

    it('rejects an invalid kind with 400', async () => {
      const res = await request(app).get('/api/press?kind=nope');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
      // Should not have run a select call after the validation reject.
      expect(supabase.calls[0].ops.filter((o) => o.op === 'range')).toHaveLength(0);
    });

    it('filters by tag with `contains`', async () => {
      supabase.mockListResult([]);
      await request(app).get('/api/press?tag=foundation');
      const containsOp = supabase.calls[0].ops.find((o) => o.op === 'contains');
      expect(containsOp?.args).toEqual(['tags', ['foundation']]);
    });

    it('filters by featured=true', async () => {
      supabase.mockListResult([]);
      await request(app).get('/api/press?featured=true');
      const eqOps = supabase.calls[0].ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['is_featured', true] });
    });

    it('sanitises PostgREST `.or()` injection in search', async () => {
      supabase.mockListResult([]);
      // Comma + paren + asterisk + backslash all need to be stripped.
      await request(app).get(
        '/api/press?search=' + encodeURIComponent('lf,id.gt.0(*\\)'),
      );
      const orOp = supabase.calls[0].ops.find((o) => o.op === 'or');
      const arg = orOp?.args[0] as string | undefined;
      expect(arg).toBeDefined();
      expect(arg).toContain('%lfid.gt.0%');
      expect(arg).not.toContain('%lf,');
      expect(arg).not.toContain('(*');
      expect(arg).not.toContain('\\)');
    });

    it('rejects a non-uuid site_id with 400', async () => {
      const res = await request(app).get('/api/press?site_id=not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
    });

    it('surfaces a 500 when the supabase call errors', async () => {
      supabase.mockListResult(null, { message: 'boom' });
      const res = await request(app).get('/api/press');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
    });
  });

  describe('GET /api/press/:slug', () => {
    it('returns the single row including `body`', async () => {
      const row = {
        id: 'r1',
        slug: 'hello-world',
        title: 'Hello',
        body: '# md',
        kind: 'release',
      };
      supabase.mockSingleResult(row);

      const res = await request(app).get('/api/press/hello-world');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(row);
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(res.headers['surrogate-key']).toBe('press press:hello-world');
      expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);

      // The detail select must include `body` (uses DETAIL_COLUMNS).
      const selectOp = supabase.calls[0].ops.find((o) => o.op === 'select');
      expect(String(selectOp?.args[0])).toContain('body');
      const eqOps = supabase.calls[0].ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['slug', 'hello-world'] });
      expect(eqOps).toContainEqual({
        op: 'eq',
        args: ['status', 'published'],
      });
    });

    it('returns 404 when the row is missing', async () => {
      supabase.mockSingleResult(null);
      const res = await request(app).get('/api/press/missing');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('returns 404 for slugs that fail the safety regex', async () => {
      const res = await request(app).get('/api/press/' + encodeURIComponent('bad slug!'));
      expect(res.status).toBe(404);
      // The handler short-circuits — no DB call.
      expect(supabase.calls).toHaveLength(0);
    });

    it('surfaces a 500 when the supabase call errors', async () => {
      supabase.mockSingleResult(null, { message: 'db dead' });
      const res = await request(app).get('/api/press/hello-world');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
    });

    it('returns 304 when If-None-Match matches the computed ETag', async () => {
      const row = {
        id: 'r1',
        slug: 'hello-world',
        title: 'Hello',
        body: '# md',
        kind: 'release',
      };
      supabase.mockSingleResult(row);
      const first = await request(app).get('/api/press/hello-world');
      expect(first.status).toBe(200);
      const etag = first.headers['etag'];
      expect(etag).toBeDefined();

      supabase.mockSingleResult(row);
      const second = await request(app)
        .get('/api/press/hello-world')
        .set('If-None-Match', etag);
      expect(second.status).toBe(304);
      expect(second.text).toBe('');
    });
  });
});
