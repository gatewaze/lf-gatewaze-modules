/**
 * Build inline snapshots for Sanity document references.
 *
 * AAIF pages frequently embed `{_type: 'reference', _ref: '<doc-id>'}`
 * pointers into block content — written-content-hub items, hero ctas,
 * speaker tiles, sponsor logos, etc. At runtime there's no Sanity to
 * resolve them, so we replace each ref with a self-contained snapshot
 * the theme can render directly.
 *
 * What goes in a snapshot:
 *   - `_type`   : original doc type (e.g. 'blog', 'event', 'pressNews')
 *   - `_id`     : original Sanity doc id
 *   - `_resolvedFrom`: original ref (sentinel that lets the rewriter
 *                     detect already-resolved snapshots and refresh
 *                     them idempotently)
 *   - `_key`    : the parent's `_key` if present, otherwise the doc id
 *   - title, slug, author (for blogs), publishedAt (or startsAt for
 *     events), summary / description, featuredImage / image, redirectLink
 *
 * The rewriter (`rewriteSanityRefsWithOptions`) walks media-shape nodes
 * AFTER replacement, so any `_sanityAsset` pointers carried on the doc
 * snapshot's `featuredImage` get rewritten to host-media URLs the same
 * way as inline content does.
 */

import type { DocSnapshotResolver } from './rewrite-sanity-refs.js';

export interface SanityDocLike {
  _id: string;
  _type: string;
  title?: string;
  name?: string;
  slug?: { current?: string; _type?: string };
  baseSlug?: { current?: string; _type?: string };
  publishedAt?: string;
  startsAt?: string;
  endsAt?: string;
  summary?: string;
  description?: string;
  redirectLink?: string;
  // Author refs differ per doc type:
  //   blog.author = reference to person
  //   event.host  = reference to person (sometimes)
  author?: { _ref?: string; _type?: string };
  // Featured imagery varies by type — kept loosely typed so we can carry
  // it through verbatim and rely on the rewriter to handle media refs.
  featuredImage?: unknown;
  image?: unknown;
  thumbnail?: unknown;
  [k: string]: unknown;
}

export interface BuildDocSnapshotResolverArgs {
  /**
   * All Sanity docs from the NDJSON, keyed by their (drafts.-stripped)
   * `_id`. The caller is responsible for choosing between drafts and
   * published — the resolver doesn't second-guess.
   */
  byId: ReadonlyMap<string, SanityDocLike>;
}

/**
 * Doc types we know how to snapshot. Other types fall through (resolver
 * returns null → rewriter keeps the original ref intact and surfaces it
 * as an unresolved-doc-ref warning).
 *
 * Kept generous on purpose: when in doubt we'd rather emit a thin
 * snapshot than leave an unrenderable ref in published content.
 */
const SNAPSHOTTABLE_TYPES = new Set([
  'blog',
  'blogPost',
  'event',
  'meetup',
  'podcast',
  'podcastEpisode',
  'pressNews',
  'person',
  'project',
  'testimonial',
  'page',
  'announcement',
  'category',
  'blogCategory',
  'blogTag',
  'blogType',
  'eventCategory',
  'pressNewsCategory',
  'podcastCategory',
]);

/**
 * Build a `DocSnapshotResolver` over a Sanity doc index. Each lookup is
 * pure — no I/O — and idempotent (same input → same output).
 */
export function buildDocSnapshotResolver(args: BuildDocSnapshotResolverArgs): DocSnapshotResolver {
  const { byId } = args;

  return (sanityId: string) => {
    const doc = byId.get(sanityId);
    if (!doc) return null;
    if (!SNAPSHOTTABLE_TYPES.has(doc._type)) return null;
    return buildSnapshot(doc, byId);
  };
}

