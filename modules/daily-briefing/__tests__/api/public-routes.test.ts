/**
 * Daily-briefing module — public-routes unit tests (day-grouped shape).
 *
 * The route now returns ONE envelope: `{ day: {...} | null, items: [...] }`,
 * pulled from `daily_briefing_days` (most-recent published) + that day's
 * first 3 published items ordered by display_order.
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
}

interface MockedResponse {
  data: unknown;
  error: unknown;
}

/**
 * The chain proxy answers `await chain` (lists) AND `.maybeSingle()`
 * (single-row reads). Tests queue the next response per-table so the
 * routes that hit BOTH `daily_briefing_days` (single) and
 * `daily_briefing_items` (list) in one request can be exercised.
 */
function makeStubSupabase() {
  const calls: ChainState[] = [];
  const responseQueueByTable = new Map<string, MockedResponse[]>();

  function dequeue(table: string): MockedResponse {
    const q = responseQueueByTable.get(table);
    if (!q || q.length === 0) return { data: null, error: null };
    return q.shift() ?? { data: null, error: null };
  }

  function makeChain(table: string): {
    chain: Record<string, unknown>;
    state: ChainState;
  } {
    const state: ChainState = { table, ops: [] };
    const chain: Record<string, unknown> = {};
    const record = (op: string) =>
      (...args: unknown[]) => {
        state.ops.push({ op, args });
        return chain;
      };
    for (const op of ['select', 'eq', 'order', 'limit', 'range']) {
      chain[op] = record(op);
    }
    chain.maybeSingle = () => {
      state.ops.push({ op: 'maybeSingle', args: [] });
      return Promise.resolve(dequeue(table));
    };
    chain.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(dequeue(table)).then(onFulfilled, onRejected);
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
    queueResponse(table: string, response: MockedResponse) {
      const q = responseQueueByTable.get(table) ?? [];
      q.push(response);
      responseQueueByTable.set(table, q);
    },
    reset() {
      calls.length = 0;
      responseQueueByTable.clear();
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
const SITE_UUID = '22222222-2222-4222-8222-222222222222';

describe('daily-briefing public routes', () => {
  let supabase: ReturnType<typeof makeStubSupabase>;
  let app: express.Express;

  beforeEach(() => {
    supabase = makeStubSupabase();
    app = makeApp(supabase);
  });

  describe('GET /api/daily-briefing', () => {
    it('returns the most-recent published day with its items capped at 3', async () => {
      const day = {
        id: SAMPLE_UUID,
        site_id: SITE_UUID,
        brief_date: '2026-05-14',
        image_storage_path: 'daily_briefing_day/abc/cover-2026-05-14.png',
        image_generated_at: '2026-05-14T10:00:00Z',
      };
      const items = [
        { id: 'i1', title: 'A', summary: 'a s', source_label: 'X', source_href: 'https://x', display_order: 1000 },
        { id: 'i2', title: 'B', summary: 'b s', source_label: 'Y', source_href: 'https://y', display_order: 2000 },
        { id: 'i3', title: 'C', summary: 'c s', source_label: 'Z', source_href: 'https://z', display_order: 3000 },
      ];
      supabase.queueResponse('daily_briefing_days', { data: day, error: null });
      supabase.queueResponse('daily_briefing_items', { data: items, error: null });

      const res = await request(app).get('/api/daily-briefing');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        day: {
          id: day.id,
          brief_date: day.brief_date,
          image_storage_path: day.image_storage_path,
          image_generated_at: day.image_generated_at,
        },
        items,
      });
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(res.headers['cache-control']).toContain('stale-if-error=86400');
      expect(res.headers['surrogate-key']).toBe(
        `daily-briefing daily-briefing:day:${day.brief_date}`,
      );
      expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);

      // The day query MUST filter status='published' and order brief_date desc.
      const dayState = supabase.calls.find((c) => c.table === 'daily_briefing_days');
      expect(dayState).toBeDefined();
      const dayEqs = dayState!.ops.filter((o) => o.op === 'eq');
      expect(dayEqs).toContainEqual({ op: 'eq', args: ['status', 'published'] });
      const dayOrders = dayState!.ops.filter((o) => o.op === 'order');
      expect(dayOrders[0]?.args[0]).toBe('brief_date');
      const dayLimits = dayState!.ops.filter((o) => o.op === 'limit');
      expect(dayLimits[0]?.args).toEqual([1]);

      // The items query MUST filter by day_id + status='published', order by
      // display_order ASC, limit to 3.
      const itemsState = supabase.calls.find((c) => c.table === 'daily_briefing_items');
      expect(itemsState).toBeDefined();
      const itemEqs = itemsState!.ops.filter((o) => o.op === 'eq');
      expect(itemEqs).toContainEqual({ op: 'eq', args: ['day_id', day.id] });
      expect(itemEqs).toContainEqual({ op: 'eq', args: ['status', 'published'] });
      const itemLimits = itemsState!.ops.filter((o) => o.op === 'limit');
      expect(itemLimits[0]?.args).toEqual([3]);
      const itemOrders = itemsState!.ops.filter((o) => o.op === 'order');
      expect(itemOrders[0]?.args[0]).toBe('display_order');
      expect(itemOrders[0]?.args[1]).toEqual({ ascending: true });
    });

    it('returns { day: null, items: [] } when no published day exists', async () => {
      supabase.queueResponse('daily_briefing_days', { data: null, error: null });

      const res = await request(app).get('/api/daily-briefing');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ day: null, items: [] });
      // Empty envelope still gets cached so the empty-state doesn't
      // hammer the origin between authoring sessions.
      expect(res.headers['cache-control']).toContain('max-age=60');
      expect(res.headers['surrogate-key']).toBe('daily-briefing');
    });

    it('filters by site_id when supplied', async () => {
      supabase.queueResponse('daily_briefing_days', { data: null, error: null });
      await request(app).get(`/api/daily-briefing?site_id=${SITE_UUID}`);
      const dayState = supabase.calls.find((c) => c.table === 'daily_briefing_days');
      const eqs = dayState!.ops.filter((o) => o.op === 'eq');
      expect(eqs).toContainEqual({ op: 'eq', args: ['site_id', SITE_UUID] });
    });

    it('rejects a non-uuid site_id with 400', async () => {
      const res = await request(app).get('/api/daily-briefing?site_id=not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
      expect(supabase.calls).toHaveLength(0);
    });

    it('surfaces a 500 when the day query errors', async () => {
      supabase.queueResponse('daily_briefing_days', {
        data: null,
        error: { message: 'boom' },
      });
      const res = await request(app).get('/api/daily-briefing');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
    });

    it('returns 304 when If-None-Match matches the computed ETag', async () => {
      const day = {
        id: SAMPLE_UUID,
        site_id: SITE_UUID,
        brief_date: '2026-05-14',
        image_storage_path: null,
        image_generated_at: null,
      };
      supabase.queueResponse('daily_briefing_days', { data: day, error: null });
      supabase.queueResponse('daily_briefing_items', { data: [], error: null });
      const first = await request(app).get('/api/daily-briefing');
      expect(first.status).toBe(200);
      const etag = first.headers['etag'];
      expect(etag).toBeDefined();

      // Reset stub queue + re-arm so the second call gets identical
      // payload (deterministic ETag).
      supabase.queueResponse('daily_briefing_days', { data: day, error: null });
      supabase.queueResponse('daily_briefing_items', { data: [], error: null });
      const second = await request(app)
        .get('/api/daily-briefing')
        .set('If-None-Match', etag);
      expect(second.status).toBe(304);
      expect(second.text).toBe('');
    });
  });
});
