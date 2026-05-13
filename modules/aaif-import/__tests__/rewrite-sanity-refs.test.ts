import { describe, expect, it } from 'vitest';
import { rewriteSanityRefs, rewriteSanityRefsWithOptions } from '../lib/rewrite-sanity-refs.js';

const ASSET_MAP = {
  byAssetId: new Map([
    ['abc123-1920x1080-jpg', '/media/abc123-1920x1080.jpg'],
    ['xyz789-mp4', '/media/xyz789.mp4'],
    // _sanityAsset registers under multiple keys; mirror what
    // uploadSanityAssets builds (bare hash + dims/ext form).
    ['7e95535518369487d31241ed071a29fa1a64d164', '/media/sites/s/media/7e955355-bg.jpg'],
    ['7e95535518369487d31241ed071a29fa1a64d164-1200x800-jpg', '/media/sites/s/media/7e955355-bg.jpg'],
    ['c5773f6c098de2295adf373bbc8d9e44d8580183', '/media/sites/s/media/c5773f6c-hero.mp4'],
    ['c5773f6c098de2295adf373bbc8d9e44d8580183-mp4', '/media/sites/s/media/c5773f6c-hero.mp4'],
  ]),
};

describe('rewriteSanityRefs — asset refs (legacy bare-URL collapse → object shape)', () => {
  it('rewrites bare reference objects to URLs', () => {
    const out = rewriteSanityRefs(
      { thumbnail: { _type: 'reference', _ref: 'image-abc123-1920x1080-jpg' } },
      ASSET_MAP,
    );
    // Top-level bare references collapse to a plain URL string — this
    // matches what `thumbnail: { _ref: 'image-...' }` used to mean when
    // Sanity hydrated the reference; the publisher rewriter doesn't see
    // such cases in our exports today but we keep the behaviour.
    expect(out.rewritten).toEqual({ thumbnail: '/media/abc123-1920x1080.jpg' });
    expect(out.assetHits.get('abc123-1920x1080-jpg')).toBe(1);
  });

  it('rewrites image objects with nested asset.ref to the publisher-friendly shape', () => {
    const out = rewriteSanityRefs(
      {
        thumbnail: {
          _type: 'image',
          asset: { _type: 'reference', _ref: 'image-abc123-1920x1080-jpg' },
          hotspot: { x: 0.5 },
        },
      },
      ASSET_MAP,
    );
    // Now produces the `{ _type, asset: { url, _ref } }` shape the
    // publisher's media rewriter knows how to walk and rewrite.
    expect(out.rewritten).toEqual({
      thumbnail: {
        _type: 'image',
        hotspot: { x: 0.5 },
        asset: { url: '/media/abc123-1920x1080.jpg', _ref: '/media/abc123-1920x1080.jpg' },
      },
    });
  });

  it('rewrites file objects too', () => {
    const out = rewriteSanityRefs(
      {
        video: {
          _type: 'file',
          asset: { _type: 'reference', _ref: 'file-xyz789-mp4' },
        },
      },
      ASSET_MAP,
    );
    expect(out.rewritten).toEqual({
      video: {
        _type: 'file',
        asset: { url: '/media/xyz789.mp4', _ref: '/media/xyz789.mp4' },
      },
    });
  });

  it('records unresolved refs', () => {
    const out = rewriteSanityRefs(
      { thumbnail: { _type: 'reference', _ref: 'image-orphan-100x100-png' } },
      ASSET_MAP,
    );
    expect(out.unresolvedAssetRefs).toContain('orphan-100x100-png');
    expect((out.rewritten as unknown as { thumbnail: string }).thumbnail).toBe('image-orphan-100x100-png');
  });

  it('walks nested arrays + objects', () => {
    const out = rewriteSanityRefs(
      {
        blocks: [
          { type: 'hero', img: { _type: 'reference', _ref: 'image-abc123-1920x1080-jpg' } },
          {
            type: 'gallery',
            items: [
              { src: { _type: 'reference', _ref: 'image-abc123-1920x1080-jpg' } },
            ],
          },
        ],
      },
      ASSET_MAP,
    );
    expect(out.assetHits.get('abc123-1920x1080-jpg')).toBe(2);
  });

  it('leaves non-ref objects intact', () => {
    const input = { a: 1, b: 'hello', c: { _type: 'someOther', _ref: 'not-a-ref' } };
    const out = rewriteSanityRefs(input, ASSET_MAP);
    expect(out.rewritten).toEqual(input);
  });
});

