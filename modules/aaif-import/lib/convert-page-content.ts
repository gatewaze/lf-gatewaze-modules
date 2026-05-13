/**
 * Convert an AAIF Sanity page document into Gatewaze rows.
 *
 * Outputs a `ConvertedPage` containing:
 *   - One `page_blocks` row per pageBuilder entry
 *   - `page_variants` rows for every per-tier visibility / content overlay
 *
 * Per the audit, AAIF expresses tier-driven personalization three ways:
 *
 *   1. **visibleTo on a regular block** — block_def has a `visibilityFields.visibleTo`
 *      array of tierDefinition refs. Empty / missing = visible to all.
 *      When non-empty, we emit a variant per non-listed persona setting
 *      `_hidden: true` on the block instance. The theme's renderer
 *      checks `_hidden` and skips the block for that persona.
 *
 *   2. **personalizedBlock wrapper** — the entry is `_type: 'personalizedBlock'`
 *      containing multiple `personalizedVariant` siblings, each targeting
 *      one or more tiers. We emit ONE page_blocks row using the default
 *      variant's body, plus one page_variants row per non-default variant
 *      replacing the block's `content` for the targeted personas.
 *
 *   3. **tierOrdering** at page level — the page document carries an
 *      optional `tierOrdering` array remapping the block sequence per
 *      tier. We emit a variant on a synthetic `_pageOrder` field at the
 *      page root carrying the reordered block-id sequence. (Themes
 *      consume `__variants["_pageOrder"]` to re-sort blocks.)
 *
 * Each block instance gets a fresh UUID — same id is used in `page_blocks.id`
 * and in any `page_variants.field_path` referencing it.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConvertedPage,
  ConvertedPageBlock,
  ConvertedPageVariant,
  PersonaCondition,
} from './seed-types.js';

export interface SanityRef {
  _ref: string;
  _type: 'reference';
  _weak?: boolean;
}

export interface SanityPageBuilderEntry {
  _key: string;
  _type: string;
  visibleTo?: ReadonlyArray<SanityRef>;
  variants?: ReadonlyArray<SanityPersonalizedVariant>;
  [k: string]: unknown;
}

export interface SanityPersonalizedVariant {
  _key: string;
  _type: 'personalizedVariant';
  isDefault?: boolean;
  /** Tiers this variant targets — array of tierDefinition refs. */
  tiers?: ReadonlyArray<SanityRef>;
  /**
   * The actual block body. The `sanity dataset export` output wraps the
   * body in a `content: [<body>]` array (one entry per variant). Older
   * test fixtures (and some hand-authored content) carry it as `body`
   * directly. We accept both shapes — see `extractVariantBody`.
   */
  body?: SanityPageBuilderEntry;
  content?: ReadonlyArray<SanityPageBuilderEntry>;
}

export interface SanityTierBlockOrder {
  _key: string;
  tier?: SanityRef;
  blockOrder?: ReadonlyArray<string>;
}

export interface SanityPageDoc {
  _id: string;
  _type: 'page';
  title: string;
  baseSlug?: { current?: string };
  slug?: { current?: string };
  pageBuilder?: ReadonlyArray<SanityPageBuilderEntry>;
  tierOrdering?: ReadonlyArray<SanityTierBlockOrder>;
  seo?: Record<string, unknown>;
}

export interface ConvertPageContentArgs {
  siteId: string;
  pageDoc: SanityPageDoc;
  /** Sanity tierDefinition _id → persona name (from convertTierDefs.idMap). */
  personaIdMap: Record<string, string>;
  /** All persona names — needed so we can compute "all OTHER personas" for hide variants. */
  allPersonaNames: ReadonlyArray<string>;
  /**
   * Sanity _id of the default `tierDefinition`. Used to disambiguate which
   * `personalizedVariant` becomes the base block when the export doesn't
   * carry `isDefault` flags on the variants themselves (`sanity dataset
   * export` strips them — they live on the tier, not the variant). When
   * unset we fall back to "the variant matching the persona marked default
   * in `personaIdMap`'s sibling personas list" → not knowable here, so
   * the first variant wins.
   */
  defaultTierId?: string;
  /**
   * Optional full path. Defaults to `/${slug}`. Pass explicitly for the
   * homepage (`/`) or other custom routes the agency uses.
   */
  fullPath?: string;
}

