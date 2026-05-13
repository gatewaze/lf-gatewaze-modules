/**
 * Walks a JSON tree and rewrites Sanity reference objects in-place.
 *
 * Three kinds of references appear in Sanity content:
 *
 *   1. **Asset references via `_ref`** — produced by `image` / `file` fields
 *      after Sanity hydrates the asset to its CDN form:
 *      ```json
 *      { "_type": "reference", "_ref": "image-abc-1920x1080-jpg" }
 *      ```
 *      These are rewritten to a string URL pointing at our host-media.
 *
 *   2. **Asset references via `_sanityAsset`** — produced by the
 *      `sanity dataset export` CLI when emitting raw asset pointers:
 *      ```json
 *      { "_type": "image", "_sanityAsset": "image@file://./images/<hash>-<W>x<H>.<ext>" }
 *      { "_type": "file",  "_sanityAsset": "file@file://./files/<hash>-<ext>.bin" }
 *      ```
 *      These are rewritten to a normalised image/file object whose
 *      `asset.url` / `asset._ref` carry `/media/<storage_path>` —
 *      the shape the publisher's media rewriter knows how to resolve
 *      to a CDN URL (or to an embedded git-tree path).
 *
 *   3. **Document references** — produced by `reference` fields (e.g.
 *      a CTA pointing to a page or blog post):
 *      ```json
 *      { "_type": "reference", "_ref": "<doc-uuid>" }
 *      ```
 *      For these we KEEP the ref shape (themes resolve them at SSR), or
 *      replace with a sentinel URL if the caller passes a docResolver,
 *      or replace with an inlined snapshot if the caller passes a
 *      docSnapshotResolver.
 *
 * Pure function — no I/O, callers supply the mapping.
 */

export interface AssetRefMap {
  /** sanity asset id → URL placeholder (e.g. `/media/<storage_path>`). */
  byAssetId: ReadonlyMap<string, string>;
}

export interface DocRefMap {
  /** sanity document id → relative path on the site (e.g. `/about`). */
  byDocId: ReadonlyMap<string, string>;
}

/**
 * Optional inline-snapshot resolver for document references.
 *
 * When supplied, references like `{ _type: 'reference', _ref: '<doc-uuid>' }`
 * are rewritten to a full doc snapshot the theme can render directly
 * (title, slug, author, summary, featuredImage, etc.). Already-resolved
 * snapshots (carrying `_resolvedFrom`) are re-resolved idempotently so a
 * subsequent import refreshes them in place.
 */
export interface DocSnapshotResolver {
  /** Resolve a Sanity document id → an inline snapshot, or `null` if unknown. */
  (sanityId: string): Record<string, unknown> | null;
}

export interface RewriteResult<T = unknown> {
  rewritten: T;
  /** Per-asset-id: how many times it appeared. */
  assetHits: Map<string, number>;
  /** Per-doc-id: how many times it appeared. */
  docHits: Map<string, number>;
  /** Asset refs that didn't match the map — likely deleted assets. */
  unresolvedAssetRefs: string[];
  /** Document refs that didn't match the map. */
  unresolvedDocRefs: string[];
  /** Inline doc snapshots produced (new or refreshed). */
  snapshotHits: number;
}

export interface RewriteOptions {
  assetMap: AssetRefMap;
  docMap?: DocRefMap;
  /** When set, doc refs are inlined as snapshots in addition to / instead of docMap rewriting. */
  docSnapshotResolver?: DocSnapshotResolver;
}

/**
 * Backward-compatible wrapper around `rewriteSanityRefsWithOptions`. Older
 * callers pass positional asset/doc maps; new callers should use the
 * options object so they can plumb in a snapshot resolver.
 */
export function rewriteSanityRefs<T = unknown>(
  value: T,
  assetMap: AssetRefMap,
  docMap?: DocRefMap,
): RewriteResult<T> {
  return rewriteSanityRefsWithOptions(value, {
    assetMap,
    ...(docMap ? { docMap } : {}),
  });
}