describe('rewriteSanityRefs — _sanityAsset pointer (NDJSON export shape)', () => {
  it('rewrites image _sanityAsset pointers and preserves siblings', () => {
    const out = rewriteSanityRefs(
      {
        thumbnail: {
          _type: 'image',
          _sanityAsset: 'image@file://./images/7e95535518369487d31241ed071a29fa1a64d164-1200x800.jpg',
          alt: 'Test image',
        },
      },
      ASSET_MAP,
    );
    expect(out.rewritten).toEqual({
      thumbnail: {
        _type: 'image',
        alt: 'Test image',
        asset: {
          url: '/media/sites/s/media/7e955355-bg.jpg',
          _ref: '/media/sites/s/media/7e955355-bg.jpg',
        },
      },
    });
  });

  it('rewrites file _sanityAsset pointers', () => {
    const out = rewriteSanityRefs(
      {
        videoFile: {
          _type: 'file',
          _sanityAsset: 'file@file://./files/c5773f6c098de2295adf373bbc8d9e44d8580183-mp4.bin',
        },
      },
      ASSET_MAP,
    );
    expect(out.rewritten).toEqual({
      videoFile: {
        _type: 'file',
        asset: {
          url: '/media/sites/s/media/c5773f6c-hero.mp4',
          _ref: '/media/sites/s/media/c5773f6c-hero.mp4',
        },
      },
    });
  });

  it('records unresolved _sanityAsset hashes when the host_media row is missing', () => {
    const out = rewriteSanityRefs(
      {
        thumbnail: {
          _type: 'image',
          _sanityAsset: 'image@file://./images/0000000000000000000000000000000000000000-100x100.png',
        },
      },
      ASSET_MAP,
    );
    expect(out.unresolvedAssetRefs).toContain('0000000000000000000000000000000000000000');
  });
});

describe('rewriteSanityRefs — document refs', () => {
  it('rewrites doc refs when docMap provided', () => {
    const docMap = { byDocId: new Map([['doc-about', '/about']]) };
    const out = rewriteSanityRefs(
      { internal: { _type: 'reference', _ref: 'doc-about' } },
      ASSET_MAP,
      docMap,
    );
    expect(out.rewritten).toEqual({ internal: '/about' });
    expect(out.docHits.get('doc-about')).toBe(1);
  });

  it('leaves unresolved doc refs as objects', () => {
    const docMap = { byDocId: new Map<string, string>() };
    const out = rewriteSanityRefs(
      { internal: { _type: 'reference', _ref: 'doc-phantom' } },
      ASSET_MAP,
      docMap,
    );
    expect(out.unresolvedDocRefs).toContain('doc-phantom');
    expect(out.rewritten).toEqual({ internal: { _type: 'reference', _ref: 'doc-phantom' } });
  });

  it('inlines doc-ref snapshots when a resolver is provided', () => {
    const out = rewriteSanityRefsWithOptions(
      {
        items: [
          { _key: 'k1', _type: 'reference', _ref: 'blog-1' },
          { _key: 'k2', _type: 'reference', _ref: 'blog-phantom' },
        ],
      },
      {
        assetMap: ASSET_MAP,
        docSnapshotResolver: (id) => id === 'blog-1' ? {
          _type: 'blogPost',
          _id: 'blog-1',
          _resolvedFrom: 'blog-1',
          title: 'Hello',
          slug: { current: 'hello', _type: 'slug' },
        } : null,
      },
    );
    const items = (out.rewritten as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]).toMatchObject({ _resolvedFrom: 'blog-1', title: 'Hello' });
    // unresolved doc-ref is reported but the ref shape is preserved
    expect(items[1]).toMatchObject({ _type: 'reference', _ref: 'blog-phantom' });
    expect(out.snapshotHits).toBe(1);
    expect(out.unresolvedDocRefs).toContain('blog-phantom');
  });

  it('refreshes already-resolved snapshots (idempotent re-import)', () => {
    const initial = {
      _type: 'blogPost',
      _id: 'blog-1',
      _resolvedFrom: 'blog-1',
      title: 'Stale title',
    };
    const out = rewriteSanityRefsWithOptions(
      { item: initial },
      {
        assetMap: ASSET_MAP,
        docSnapshotResolver: () => ({
          _type: 'blogPost',
          _id: 'blog-1',
          _resolvedFrom: 'blog-1',
          title: 'Fresh title',
        }),
      },
    );
    expect((out.rewritten as { item: { title: string } }).item.title).toBe('Fresh title');
    expect(out.snapshotHits).toBe(1);
  });
});
