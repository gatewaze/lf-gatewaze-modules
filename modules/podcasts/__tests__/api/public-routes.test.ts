/**
 * Podcasts module — public-routes unit tests.
 *
 * Mounts `createPublicPodcastsRoutes` against an Express app with a
 * hand-rolled supabase chain stub. The stub records every chained call
 * so tests can assert on the actual PostgREST builder used (status
 * filter, order, range, .or() sanitisation, etc.) without touching a
 * real DB. Same shape as the press / projects public-routes tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  createPublicPodcastsRoutes,
  mountPublicPodcastsRoutes,
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
  // For the podcast_slug lookup we sometimes need a different single
  // result than the main detail single result; the first .maybeSingle()
  // call (on the `podcasts` table) reads from this slot when set.
  let nextLookupResult: { data: unknown; error: unknown } | null = null;
  let lookupConsumed = false;

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
      // First lookup-style single read against `podcasts` consumes the
      // lookup slot if set; everything else falls through to the
      // detail/singleResult slot.
      if (table === 'podcasts' && !lookupConsumed && nextLookupResult) {
        lookupConsumed = true;
        return Promise.resolve(nextLookupResult);
      }
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
    mockPodcastLookup(data: unknown, error: unknown = null) {
      nextLookupResult = { data, error };
      lookupConsumed = false;
    },
    reset() {
      calls.length = 0;
      nextListResult = { data: [], error: null };
      nextSingleResult = null;
      nextLookupResult = null;
      lookupConsumed = false;
    },
  };
}

function makeApp(supabase: ReturnType<typeof makeStubSupabase>) {
  const app = express();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const routes = createPublicPodcastsRoutes({ supabase: supabase.client, logger });
  const router = express.Router();
  mountPublicPodcastsRoutes(router, routes);
  app.use('/api', router);
  return app;
}

describe('podcasts public routes', () => {
  let supabase: ReturnType<typeof makeStubSupabase>;
  let app: express.Express;

  beforeEach(() => {
    supabase = makeStubSupabase();
    app = makeApp(supabase);
  });

  describe('GET /api/podcasts/episodes', () => {
    it('returns the list envelope with default limit/offset', async () => {
      const rows = [
        { id: 'e1', slug: 'a', title: 'A', status: 'published' },
        { id: 'e2', slug: 'b', title: 'B', status: 'published' },
      ];
      supabase.mockListResult(rows);

      const res = await request(app).get('/api/podcasts/episodes');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ episodes: rows, limit: 20, offset: 0 });
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(res.headers['cache-control']).toContain('stale-if-error=86400');
      expect(res.headers['surrogate-key']).toBe('podcasts');
      expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);

      // Confirm the query was filtered to status='published' and ordered
      // by publish_date desc.
      const state = supabase.calls[0];
      expect(state.table).toBe('podcast_episodes');
      const eqOps = state.ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({
        op: 'eq',
        args: ['status', 'published'],
      });
      const orderOps = state.ops.filter((o) => o.op === 'order');
      expect(orderOps[0]?.args[0]).toBe('publish_date');
    });

    it('clamps an oversized limit to 100', async () => {
      supabase.mockListResult([]);
      const res = await request(app).get('/api/podcasts/episodes?limit=9999');
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(100);
      const rangeOp = supabase.calls[0].ops.find((o) => o.op === 'range');
      expect(rangeOp?.args).toEqual([0, 99]);
    });

    it('filters by podcast_slug via a podcasts lookup', async () => {
      supabase.mockPodcastLookup({ id: 'pod-1' });
      supabase.mockListResult([]);
      await request(app).get('/api/podcasts/episodes?podcast_slug=the-aaif-show');
      // First call resolves the podcast id.
      expect(supabase.calls[0].table).toBe('podcasts');
      // Second call queries the episodes filtered by podcast_id.
      expect(supabase.calls[1].table).toBe('podcast_episodes');
      const eqOps = supabase.calls[1].ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['podcast_id', 'pod-1'] });
    });

    it('returns empty list when podcast_slug is unknown', async () => {
      supabase.mockPodcastLookup(null);
      const res = await request(app).get('/api/podcasts/episodes?podcast_slug=missing');
      expect(res.status).toBe(200);
      expect(res.body.episodes).toEqual([]);
      // Only the lookup ran — no episodes query.
      expect(supabase.calls).toHaveLength(1);
      expect(supabase.calls[0].table).toBe('podcasts');
    });

    it('rejects an invalid podcast_slug shape with 400', async () => {
      const res = await request(app).get(
        '/api/podcasts/episodes?podcast_slug=' + encodeURIComponent('bad slug!'),
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
      expect(supabase.calls).toHaveLength(0);
    });

    it('sanitises PostgREST `.or()` injection in search', async () => {
      supabase.mockListResult([]);
      // Comma + paren + asterisk + backslash all need to be stripped.
      await request(app).get(
        '/api/podcasts/episodes?search=' + encodeURIComponent('mcp,id.gt.0(*\\)'),
      );
      const orOp = supabase.calls[0].ops.find((o) => o.op === 'or');
      const arg = orOp?.args[0] as string | undefined;
      expect(arg).toBeDefined();
      expect(arg).toContain('%mcpid.gt.0%');
      expect(arg).not.toContain('%mcp,');
      expect(arg).not.toContain('(*');
      expect(arg).not.toContain('\\)');
    });

    it('surfaces a 500 when the supabase call errors', async () => {
      supabase.mockListResult(null, { message: 'boom' });
      const res = await request(app).get('/api/podcasts/episodes');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
    });
  });

  describe('GET /api/podcasts/episodes/:slug', () => {
    it('returns the single row including `show_notes`', async () => {
      const row = {
        id: 'e1',
        slug: 'episode-1',
        title: 'Episode 1',
        show_notes: '## notes',
      };
      supabase.mockSingleResult(row);

      const res = await request(app).get('/api/podcasts/episodes/episode-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(row);
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(res.headers['surrogate-key']).toBe('podcasts podcasts:episode-1');
      expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);

      // The detail select must include `show_notes` (uses DETAIL_COLUMNS).
      const selectOp = supabase.calls[0].ops.find((o) => o.op === 'select');
      expect(String(selectOp?.args[0])).toContain('show_notes');
      const eqOps = supabase.calls[0].ops.filter((o) => o.op === 'eq');
      expect(eqOps).toContainEqual({ op: 'eq', args: ['slug', 'episode-1'] });
      expect(eqOps).toContainEqual({
        op: 'eq',
        args: ['status', 'published'],
      });
    });

    it('returns 404 when the row is missing', async () => {
      supabase.mockSingleResult(null);
      const res = await request(app).get('/api/podcasts/episodes/missing');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('returns 404 for slugs that fail the safety regex', async () => {
      const res = await request(app).get(
        '/api/podcasts/episodes/' + encodeURIComponent('bad slug!'),
      );
      expect(res.status).toBe(404);
      expect(supabase.calls).toHaveLength(0);
    });

    it('surfaces a 500 when the supabase call errors', async () => {
      supabase.mockSingleResult(null, { message: 'db dead' });
      const res = await request(app).get('/api/podcasts/episodes/episode-1');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
    });

    it('returns 304 when If-None-Match matches the computed ETag', async () => {
      const row = {
        id: 'e1',
        slug: 'episode-1',
        title: 'Episode 1',
        show_notes: '## notes',
      };
      supabase.mockSingleResult(row);
      const first = await request(app).get('/api/podcasts/episodes/episode-1');
      expect(first.status).toBe(200);
      const etag = first.headers['etag'];
      expect(etag).toBeDefined();

      supabase.mockSingleResult(row);
      const second = await request(app)
        .get('/api/podcasts/episodes/episode-1')
        .set('If-None-Match', etag);
      expect(second.status).toBe(304);
      expect(second.text).toBe('');
    });
  });
});