export interface ConvertPageContentResult {
  page: ConvertedPage;
  warnings: ReadonlyArray<{ entryKey: string; reason: string }>;
}

const HIDDEN_FLAG = '_hidden';
const PAGE_ORDER_FIELD = '_pageOrder';

export function convertPageContent(args: ConvertPageContentArgs): ConvertPageContentResult {
  const warnings: Array<{ entryKey: string; reason: string }> = [];
  const pageId = randomUUID();
  const slug = args.pageDoc.baseSlug?.current ?? args.pageDoc.slug?.current ?? args.pageDoc._id;
  const fullPath = args.fullPath ?? `/${slug}`;

  const blocks: ConvertedPageBlock[] = [];
  const variants: ConvertedPageVariant[] = [];

  const builderEntries = args.pageDoc.pageBuilder ?? [];
  // Track the Sanity _key → assigned page_blocks.id mapping so
  // tierOrdering can address blocks by their new uuids.
  const sanityKeyToBlockId: Record<string, string> = {};

  builderEntries.forEach((entry, index) => {
    const blockId = randomUUID();
    sanityKeyToBlockId[entry._key] = blockId;

    if (entry._type === 'personalizedBlock') {
      handlePersonalizedBlock(entry, blockId, index, pageId, args, blocks, variants, warnings);
      return;
    }

    // Regular block
    const { content, blockKey } = stripStructural(entry);
    blocks.push({
      id: blockId,
      page_id: pageId,
      block_def_key: blockKey,
      sort_order: index,
      variant_key: 'default',
      content,
    });

    // Visibility variants: when visibleTo is set, emit `_hidden: true`
    // variants for personas not in the list.
    if (entry.visibleTo && entry.visibleTo.length > 0) {
      const allowedPersonas = entry.visibleTo
        .map((ref) => args.personaIdMap[ref._ref])
        .filter((p): p is string => p !== undefined);
      const hidePersonas = args.allPersonaNames.filter((p) => !allowedPersonas.includes(p));
      for (const personaName of hidePersonas) {
        variants.push({
          page_id: pageId,
          field_path: `${blockId}.${HIDDEN_FLAG}`,
          match_context: { persona: personaName },
          value: true,
          priority: 100,
          persona_id: null,
        });
      }
    }
  });

  // tierOrdering — per-persona block order overrides.
  if (args.pageDoc.tierOrdering) {
    for (const ordering of args.pageDoc.tierOrdering) {
      const tierRef = ordering.tier?._ref;
      const personaName = tierRef ? args.personaIdMap[tierRef] : undefined;
      if (!personaName) {
        warnings.push({ entryKey: ordering._key, reason: 'tierOrdering: unresolved tier ref' });
        continue;
      }
      if (!ordering.blockOrder || ordering.blockOrder.length === 0) continue;
      const blockIdOrder = ordering.blockOrder
        .map((sanityKey) => sanityKeyToBlockId[sanityKey])
        .filter((id): id is string => id !== undefined);
      variants.push({
        page_id: pageId,
        field_path: PAGE_ORDER_FIELD,
        match_context: { persona: personaName },
        value: blockIdOrder,
        priority: 100,
        persona_id: null,
      });
    }
  }

  return {
    page: {
      id: pageId,
      site_id: args.siteId,
      slug,
      full_path: fullPath,
      title: args.pageDoc.title,
      composition_mode: 'blocks',
      blocks,
      bricks: [], // AAIF blocks don't use bricks in v1
      variants,
    },
    warnings,
  };
}

