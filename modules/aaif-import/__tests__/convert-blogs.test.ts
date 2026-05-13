import { describe, expect, it } from 'vitest';
import { convertBlogs, type SanityBlogDoc, type SanityPersonDoc, type SanityBlogTagDoc } from '../lib/convert-blogs.js';

function person(over: Partial<SanityPersonDoc> = {}): SanityPersonDoc {
  return {
    _id: 'p1',
    _type: 'person',
    name: 'Jane Doe',
    designation: 'Engineer',
    ...over,
  };
}

function blog(over: Partial<SanityBlogDoc> = {}): SanityBlogDoc {
  return {
    _id: 'b1',
    _type: 'blog',
    title: 'Hello world',
    baseSlug: { current: 'hello-world' },
    author: { _ref: 'p1', _type: 'reference' },
    content: [
      { _type: 'block', children: [{ _type: 'span', text: 'Body line 1' }] },
      { _type: 'block', children: [{ _type: 'span', text: 'Body line 2' }] },
    ],
    publishedAt: '2026-01-15T10:00:00Z',
    ...over,
  };
}

function tag(over: Partial<SanityBlogTagDoc> = {}): SanityBlogTagDoc {
  return {
    _id: 't1',
    _type: 'blogTag',
    title: 'AI',
    slug: { current: 'ai' },
    ...over,
  };
}

const EMPTY_ASSETS = new Map<string, string>();