export function rewriteSanityRefsWithOptions<T = unknown>(
  value: T,
  options: RewriteOptions,
): RewriteResult<T> {
  const assetMap = options.assetMap;
  const docMap = options.docMap;
  const snapshotResolver = options.docSnapshotResolver;
  const assetHits = new Map<string, number>();
  const docHits = new Map<string, number>();
  const unresolvedAssetRefs = new Set<string>();
  const unresolvedDocRefs = new Set<string>();
  let snapshotHits = 0;

  function tryAssetLookup(assetId: string): string | null {
    const url = assetMap.byAssetId.get(assetId);
    if (url !== undefined) {
      assetHits.set(assetId, (assetHits.get(assetId) ?? 0) + 1);
      return url;
    }
    unresolvedAssetRefs.add(assetId);
    return null;
  }

  function walk(node: unknown): unknown {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);

    const obj = node as Record<string, unknown>;

    // Sanity reference?
    if (obj._type === 'reference' && typeof obj._ref === 'string') {
      const ref = obj._ref;
      if (isAssetRef(ref)) {
        const assetId = stripAssetPrefix(ref);
        const url = tryAssetLookup(assetId);
        if (url !== null) return url;
        return ref;
      }
      // Document reference. Prefer the snapshot resolver (richer output)
      // when supplied; fall back to the path-rewriting docMap.
      if (snapshotResolver) {
        const snap = snapshotResolver(ref);
        if (snap) {
          snapshotHits += 1;
          docHits.set(ref, (docHits.get(ref) ?? 0) + 1);
          return snap;
        }
      }
      const url = docMap?.byDocId.get(ref);
      if (url !== undefined) {
        docHits.set(ref, (docHits.get(ref) ?? 0) + 1);
        return url;
      }
      unresolvedDocRefs.add(ref);
      return obj; // leave intact — theme may resolve at SSR
    }

    // Already-resolved snapshot — re-resolve idempotently so subsequent
    // imports pick up author / summary / etc. changes from the export
    // without losing previously-resolved content.
    if (snapshotResolver && typeof obj._resolvedFrom === 'string') {
      const fresh = snapshotResolver(obj._resolvedFrom);
      if (fresh) {
        snapshotHits += 1;
        return fresh;
      }
    }

    // Sanity image with asset child reference (typical when assets.json
    // is hydrated):
    //   { _type: 'image', asset: { _type: 'reference', _ref: 'image-...' }, ... }
    // Convert to the publisher-rewritable shape, preserving alt / hotspot
    // siblings.
    if ((obj._type === 'image' || obj._type === 'file') && obj.asset && typeof obj.asset === 'object') {
      const asset = obj.asset as Record<string, unknown>;
      if (asset._type === 'reference' && typeof asset._ref === 'string' && isAssetRef(asset._ref)) {
        const assetId = stripAssetPrefix(asset._ref);
        const url = tryAssetLookup(assetId);
        if (url !== null) {
          return buildAssetObject(obj, url);
        }
        // Couldn't resolve — leave intact so the warning surfaces.
        return obj;
      }
    }

    // Raw `_sanityAsset` shape from `sanity dataset export`:
    //   { _type: 'image', _sanityAsset: 'image@file://./images/<hash>-WxH.<ext>' }
    //   { _type: 'file',  _sanityAsset: 'file@file://./files/<hash>-<ext>.bin' }
    // The hash is the host_media lookup key — it's how uploadSanityAssets
    // keys its refMap (`<hash>`, `<hash>-WxH-<ext>`, and the raw on-disk
    // basename).
    if (typeof obj._sanityAsset === 'string') {
      const parsed = parseSanityAssetPointer(obj._sanityAsset);
      if (parsed) {
        // Try all the keys uploadSanityAssets registers — bare hash first
        // (most permissive), then the dims/ext form, then the on-disk
        // basename form. Whichever hits, we win.
        const candidates: string[] = [parsed.hash];
        if (parsed.dims && parsed.ext) candidates.push(`${parsed.hash}-${parsed.dims}-${parsed.ext}`);
        if (parsed.ext) candidates.push(`${parsed.hash}-${parsed.ext}`);
        if (parsed.basenameNoExt) candidates.push(parsed.basenameNoExt);
        let resolved: string | null = null;
        for (const k of candidates) {
          const u = assetMap.byAssetId.get(k);
          if (u !== undefined) {
            assetHits.set(k, (assetHits.get(k) ?? 0) + 1);
            resolved = u;
            break;
          }
        }
        if (resolved !== null) {
          return buildAssetObject(obj, resolved, parsed.kind);
        }
        unresolvedAssetRefs.add(parsed.hash);
        // Fall through: still strip the noisy `_sanityAsset` from the
        // shape we recurse into, so we don't carry the pointer forward
        // unchanged — but only if we already produced a partial shape.
        return obj;
      }
    }

    // Recurse into the object
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = walk(v);
    }
    return out;
  }

  const rewritten = walk(value) as T;
  return {
    rewritten,
    assetHits,
    docHits,
    unresolvedAssetRefs: Array.from(unresolvedAssetRefs),
    unresolvedDocRefs: Array.from(unresolvedDocRefs),
    snapshotHits,
  };
}

