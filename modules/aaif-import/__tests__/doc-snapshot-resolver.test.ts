import { describe, expect, it } from 'vitest';
import {
  buildDocSnapshotResolver,
  indexDocsById,
  type SanityDocLike,
} from '../lib/doc-snapshot-resolver.js';

const PERSON: SanityDocLike = {
  _id: 'person-1',
  _type: 'person',
  name: 'Mazin Gilbert',
  role: 'CEO',
};

const BLOG: SanityDocLike = {
  _id: 'blog-1',
  _type: 'blog',
  title: "Why I'm Joining the Agentic AI Foundation",
  slug: { current: 'why-im-joining', _type: 'slug' },
  publishedAt: '2026-04-22T15:00:00Z',
  summary: 'A short summary about joining.',
  author: { _ref: 'person-1', _type: 'reference' },
  featuredImage: {
    _type: 'image',
    _sanityAsset: 'image@file://./images/abc-1200x800.jpg',
  },
};

const EVENT: SanityDocLike = {
  _id: 'event-1',
  _type: 'event',
  title: 'AI Engineer NYC',
  baseSlug: { current: 'ai-engineer-nyc', _type: 'slug' },
  startsAt: '2026-06-01T09:00:00Z',
  endsAt: '2026-06-02T17:00:00Z',
  summary: 'Two-day deep dive.',
};

describe('buildDocSnapshotResolver', () => {
  const byId = indexDocsById([PERSON, BLOG, EVENT]);
  const resolve = buildDocSnapshotResolver({ byId });

  it('returns null for unknown ids', () => {
    expect(resolve('blog-phantom')).toBeNull();
  });

  it('returns null for non-snapshottable types', () => {
    const byIdLocal = indexDocsById([
      { _id: 'span-1', _type: 'span', text: 'hi' },
    ]);
    const resolveLocal = buildDocSnapshotResolver({ byId: byIdLocal });
    expect(resolveLocal('span-1')).toBeNull();
  });

  it('snapshots a blog with author + featuredImage + truncated publishedAt', () => {
    const snap = resolve('blog-1');
    expect(snap).toMatchObject({
      _type: 'blog',
      _id: 'blog-1',
      _resolvedFrom: 'blog-1',
      title: "Why I'm Joining the Agentic AI Foundation",
      slug: { current: 'why-im-joining', _type: 'slug' },
      publishedAt: '2026-04-22',
      author: { name: 'Mazin Gilbert' },
      summary: 'A short summary about joining.',
      description: 'A short summary about joining.',
    });
    expect(snap?.featuredImage).toMatchObject({
      _type: 'image',
      _sanityAsset: 'image@file://./images/abc-1200x800.jpg',
    });
  });

  it('uses startsAt as publishedAt for events', () => {
    const snap = resolve('event-1');
    expect(snap).toMatchObject({
      _type: 'event',
      _id: 'event-1',
      publishedAt: '2026-06-01',
      slug: { current: 'ai-engineer-nyc', _type: 'slug' },
    });
  });

  it('snapshots a person with role + organization fields', () => {
    const snap = resolve('person-1');
    expect(snap).toMatchObject({
      _type: 'person',
      title: 'Mazin Gilbert',
      role: 'CEO',
    });
  });
});

describe('indexDocsById', () => {
  it('strips drafts. and versions. prefixes', () => {
    const byId = indexDocsById([
      { _id: 'drafts.blog-1', _type: 'blog', title: 'Draft' },
      { _id: 'blog-2', _type: 'blog', title: 'Published B' },
      { _id: 'versions.r1.blog-3', _type: 'blog', title: 'Versioned' },
    ]);
    expect(byId.get('blog-1')?.title).toBe('Draft');
    expect(byId.get('blog-2')?.title).toBe('Published B');
    expect(byId.get('blog-3')?.title).toBe('Versioned');
  });

  it('prefers published over draft when both present', () => {
    // Whichever comes first in the input shouldn't matter — published wins.
    const byId = indexDocsById([
      { _id: 'drafts.blog-1', _type: 'blog', title: 'Draft' },
      { _id: 'blog-1', _type: 'blog', title: 'Published' },
    ]);
    expect(byId.get('blog-1')?.title).toBe('Published');
    expect(byId.get('blog-1')?._id).toBe('blog-1');
  });

  it('keeps draft when no published exists', () => {
    const byId = indexDocsById([
      { _id: 'drafts.blog-1', _type: 'blog', title: 'Draft only' },
    ]);
    expect(byId.get('blog-1')?.title).toBe('Draft only');
  });
});