function buildSnapshot(doc: SanityDocLike, byId: ReadonlyMap<string, SanityDocLike>): Record<string, unknown> {
  const slugValue =
    (doc.slug && typeof doc.slug.current === 'string' && doc.slug.current) ||
    (doc.baseSlug && typeof doc.baseSlug.current === 'string' && doc.baseSlug.current) ||
    null;

  // Type-specific date. Events publish on startsAt; everything else on
  // publishedAt. Both get truncated to YYYY-MM-DD because that's what
  // ContentHubCard renders (and what the theme expects).
  const date = doc._type === 'event' || doc._type === 'meetup'
    ? doc.startsAt
    : doc.publishedAt;
  const publishedAt = formatDate(date);

  // Authors are references to `person` docs. We inline just the name +
  // optional headshot so the theme doesn't need a second lookup.
  let author: Record<string, unknown> | undefined;
  if (doc.author && typeof doc.author === 'object' && typeof doc.author._ref === 'string') {
    const person = byId.get(doc.author._ref);
    if (person) {
      const name = typeof person.name === 'string' ? person.name : (person.title ?? '');
      author = { name };
      if (typeof person.image !== 'undefined') author.image = person.image;
    }
  }

  // Image-ish field: themes look at `featuredImage` first, then `image`
  // (and `thumbnail` for some content types). Carry whichever the source
  // doc has; the rewriter handles the rest (including `_sanityAsset`
  // pointers it may carry).
  const featuredImage = doc.featuredImage ?? doc.image ?? doc.thumbnail;

  const snapshot: Record<string, unknown> = {
    _type: doc._type,
    _id: doc._id,
    _resolvedFrom: doc._id,
    title: typeof doc.title === 'string' ? doc.title : (doc.name ?? ''),
  };
  if (slugValue) snapshot.slug = { current: slugValue, _type: 'slug' };
  if (publishedAt) snapshot.publishedAt = publishedAt;
  if (author) snapshot.author = author;
  if (typeof doc.summary === 'string') snapshot.summary = doc.summary;
  if (typeof doc.description === 'string') snapshot.description = doc.description;
  // `description` fallback for content-hub cards — the renderer reads
  // `description` as a short blurb; if no dedicated description exists,
  // fall through to `summary` so cards aren't blank.
  if (!('description' in snapshot) && typeof doc.summary === 'string') {
    snapshot.description = doc.summary;
  }
  if (typeof doc.redirectLink === 'string') snapshot.redirectLink = doc.redirectLink;
  if (featuredImage !== undefined) snapshot.featuredImage = featuredImage;
  // person-specific fields surface for speaker / author tiles
  if (doc._type === 'person' && typeof doc.role === 'string') snapshot.role = doc.role;
  if (doc._type === 'person' && typeof doc.organization === 'string') snapshot.organization = doc.organization;
  return snapshot;
}

function formatDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const datePart = value.split('T')[0];
  if (!datePart || !/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  return datePart;
}

/**
 * Build a `byId` map from a flat doc list, preferring published over
 * draft variants of the same logical document.
 *
 * Sanity exports can carry up to three variants of the same doc:
 *   - `drafts.<id>`         — the draft
 *   - `<id>`                — the published version
 *   - `versions.<rev>.<id>` — a history version
 *
 * We collapse all three onto `<id>` and prefer the published version.
 * Drafts are accepted as a fallback for docs that only exist as drafts
 * (rare in production exports, common during dev).
 */
export function indexDocsById(docs: ReadonlyArray<SanityDocLike>): Map<string, SanityDocLike> {
  // Two-pass: first record whether each canonical id has a published
  // version, then pick the best variant to store. One-pass-with-rewrite
  // gets tangled because we need the ORIGINAL `_id` to detect draft-ness
  // but we want the canonical id surfaced to consumers.
  const candidates = new Map<string, SanityDocLike[]>();
  for (const doc of docs) {
    const rawId = doc._id;
    if (!rawId) continue;
    const canonicalId = rawId
      .replace(/^drafts\./, '')
      .replace(/^versions\.[^.]+\./, '');
    const list = candidates.get(canonicalId) ?? [];
    list.push(doc);
    candidates.set(canonicalId, list);
  }

  const byId = new Map<string, SanityDocLike>();
  for (const [canonicalId, list] of candidates) {
    // Rank: published (no prefix) > versioned > draft. Stable within rank
    // so NDJSON ordering tiebreaks deterministically.
    const ranked = list.slice().sort((a, b) => rankDoc(a._id) - rankDoc(b._id));
    const winner = ranked[0]!;
    byId.set(canonicalId, { ...winner, _id: canonicalId });
  }
  return byId;
}

function rankDoc(id: string): number {
  if (id.startsWith('drafts.')) return 2;
  if (id.startsWith('versions.')) return 1;
  return 0;
}