function isAssetRef(ref: string): boolean {
  return ref.startsWith('image-') || ref.startsWith('file-');
}

/**
 * Sanity asset _ref form: `image-<id>-<dims>-<ext>` or `file-<id>-<ext>`.
 * The CDN URL form is `<id>-<dims>.<ext>` for images, `<id>.<ext>` for files.
 * For our purposes, we use the bare assetId (the full _ref minus the prefix)
 * as the key so it round-trips with the assets.json manifest from the export.
 */
function stripAssetPrefix(ref: string): string {
  return ref.replace(/^(image|file)-/, '');
}

interface SanityAssetPointer {
  kind: 'image' | 'file';
  hash: string;
  dims?: string;
  ext?: string;
  basenameNoExt?: string;
}

/**
 * Parse the `_sanityAsset` pointer string that `sanity dataset export`
 * emits when assets are dehydrated to file:// references.
 *
 * Examples:
 *   image@file://./images/<hash>-WxH.<ext>
 *   file@file://./files/<hash>-<ext>.bin   (e.g. `-mp4.bin`)
 */
function parseSanityAssetPointer(s: string): SanityAssetPointer | null {
  const imageMatch = /^image@file:\/\/\.\/images\/([a-f0-9]+)-(\d+x\d+)\.(\w+)$/i.exec(s);
  if (imageMatch) {
    const [, hash, dims, ext] = imageMatch as unknown as [string, string, string, string];
    return { kind: 'image', hash, dims, ext, basenameNoExt: `${hash}-${dims}` };
  }
  // Files: usually `./files/<hash>-<origExt>.bin` (Sanity appends .bin to
  // the on-disk binary). The "ext" we care about for lookup is the part
  // BEFORE `.bin` because uploadSanityAssets uses the path.extname() of
  // the on-disk file (`.bin`).
  const fileMatch = /^file@file:\/\/\.\/files\/([a-f0-9]+)-(\w+)\.(\w+)$/i.exec(s);
  if (fileMatch) {
    const [, hash, ext] = fileMatch as unknown as [string, string, string];
    return { kind: 'file', hash, ext, basenameNoExt: hash };
  }
  // Generic last-ditch: just pull out the first 40-hex hash.
  const fallback = /([a-f0-9]{40,})/i.exec(s);
  if (fallback) {
    const kind: 'image' | 'file' = s.startsWith('file@') ? 'file' : 'image';
    return { kind, hash: fallback[1]! };
  }
  return null;
}

/**
 * Build the publisher-rewritable image/file shape from an absolute URL
 * pointing at the host_media path. Preserves alt / hotspot / crop siblings
 * present on the source node. Removes the dehydrated `_sanityAsset`
 * pointer so we don't emit it into the live database.
 */
function buildAssetObject(
  source: Record<string, unknown>,
  url: string,
  kindHint?: 'image' | 'file',
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === 'asset' || k === '_sanityAsset') continue;
    out[k] = v;
  }
  const declaredType = typeof source._type === 'string' ? source._type : undefined;
  if (!declaredType) {
    out._type = kindHint ?? 'image';
  }
  const existingAsset = (typeof source.asset === 'object' && source.asset !== null
    ? source.asset
    : {}) as Record<string, unknown>;
  // Drop the inner `_type: 'reference'` + `_ref` — they refer to the
  // pre-resolution Sanity asset id, which the publisher's media rewriter
  // can't act on. Anything else on the asset (e.g. `metadata`) carries
  // through.
  const carriedAsset: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existingAsset)) {
    if (k === '_type' || k === '_ref') continue;
    carriedAsset[k] = v;
  }
  out.asset = {
    ...carriedAsset,
    _ref: url,
    url,
  };
  return out;
}