function handlePersonalizedBlock(
  entry: SanityPageBuilderEntry,
  blockId: string,
  sortOrder: number,
  pageId: string,
  args: ConvertPageContentArgs,
  blocks: ConvertedPageBlock[],
  variants: ConvertedPageVariant[],
  warnings: Array<{ entryKey: string; reason: string }>,
): void {
  const personalizedVariants = entry.variants ?? [];
  if (personalizedVariants.length === 0) {
    warnings.push({ entryKey: entry._key, reason: 'personalizedBlock with no variants — skipping' });
    return;
  }

  // Find the default variant. Three strategies tried in order:
  //   1. explicit `isDefault: true` flag on the variant (hand-authored)
  //   2. variant whose `tiers[]._ref` matches `defaultTierId` (Sanity
  //      stores isDefault on the tierDefinition, not the variant — this
  //      is what `sanity dataset export` produces)
  //   3. the first variant (last-resort fallback; surfaces a warning)
  const defaultVariant =
    personalizedVariants.find((v) => v.isDefault) ??
    (args.defaultTierId
      ? personalizedVariants.find((v) => (v.tiers ?? []).some((r) => r._ref === args.defaultTierId))
      : undefined) ??
    personalizedVariants[0]!;
  const defaultBody = extractVariantBody(defaultVariant);
  if (!defaultBody) {
    warnings.push({ entryKey: entry._key, reason: 'personalizedBlock default variant has no body' });
    return;
  }
  if (!defaultVariant.isDefault && (!args.defaultTierId
    || !(defaultVariant.tiers ?? []).some((r) => r._ref === args.defaultTierId))) {
    warnings.push({
      entryKey: entry._key,
      reason: 'personalizedBlock: no isDefault flag nor matching defaultTierId — using first variant as default',
    });
  }
  const { content: defaultContent, blockKey } = stripStructural(defaultBody);

  blocks.push({
    id: blockId,
    page_id: pageId,
    block_def_key: blockKey,
    sort_order: sortOrder,
    variant_key: 'default',
    content: defaultContent,
  });

  // For every non-default variant, emit a whole-content variant per
  // targeted persona.
  for (const v of personalizedVariants) {
    if (v === defaultVariant) continue;
    const body = extractVariantBody(v);
    if (!body) {
      warnings.push({ entryKey: entry._key, reason: `personalizedVariant ${v._key} missing body` });
      continue;
    }
    const { content: variantContent, blockKey: variantBlockKey } = stripStructural(body);
    if (variantBlockKey !== blockKey) {
      warnings.push({
        entryKey: entry._key,
        reason: `personalizedVariant ${v._key} has block_def ${variantBlockKey}, default is ${blockKey} — variants must keep the same block type`,
      });
      continue;
    }
    const tierRefs = v.tiers ?? [];
    for (const ref of tierRefs) {
      const personaName = args.personaIdMap[ref._ref];
      if (!personaName) {
        warnings.push({ entryKey: entry._key, reason: `personalizedVariant ${v._key}: unresolved tier ref ${ref._ref}` });
        continue;
      }
      variants.push({
        page_id: pageId,
        field_path: `${blockId}.content`,
        match_context: { persona: personaName },
        value: variantContent,
        priority: 100,
        persona_id: null,
      });
    }
  }
}

/**
 * Get the inner block body from a personalizedVariant, accepting either
 * the historical `body: <block>` shape or the export-on-disk
 * `content: [<block>]` array shape. When `content` carries more than one
 * entry the FIRST entry is used (matches the Sanity studio UI, which
 * only edits one block per variant). Extras are silently dropped.
 */
function extractVariantBody(v: SanityPersonalizedVariant): SanityPageBuilderEntry | undefined {
  if (v.body) return v.body;
  if (Array.isArray(v.content) && v.content.length > 0) return v.content[0];
  return undefined;
}

/**
 * Strip Sanity bookkeeping fields (_type, _key, visibleTo, variants)
 * from a builder entry so the remainder is just the editor-authored
 * block content.
 */
function stripStructural(entry: SanityPageBuilderEntry): {
  content: Record<string, unknown>;
  blockKey: string;
} {
  const { _key, _type, visibleTo, variants, ...rest } = entry as Record<string, unknown> & {
    _key: string;
    _type: string;
  };
  void _key;
  void visibleTo;
  void variants;
  return { content: rest, blockKey: _type };
}

/** Re-exported for the seed-applier so it knows the flag name. */
export const HIDDEN_FLAG_NAME = HIDDEN_FLAG;
export const PAGE_ORDER_FIELD_NAME = PAGE_ORDER_FIELD;
export type { PersonaCondition };
