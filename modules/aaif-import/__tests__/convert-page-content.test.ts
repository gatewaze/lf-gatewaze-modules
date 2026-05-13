import { describe, expect, it } from 'vitest';
import { convertPageContent, type SanityPageDoc } from '../lib/convert-page-content.js';

const SITE_ID = 'site-aaif';
const PERSONA_MAP = {
  'tier-general': 'general',
  'tier-developer': 'developer',
  'tier-enterprise': 'enterprise',
};
const ALL_PERSONAS = ['general', 'developer', 'enterprise'];

function makePage(over: Partial<SanityPageDoc>): SanityPageDoc {
  return {
    _id: 'page-1',
    _type: 'page',
    title: 'Home',
    baseSlug: { current: 'home' },
    pageBuilder: [],
    ...over,
  };
}

describe('convertPageContent — basic blocks', () => {
  it('maps pageBuilder entries to page_blocks rows', () => {
    const { page } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({
        pageBuilder: [
          { _key: 'k1', _type: 'hero', heading: { text: 'Welcome' } },
          { _key: 'k2', _type: 'subscription', eyebrow: 'Subscribe' },
        ],
      }),
    });
    expect(page.blocks).toHaveLength(2);
    expect(page.blocks[0]).toMatchObject({
      block_def_key: 'hero',
      sort_order: 0,
      content: { heading: { text: 'Welcome' } },
    });
    expect(page.blocks[1]).toMatchObject({
      block_def_key: 'subscription',
      sort_order: 1,
      content: { eyebrow: 'Subscribe' },
    });
  });

  it('preserves page metadata', () => {
    const { page } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({ title: 'About', baseSlug: { current: 'about' } }),
    });
    expect(page).toMatchObject({
      site_id: SITE_ID,
      title: 'About',
      slug: 'about',
      full_path: '/about',
      composition_mode: 'blocks',
    });
  });

  it('uses fullPath override', () => {
    const { page } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({ baseSlug: { current: 'home' } }),
      fullPath: '/',
    });
    expect(page.full_path).toBe('/');
  });
});

describe('convertPageContent — visibility variants', () => {
  it('emits _hidden variants for personas not in visibleTo', () => {
    const { page } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({
        pageBuilder: [{
          _key: 'k1',
          _type: 'hero',
          heading: { text: 'Welcome' },
          visibleTo: [{ _type: 'reference', _ref: 'tier-developer' }],
        }],
      }),
    });
    expect(page.variants).toHaveLength(2);
    const hiddenForGeneral = page.variants.find((v) => v.match_context.persona === 'general');
    const hiddenForEnterprise = page.variants.find((v) => v.match_context.persona === 'enterprise');
    expect(hiddenForGeneral).toMatchObject({ value: true });
    expect(hiddenForEnterprise).toMatchObject({ value: true });
    expect(hiddenForGeneral?.field_path).toMatch(/\._hidden$/);
  });

  it('emits zero variants when visibleTo is empty', () => {
    const { page } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({
        pageBuilder: [{ _key: 'k1', _type: 'hero', visibleTo: [] }],
      }),
    });
    expect(page.variants).toHaveLength(0);
  });
});