describe('convertBlogs — people', () => {
  it('synthesises an email when Sanity has none', () => {
    const { bundle } = convertBlogs({
      blogs: [],
      people: [person({ _id: 'p-jane', name: 'Jane Doe' })],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.people).toHaveLength(1);
    expect(bundle.people[0]?.email).toMatch(/^jane\.doe-.*@imported\.aaif\.invalid$/);
    expect(bundle.people[0]?.is_guest).toBe(true);
  });

  it('uses Sanity-supplied email when present', () => {
    const { bundle } = convertBlogs({
      blogs: [],
      people: [person({ otherInfo: { email: 'jane@example.com' } })],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.people[0]?.email).toBe('jane@example.com');
  });

  it('lands social links + bio in attributes JSONB', () => {
    const { bundle } = convertBlogs({
      blogs: [],
      people: [person({
        designation: 'Senior Eng',
        companyName: 'AAIF',
        bio: 'Long bio here',
        otherInfo: { twitter: '@jane', linkedin: 'https://linkedin.com/in/jane' },
      })],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    const attrs = bundle.people[0]?.attributes as Record<string, unknown>;
    expect(attrs.title).toBe('Senior Eng');
    expect(attrs.company).toBe('AAIF');
    expect(attrs.bio).toBe('Long bio here');
    expect(attrs.social_twitter).toBe('@jane');
    expect(attrs.social_linkedin).toBe('https://linkedin.com/in/jane');
  });

  it('builds personIdMap for downstream resolution', () => {
    const { bundle } = convertBlogs({
      blogs: [],
      people: [person({ _id: 'p-angie' }), person({ _id: 'p-bob', name: 'Bob' })],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.personIdMap['p-angie']).toBeDefined();
    expect(bundle.personIdMap['p-bob']).toBeDefined();
    expect(bundle.personIdMap['p-angie']).not.toBe(bundle.personIdMap['p-bob']);
  });
});

describe('convertBlogs — tags', () => {
  it('maps title + slug, generates id', () => {
    const { bundle } = convertBlogs({
      blogs: [],
      people: [],
      tags: [tag({ _id: 'tag-ai', title: 'Agentic AI', slug: { current: 'agentic-ai' } })],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.tags[0]).toMatchObject({ name: 'Agentic AI', slug: 'agentic-ai' });
    expect(bundle.tagIdMap['tag-ai']).toBe(bundle.tags[0]?.id);
  });

  it('sluggifies title when slug is missing', () => {
    const { bundle } = convertBlogs({
      blogs: [],
      people: [],
      tags: [tag({ title: 'Machine Learning' as string, slug: undefined })],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.tags[0]?.slug).toBe('machine-learning');
  });
});

describe('convertBlogs — posts', () => {
  it('skips posts without title', () => {
    const { bundle, warnings } = convertBlogs({
      blogs: [blog({ title: '' })],
      people: [person()],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.posts).toHaveLength(0);
    expect(warnings.some((w) => w.reason.includes('missing title'))).toBe(true);
  });

  it('skips posts whose author ref is unresolved', () => {
    const { bundle, warnings } = convertBlogs({
      blogs: [blog({ author: { _ref: 'p-missing', _type: 'reference' } })],
      people: [person()],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.posts).toHaveLength(0);
    expect(warnings.some((w) => w.reason.includes('not in people map'))).toBe(true);
  });

  it('flattens portable text to plain content', () => {
    const { bundle } = convertBlogs({
      blogs: [blog()],
      people: [person()],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.posts[0]?.content).toBe('Body line 1\n\nBody line 2');
  });

  it('sets status=published when publishedAt is in the past', () => {
    const { bundle } = convertBlogs({
      blogs: [blog({ publishedAt: '2025-01-01T00:00:00Z' })],
      people: [person()],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.posts[0]?.status).toBe('published');
  });

  it('sets status=draft when publishedAt is in the future', () => {
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    const { bundle } = convertBlogs({
      blogs: [blog({ publishedAt: future })],
      people: [person()],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.posts[0]?.status).toBe('draft');
  });

  it('resolves the author_id to the people row id', () => {
    const { bundle } = convertBlogs({
      blogs: [blog()],
      people: [person({ _id: 'p1' })],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    const expectedAuthorId = bundle.personIdMap['p1'];
    expect(bundle.posts[0]?.author_id).toBe(expectedAuthorId);
  });

  it('warns + drops categories when multiple are present (no junction yet)', () => {
    const { bundle, warnings } = convertBlogs({
      blogs: [blog({
        categories: [
          { _ref: 'c1', _type: 'reference' },
          { _ref: 'c2', _type: 'reference' },
        ],
      })],
      people: [person()],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.posts[0]?.category_id).toBeNull();
    expect(warnings.some((w) => w.reason.includes('2 categories'))).toBe(true);
  });

  it('builds post-tag junction rows', () => {
    const { bundle } = convertBlogs({
      blogs: [blog({
        tags: [
          { _ref: 't-ai', _type: 'reference' },
          { _ref: 't-policy', _type: 'reference' },
        ],
      })],
      people: [person()],
      tags: [tag({ _id: 't-ai' }), tag({ _id: 't-policy', title: 'Policy', slug: { current: 'policy' } })],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.postTags).toHaveLength(2);
    expect(bundle.postTags[0]?.post_id).toBe(bundle.posts[0]?.id);
  });
});

describe('convertBlogs — asset resolution', () => {
  it('rewrites Sanity image asset refs to host-media URLs', () => {
    const assets = new Map([['abc123-1920x1080-jpg', '/media/sites/x/abc.jpg']]);
    const { bundle } = convertBlogs({
      blogs: [blog({
        thumbnail: { _type: 'image', asset: { _type: 'reference', _ref: 'image-abc123-1920x1080-jpg' } },
      })],
      people: [person()],
      tags: [],
      assetRefMap: assets,
    });
    expect(bundle.posts[0]?.featured_image).toBe('/media/sites/x/abc.jpg');
  });

  it('returns null when an asset ref is unresolved', () => {
    const { bundle } = convertBlogs({
      blogs: [blog({
        thumbnail: { _type: 'image', asset: { _type: 'reference', _ref: 'image-orphan-png' } },
      })],
      people: [person()],
      tags: [],
      assetRefMap: EMPTY_ASSETS,
    });
    expect(bundle.posts[0]?.featured_image).toBeNull();
  });
});
