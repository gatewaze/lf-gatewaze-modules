/**
 * Public projects route tests.
 *
 * Drives the route handler with a hand-rolled supabase mock + supertest.
 * The mock is intentionally local to keep the module self-contained
 * (no cross-package import paths to break).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';

import {
  createPublicProjectsRoutes,
  mountPublicProjectsRoutes,
} from '../../api/public-routes.js';

function createMockSupabase() {
  let result: { data: unknown; error: unknown } = { data: null, error: null };

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = [
    'from',
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'order',
    'contains',
    'or',
    'range',
    'single',
    'maybeSingle',
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockImplementation(() => {
      if (m === 'single' || m === 'maybeSingle') return Promise.resolve(result);
      return chain;
    });
  }
  // Make non-terminal calls thenable so `await query` works
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => Promise.resolve(resolve(result)),
    enumerable: false,
  });

  return {
    client: chain,
    setResult(data: unknown, error: unknown = null) {
      result = { data, error };
    },
  };
}

const PROJECT_LIST_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  site_id: 'ebc32e3d-e877-40ce-8083-2d4a4c29f9aa',
  slug: 'model-context-protocol',
  title: 'Model Context Protocol',
  short_description: 'Open standard for connecting AI to data sources.',
  logo_url: '/media/sites/.../mcp.svg',
  logo_alt: 'MCP',
  cover_image_url: null,
  website_url: 'https://modelcontextprotocol.io',
  github_url: 'https://github.com/modelcontextprotocol',
  docs_url: null,
  category: 'protocol',
  tags: ['spec', 'agent-runtime'],
  is_featured: true,
  sort_order: 10,
  maintainer_org: 'Anthropic',
  license: 'MIT',
  founded_at: '2024-11-01',
};

function makeApp(mock: ReturnType<typeof createMockSupabase>) {
  const app = express();
  const router = Router();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const routes = createPublicProjectsRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: mock.client as any,
    logger,
  });
  mountPublicProjectsRoutes(router, routes);
  app.use('/api', router);
  return app;
}

describe('GET /api/projects', () => {
  let mock: ReturnType<typeof createMockSupabase>;
  let app: express.Express;

  beforeEach(() => {
    mock = createMockSupabase();
    app = makeApp(mock);
  });

  it('returns published projects with the expected shape', async () => {
    mock.setResult([PROJECT_LIST_ROW]);

    const res = await request(app).get('/api/projects');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      projects: [
        {
          slug: 'model-context-protocol',
          title: 'Model Context Protocol',
          is_featured: true,
        },
      ],
      limit: 20,
      offset: 0,
    });
    // Filter to status='published' is the load-bearing security property
    expect(mock.client.eq).toHaveBeenCalledWith('status', 'published');
    expect(res.headers['cache-control']).toMatch(/public, max-age=60/);
    expect(res.headers['cache-control']).toContain('stale-if-error=86400');
    expect(res.headers['surrogate-key']).toBe('projects');
    expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);
  });

  it('filters by category, featured, and tag', async () => {
    mock.setResult([PROJECT_LIST_ROW]);

    await request(app).get('/api/projects?category=protocol&featured=true&tag=spec');

    expect(mock.client.eq).toHaveBeenCalledWith('category', 'protocol');
    expect(mock.client.eq).toHaveBeenCalledWith('is_featured', true);
    expect(mock.client.contains).toHaveBeenCalledWith('tags', ['spec']);
  });

  it('clamps limit to 100 and rejects negative offset', async () => {
    mock.setResult([]);

    await request(app).get('/api/projects?limit=999&offset=-5');

    // range(offset, offset+limit-1) — limit clamped to 100, offset to 0
    expect(mock.client.range).toHaveBeenCalledWith(0, 99);
  });

  it('strips PostgREST filter metacharacters from search', async () => {
    mock.setResult([]);

    await request(app).get(
      '/api/projects?search=' + encodeURIComponent('mcp,id.gt.0(*\\)'),
    );

    const orArg = (mock.client.or.mock.calls[0]?.[0] as string) ?? '';
    expect(orArg).toContain('%mcpid.gt.0%');
    expect(orArg).not.toContain('%mcp,');
    expect(orArg).not.toContain('(*');
    expect(orArg).not.toContain('\\)');
  });

  it('rejects a non-uuid site_id with 400', async () => {
    const res = await request(app).get('/api/projects?site_id=not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('returns 500 with an error envelope on DB failure', async () => {
    mock.setResult(null, { message: 'connection refused' });

    const res = await request(app).get('/api/projects');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'internal' });
  });
});

describe('GET /api/projects/:slug', () => {
  let mock: ReturnType<typeof createMockSupabase>;
  let app: express.Express;

  beforeEach(() => {
    mock = createMockSupabase();
    app = makeApp(mock);
  });

  it('returns a single published project including long_description', async () => {
    mock.setResult({ ...PROJECT_LIST_ROW, long_description: '# MCP\n…' });

    const res = await request(app).get('/api/projects/model-context-protocol');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: 'model-context-protocol',
      long_description: expect.stringContaining('MCP'),
    });
    expect(mock.client.eq).toHaveBeenCalledWith('slug', 'model-context-protocol');
    expect(mock.client.eq).toHaveBeenCalledWith('status', 'published');
    expect(res.headers['surrogate-key']).toBe(
      'projects projects:model-context-protocol',
    );
    expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{16}"$/);
  });

  it('returns 304 when If-None-Match matches the computed ETag', async () => {
    mock.setResult({ ...PROJECT_LIST_ROW, long_description: '# MCP\n…' });
    const first = await request(app).get('/api/projects/model-context-protocol');
    expect(first.status).toBe(200);
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    mock.setResult({ ...PROJECT_LIST_ROW, long_description: '# MCP\n…' });
    const second = await request(app)
      .get('/api/projects/model-context-protocol')
      .set('If-None-Match', etag);
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('returns 404 when the slug is not found', async () => {
    mock.setResult(null);

    const res = await request(app).get('/api/projects/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('returns 404 for a slug containing illegal characters (rejected pre-DB)', async () => {
    const res = await request(app).get('/api/projects/' + encodeURIComponent('../etc/passwd'));

    expect(res.status).toBe(404);
    expect(mock.client.maybeSingle).not.toHaveBeenCalled();
  });

  it('returns 500 with an error envelope on DB failure', async () => {
    mock.setResult(null, { message: 'boom' });

    const res = await request(app).get('/api/projects/model-context-protocol');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'internal' });
  });
});