describe('convertPageContent — personalizedBlock', () => {
  it('decomposes default variant into base block + per-tier content variants (legacy body shape)', () => {
    const { page } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({
        pageBuilder: [{
          _key: 'pb1',
          _type: 'personalizedBlock',
          variants: [
            {
              _key: 'def',
              _type: 'personalizedVariant',
              isDefault: true,
              body: { _key: 'def-body', _type: 'hero', heading: { text: 'General' } },
            },
            {
              _key: 'ent',
              _type: 'personalizedVariant',
              tiers: [{ _type: 'reference', _ref: 'tier-enterprise' }],
              body: { _key: 'ent-body', _type: 'hero', heading: { text: 'Enterprise' } },
            },
          ],
        }],
      }),
    });
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]).toMatchObject({
      block_def_key: 'hero',
      content: { heading: { text: 'General' } },
    });
    expect(page.variants).toHaveLength(1);
    expect(page.variants[0]).toMatchObject({
      match_context: { persona: 'enterprise' },
      value: { heading: { text: 'Enterprise' } },
    });
    expect(page.variants[0]?.field_path).toMatch(/\.content$/);
  });

  it('handles `content: [body]` array shape from `sanity dataset export`', () => {
    // This is the actual on-disk shape — variants carry a `content: []`
    // array (one entry, the block body) and the wrapper has NO isDefault
    // flag. Default tier is identified via `defaultTierId`.
    const { page, warnings } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      defaultTierId: 'tier-general',
      pageDoc: makePage({
        pageBuilder: [{
          _key: 'pb1',
          _type: 'personalizedBlock',
          variants: [
            {
              _key: 'ent',
              _type: 'personalizedVariant',
              tiers: [{ _type: 'reference', _ref: 'tier-enterprise' }],
              content: [{ _key: 'ent-body', _type: 'hero', heading: { text: 'Enterprise' } }],
            },
            {
              _key: 'def',
              _type: 'personalizedVariant',
              tiers: [{ _type: 'reference', _ref: 'tier-general' }],
              content: [{ _key: 'def-body', _type: 'hero', heading: { text: 'General' } }],
            },
            {
              _key: 'dev',
              _type: 'personalizedVariant',
              tiers: [{ _type: 'reference', _ref: 'tier-developer' }],
              content: [{ _key: 'dev-body', _type: 'hero', heading: { text: 'Developer' } }],
            },
          ],
        }],
      }),
    });
    expect(warnings).toHaveLength(0);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]).toMatchObject({
      block_def_key: 'hero',
      content: { heading: { text: 'General' } },
    });
    expect(page.variants).toHaveLength(2);
    const heroBlockId = page.blocks[0]!.id;
    expect(page.variants.map((v) => v.match_context)).toEqual(
      expect.arrayContaining([{ persona: 'enterprise' }, { persona: 'developer' }]),
    );
    expect(page.variants.every((v) => v.field_path === `${heroBlockId}.content`)).toBe(true);
  });

  it('falls back to first variant + warns when no isDefault/defaultTierId matches', () => {
    const { warnings, page } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({
        pageBuilder: [{
          _key: 'pb1',
          _type: 'personalizedBlock',
          variants: [
            { _key: 'a', _type: 'personalizedVariant', tiers: [{ _type: 'reference', _ref: 'tier-enterprise' }], content: [{ _key: 'a-b', _type: 'hero', heading: { text: 'A' } }] },
            { _key: 'b', _type: 'personalizedVariant', tiers: [{ _type: 'reference', _ref: 'tier-developer' }], content: [{ _key: 'b-b', _type: 'hero', heading: { text: 'B' } }] },
          ],
        }],
      }),
    });
    expect(warnings.some((w) => w.reason.includes('using first variant as default'))).toBe(true);
    expect(page.blocks[0]?.content).toMatchObject({ heading: { text: 'A' } });
  });

  it('warns when variants change block_def type', () => {
    const { warnings } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({
        pageBuilder: [{
          _key: 'pb1',
          _type: 'personalizedBlock',
          variants: [
            { _key: 'a', _type: 'personalizedVariant', isDefault: true, body: { _key: 'a-b', _type: 'hero' } },
            { _key: 'b', _type: 'personalizedVariant', tiers: [{ _type: 'reference', _ref: 'tier-enterprise' }], body: { _key: 'b-b', _type: 'subscription' } },
          ],
        }],
      }),
    });
    expect(warnings.some((w) => w.reason.includes('must keep the same block type'))).toBe(true);
  });
});

describe('convertPageContent — tierOrdering', () => {
  it('emits _pageOrder variant with reordered block ids', () => {
    const { page } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({
        pageBuilder: [
          { _key: 'kA', _type: 'hero' },
          { _key: 'kB', _type: 'projects' },
          { _key: 'kC', _type: 'faq' },
        ],
        tierOrdering: [{
          _key: 'to-1',
          tier: { _type: 'reference', _ref: 'tier-enterprise' },
          blockOrder: ['kC', 'kA', 'kB'],
        }],
      }),
    });
    const pageOrderVariant = page.variants.find((v) => v.field_path === '_pageOrder');
    expect(pageOrderVariant).toBeDefined();
    expect(pageOrderVariant?.match_context).toEqual({ persona: 'enterprise' });
    expect(Array.isArray(pageOrderVariant?.value)).toBe(true);
    expect((pageOrderVariant?.value as string[]).length).toBe(3);
  });

  it('warns on unresolved tier ref in ordering', () => {
    const { warnings } = convertPageContent({
      siteId: SITE_ID,
      personaIdMap: PERSONA_MAP,
      allPersonaNames: ALL_PERSONAS,
      pageDoc: makePage({
        pageBuilder: [{ _key: 'kA', _type: 'hero' }],
        tierOrdering: [{
          _key: 'to-1',
          tier: { _type: 'reference', _ref: 'tier-phantom' },
          blockOrder: ['kA'],
        }],
      }),
    });
    expect(warnings.some((w) => w.reason.includes('unresolved tier ref'))).toBe(true);
  });
});
