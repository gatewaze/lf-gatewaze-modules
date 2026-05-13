#!/usr/bin/env tsx
/**
 * Apply seed JSON files (block-defs, personas, pages) to a Gatewaze
 * Supabase instance. Optionally uploads the Sanity dataset's assets
 * to host-media and rewrites Sanity refs in content to use the new
 * storage paths.
 *
 * Usage (full pipeline):
 *   pnpm apply-seed \
 *     --supabase-url=https://aaif.supabase.co \
 *     --service-key=<service-role-key> \
 *     --site-slug=aaif \
 *     --seed=./seed \
 *     --sanity-export=/tmp/production-export-2026-05-12t13-57-41-983z \
 *     --embed-media-in-git
 *
 * What it does (in order):
 *   1. Resolve / create the `sites` row (by slug) and its templates_library
 *   2. Upload each Sanity asset under <export>/images and <export>/files to
 *      Gatewaze Supabase Storage (gatewaze-media bucket) and insert a
 *      host_media row per asset. Builds a Sanity assetId → storage path map.
 *   3. Apply block-defs.json → templates_block_defs rows (upsert by library_id+key)
 *   4. Apply personas.json   → site_personas rows (upsert by site_id+name),
 *                              keeping a tier _id → site_personas.id map
 *   5. Apply pages.json → pages + page_blocks + page_block_bricks + page_variants.
 *      Each page's content is walked through rewriteSanityRefs to swap
 *      asset _ref objects with the materialized /media/<storage_path> URL.
 *   6. If --embed-media-in-git is set, write
 *      sites.config.publish.embed_media_in_git = true so the next publish
 *      bakes the media binaries into the git tree.
 *
 * Idempotent: re-running upserts where it can. host_media uploads dedupe
 * by storage_path. block_defs / personas / pages key off stable identifiers.
 *
 * Output: a `apply-seed.log.json` summary in the seed directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { rewriteSanityRefsWithOptions, type DocSnapshotResolver } from '../lib/rewrite-sanity-refs.js';
import { convertBlogs, type SanityBlogDoc, type SanityPersonDoc, type SanityBlogTagDoc } from '../lib/convert-blogs.js';
import { convertMenus, type SanityHeaderSettingsDoc, type SanityFooterSettingsDoc } from '../lib/convert-menus.js';
import { loadNdjson } from '../lib/load-ndjson.js';
import { GATEWAZE_NATIVE_BLOCKS } from '../lib/gatewaze-native-blocks.js';
import { buildDocSnapshotResolver, indexDocsById, type SanityDocLike } from '../lib/doc-snapshot-resolver.js';
import type {
  ConvertedPage,
  ConvertedPageBlock,
  ConvertedPageVariant,
  ConvertedPersona,
} from '../lib/seed-types.js';

interface CliArgs {
  supabaseUrl: string;
  serviceKey: string;
  siteSlug: string;
  seedDir: string;
  sanityExportDir: string | null;
  embedMediaInGit: boolean;
  bucketName: string;
}

interface ApplySummary {
  startedAt: string;
  finishedAt: string;
  siteId: string;
  libraryId: string;
  assetsUploaded: number;
  assetsSkipped: number;
  blockDefs: { applied: number; skipped: number };
  personas: { applied: number };
  pages: { applied: number; blocks: number; bricks: number; variants: number };
  blog: { people: number; tags: number; posts: number; postTags: number; skipped: number };
  menu: { menus: number; items: number };
  unresolvedAssetRefs: string[];
  warnings: string[];
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        args[a.slice(2)] = true;
      } else {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      }
    }
  }
  const supabaseUrl = String(args['supabase-url'] ?? '');
  const serviceKey = String(args['service-key'] ?? '');
  const siteSlug = String(args['site-slug'] ?? '');
  if (!supabaseUrl) throw new Error('Missing --supabase-url');
  if (!serviceKey) throw new Error('Missing --service-key');
  if (!siteSlug) throw new Error('Missing --site-slug');
  return {
    supabaseUrl,
    serviceKey,
    siteSlug,
    seedDir: String(args.seed ?? './seed'),
    sanityExportDir: args['sanity-export'] ? String(args['sanity-export']) : null,
    embedMediaInGit: args['embed-media-in-git'] === true,
    bucketName: String(args.bucket ?? 'media'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  console.log(`apply-seed starting`);
  console.log(`  target: ${args.supabaseUrl}`);
  console.log(`  site:   ${args.siteSlug}`);
  console.log(`  seed:   ${args.seedDir}`);
  console.log(`  assets: ${args.sanityExportDir ?? '(skipped)'}`);

  const supabase = createClient(args.supabaseUrl, args.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // -------------------------------------------------------------------------
  // 1. Resolve site + library
  // -------------------------------------------------------------------------
  const { siteId, libraryId } = await ensureSiteAndLibrary(supabase, args.siteSlug);
  console.log(`✓ site=${siteId} library=${libraryId}`);

  // -------------------------------------------------------------------------
  // 2. Upload Sanity assets (when provided)
  // -------------------------------------------------------------------------
  const assetRefMap = new Map<string, string>();
  let assetsUploaded = 0;
  let assetsSkipped = 0;
  if (args.sanityExportDir) {
    const result = await uploadSanityAssets(supabase, {
      siteId,
      sanityExportDir: args.sanityExportDir,
      bucket: args.bucketName,
    });
    assetsUploaded = result.uploaded;
    assetsSkipped = result.skipped;
    for (const [k, v] of result.refMap) assetRefMap.set(k, v);
    console.log(`✓ ${assetsUploaded} assets uploaded, ${assetsSkipped} already existed`);
  }

  // -------------------------------------------------------------------------
  // 3. Block defs
  // -------------------------------------------------------------------------
  const blockDefsPath = path.join(args.seedDir, 'block-defs.json');
  const blockDefs = JSON.parse(fs.readFileSync(blockDefsPath, 'utf8')) as Array<Record<string, unknown>>;
  // Append Gatewaze-native block_defs (blog-feed etc.) that aren't
  // derived from AAIF's Sanity schemas. Same shape so they go through
  // the same applier with no special handling.
  const nativeDefs = GATEWAZE_NATIVE_BLOCKS.map((def) => ({
    library_id: libraryId,
    key: def.key,
    name: def.name,
    description: def.description,
    schema: def.schema,
    has_bricks: false,
    theme_kind: 'website',
    html: def.html,
    block_kind: def.block_kind,
    freshness: def.freshness,
    audience: def.audience,
    kind_attributes: def.kind_attributes,
    component_export_path: def.component_export_path,
    source_file: '(gatewaze-native)',
    conversion_warnings: [] as ReadonlyArray<unknown>,
  }));
  const blockDefsApplied = await applyBlockDefs(supabase, libraryId, [...blockDefs, ...nativeDefs]);
  console.log(`✓ block_defs: ${blockDefsApplied.applied} applied (${nativeDefs.length} gatewaze-native), ${blockDefsApplied.skipped} unchanged`);

  // -------------------------------------------------------------------------
  // 4. Personas (build sanity tier _id → persona.id map for var. matching)
  // -------------------------------------------------------------------------
  const personasPath = path.join(args.seedDir, 'personas.json');
  const personasFile = JSON.parse(fs.readFileSync(personasPath, 'utf8')) as {
    personas: ConvertedPersona[];
    idMap: Record<string, string>;
  };
  const personaResult = await applyPersonas(supabase, siteId, personasFile.personas);
  console.log(`✓ personas: ${personaResult.applied} applied`);

  // -------------------------------------------------------------------------
  // 5. Pages
  // -------------------------------------------------------------------------
  // Build the doc-snapshot resolver from the same NDJSON used for asset
  // upload. Page blocks frequently embed
  //   { _type: 'reference', _ref: 'seed.blog.<slug>' }
  // pointers (and similar for events / podcasts / press-news / person /
  // project). At runtime there's no Sanity to resolve them, so we inline
  // each as a thin snapshot (title / slug / publishedAt / featuredImage /
  // …) the theme can render directly.
  const docSnapshotResolver = await buildDocSnapshotResolverFromExport(args.sanityExportDir);

  const pagesPath = path.join(args.seedDir, 'pages.json');
  const pages = JSON.parse(fs.readFileSync(pagesPath, 'utf8')) as ConvertedPage[];
  const pagesResult = await applyPages(supabase, {
    siteId,
    libraryId,
    pages,
    assetRefMap,
    docSnapshotResolver,
  });
  console.log(`✓ pages: ${pagesResult.applied} applied (${pagesResult.blocks} blocks, ${pagesResult.bricks} bricks, ${pagesResult.variants} variants)`);
  if (pagesResult.unresolvedAssetRefs.length > 0) {
    console.warn(`  ⚠ ${pagesResult.unresolvedAssetRefs.length} unresolved asset refs — content references missing assets`);
  }

  // -------------------------------------------------------------------------
  // 6. Blog import (cross-module: Sanity blog → Gatewaze blog_posts +
  //    blog_tags + blog_post_tags + people)
  // -------------------------------------------------------------------------
  let blogImport = { people: 0, tags: 0, posts: 0, postTags: 0, skipped: 0 };
  if (args.sanityExportDir) {
    blogImport = await importBlogsFromExport(supabase, {
      sanityExportDir: args.sanityExportDir,
      assetRefMap,
    });
    console.log(`✓ blog import: ${blogImport.people} people, ${blogImport.tags} tags, ${blogImport.posts} posts (${blogImport.postTags} tag links)`);
    if (blogImport.skipped > 0) {
      console.log(`  ⚠ ${blogImport.skipped} blogs skipped — see warnings in summary`);
    }
  }

  // -------------------------------------------------------------------------
  // 6b. Menu import (Sanity headerSettings + footerSettings →
  //     navigation_menus + navigation_menu_items)
  // -------------------------------------------------------------------------
  let menuImport = { menus: 0, items: 0 };
  if (args.sanityExportDir) {
    menuImport = await importMenusFromExport(supabase, {
      sanityExportDir: args.sanityExportDir,
      siteId,
    });
    console.log(`✓ menu import: ${menuImport.menus} menus, ${menuImport.items} items`);
  }

  // -------------------------------------------------------------------------
  // 7. embed_media_in_git flag
  // -------------------------------------------------------------------------
  if (args.embedMediaInGit) {
    await setEmbedMediaInGit(supabase, siteId, true);
    console.log(`✓ site.config.publish.embed_media_in_git = true`);
  }

  const summary: ApplySummary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    siteId,
    libraryId,
    assetsUploaded,
    assetsSkipped,
    blockDefs: blockDefsApplied,
    personas: { applied: personaResult.applied },
    pages: {
      applied: pagesResult.applied,
      blocks: pagesResult.blocks,
      bricks: pagesResult.bricks,
      variants: pagesResult.variants,
    },
    blog: blogImport,
    menu: menuImport,
    unresolvedAssetRefs: pagesResult.unresolvedAssetRefs,
    warnings,
  };
  const logPath = path.join(args.seedDir, 'apply-seed.log.json');
  fs.writeFileSync(logPath, JSON.stringify(summary, null, 2));
  console.log(`✓ summary written to ${logPath}`);
}

// ===========================================================================
// Step 1: ensure site + library
// ===========================================================================

async function ensureSiteAndLibrary(
  supabase: SupabaseClient,
  siteSlug: string,
): Promise<{ siteId: string; libraryId: string }> {
  // Look up the site
  const { data: existing, error } = await supabase
    .from('sites')
    .select('id, templates_libraries!inner(id)')
    .eq('slug', siteSlug)
    .maybeSingle();
  if (error) throw new Error(`failed to query sites: ${error.message}`);
  if (existing) {
    // PostgREST inner-join inlines the related table; the shape may be
    // an array OR a single object depending on the relation cardinality.
    const lib = Array.isArray(existing.templates_libraries)
      ? (existing.templates_libraries[0] as { id: string } | undefined)
      : (existing.templates_libraries as { id: string } | undefined);
    if (!lib) throw new Error(`site '${siteSlug}' has no templates_library attached`);
    return {
      siteId: existing.id as string,
      libraryId: lib.id,
    };
  }
  throw new Error(
    `site '${siteSlug}' not found. Create it from the Gatewaze admin first (with a templates_library attached), then re-run apply-seed.`,
  );
}

// ===========================================================================
// Step 2: upload Sanity assets
// ===========================================================================

interface AssetEntry {
  /** `image-<base>` or `file-<base>`. The assets.json map key. */
  ref: string;
  /** Just the base hash (without prefix). */
  baseHash: string;
  kind: 'image' | 'file';
  originalFilename?: string;
  size?: number;
  width?: number;
  height?: number;
}

async function uploadSanityAssets(
  supabase: SupabaseClient,
  args: { siteId: string; sanityExportDir: string; bucket: string },
): Promise<{ uploaded: number; skipped: number; refMap: Map<string, string> }> {
  const refMap = new Map<string, string>();
  let uploaded = 0;
  let skipped = 0;

  const assets = loadAssetIndex(args.sanityExportDir);
  if (assets.length === 0) {
    console.warn(`  ⚠ no assets found in ${args.sanityExportDir}`);
    return { uploaded, skipped, refMap };
  }

  // Index files on disk by base hash so we can locate each binary even
  // when the on-disk filename includes dims/ext that the metadata key
  // doesn't carry.
  const filesByHash = indexFilesByBaseHash(args.sanityExportDir);

  for (const asset of assets) {
    const fileEntry = filesByHash.get(asset.baseHash);
    if (!fileEntry) {
      console.warn(`  ⚠ asset binary not found for ${asset.ref} (no file matching ${asset.baseHash}-* in ${asset.kind}s/)`);
      continue;
    }

    const buffer = fs.readFileSync(fileEntry.absPath);
    const ext = fileEntry.ext.replace(/^\./, '');
    const safeBasename = (asset.originalFilename ?? fileEntry.basename).replace(/[^a-zA-Z0-9._-]/g, '-');
    const storagePath = `sites/${args.siteId}/media/${asset.baseHash}-${safeBasename}`;
    const mimeType = guessMimeType(ext);

    // Upload to storage (upsert)
    const { error: uploadErr } = await supabase.storage
      .from(args.bucket)
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
    if (uploadErr) {
      console.warn(`  ⚠ upload failed for ${asset.ref}: ${uploadErr.message}`);
      continue;
    }

    // Insert host_media row (or sites_media — depends on which table is the
    // active media registry; the platform uses host_media when host-media
    // module is installed, otherwise sites_media).
    const mediaRow = {
      host_kind: 'site',
      host_id: args.siteId,
      storage_path: storagePath,
      filename: safeBasename,
      mime_type: mimeType,
      bytes: buffer.length,
      in_repo: true,
      variants: null,
    };
    // host_media has no (host_kind, host_id, storage_path) unique
    // constraint, so we can't use ON CONFLICT — check by SELECT first
    // and skip if a row already exists at the same path.
    let mediaError: { message: string } | null = null;
    let mediaTableAvailable = true;
    {
      const existing = await supabase
        .from('host_media')
        .select('id')
        .eq('host_kind', 'site')
        .eq('host_id', args.siteId)
        .eq('storage_path', storagePath)
        .maybeSingle();
      if (existing.error && /relation .* does not exist/i.test(existing.error.message)) {
        mediaTableAvailable = false;
      } else if (!existing.data) {
        const res = await supabase.from('host_media').insert(mediaRow);
        mediaError = res.error as { message: string } | null;
      } else {
        skipped += 1;
      }
    }
    if (!mediaTableAvailable) {
      const res = await supabase.from('sites_media').upsert({
        site_id: args.siteId,
        storage_path: storagePath,
        filename: safeBasename,
        mime_type: mimeType,
        bytes: buffer.length,
      }, { onConflict: 'site_id,storage_path' });
      mediaError = res.error as { message: string } | null;
    }
    if (mediaError) {
      console.warn(`  ⚠ media row insert failed for ${asset.ref}: ${mediaError.message}`);
      continue;
    }

    // Register the asset under BOTH ref forms it can appear as in content:
    //   - Bare: `<base>` (assets.json key form, prefix-stripped)
    //   - Full: `<base>-<dims>-<ext>` (the form Sanity puts in document refs)
    // The rewriter strips the `image-`/`file-` prefix once before lookup,
    // and the remainder might be either form depending on the document
    // shape (`asset._ref` typically carries dims+ext for images).
    const mediaUrl = `/media/${storagePath}`;
    refMap.set(asset.baseHash, mediaUrl);
    if (asset.kind === 'image' && asset.width && asset.height) {
      refMap.set(`${asset.baseHash}-${asset.width}x${asset.height}-${ext}`, mediaUrl);
    } else if (asset.kind === 'file') {
      refMap.set(`${asset.baseHash}-${ext}`, mediaUrl);
    }
    // Also register what we can infer from the on-disk filename itself
    // (covers any mismatch between assets.json metadata and reality):
    refMap.set(fileEntry.basename.replace(/\.[^.]+$/, ''), mediaUrl);

    uploaded += 1;
  }
  return { uploaded, skipped, refMap };
}

/**
 * Load assets.json as a map keyed by `image-<base>` / `file-<base>`.
 * Falls back to reading sanity.imageAsset / sanity.fileAsset docs from
 * data.ndjson if assets.json doesn't exist (older export format).
 */
function loadAssetIndex(sanityExportDir: string): AssetEntry[] {
  const out: AssetEntry[] = [];
  const assetsPath = path.join(sanityExportDir, 'assets.json');
  if (fs.existsSync(assetsPath)) {
    const map = JSON.parse(fs.readFileSync(assetsPath, 'utf8')) as Record<string, {
      originalFilename?: string;
      size?: number;
      metadata?: { dimensions?: { width?: number; height?: number } };
    }>;
    for (const [ref, meta] of Object.entries(map)) {
      const kind: 'image' | 'file' = ref.startsWith('image-') ? 'image' : 'file';
      const baseHash = ref.replace(/^(image|file)-/, '');
      out.push({
        ref,
        baseHash,
        kind,
        ...(meta.originalFilename !== undefined ? { originalFilename: meta.originalFilename } : {}),
        ...(meta.size !== undefined ? { size: meta.size } : {}),
        ...(meta.metadata?.dimensions?.width !== undefined ? { width: meta.metadata.dimensions.width } : {}),
        ...(meta.metadata?.dimensions?.height !== undefined ? { height: meta.metadata.dimensions.height } : {}),
      });
    }
    return out;
  }
  // Fallback: scan data.ndjson for asset docs
  const ndjsonPath = path.join(sanityExportDir, 'data.ndjson');
  if (!fs.existsSync(ndjsonPath)) return [];
  const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const doc = JSON.parse(t) as Record<string, unknown>;
      if (doc._type !== 'sanity.imageAsset' && doc._type !== 'sanity.fileAsset') continue;
      const id = String(doc._id);
      const kind: 'image' | 'file' = id.startsWith('image-') ? 'image' : 'file';
      const baseHash = id.replace(/^(image|file)-/, '');
      out.push({
        ref: id,
        baseHash,
        kind,
        originalFilename: typeof doc.originalFilename === 'string' ? doc.originalFilename : undefined,
      });
    } catch {
      // ignore
    }
  }
  return out;
}

/** Index files in images/ and files/ by base-hash prefix. */
function indexFilesByBaseHash(sanityExportDir: string): Map<string, { absPath: string; basename: string; ext: string }> {
  const out = new Map<string, { absPath: string; basename: string; ext: string }>();
  for (const subdir of ['images', 'files']) {
    const dir = path.join(sanityExportDir, subdir);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const baseHash = name.split('-')[0] ?? '';
      const ext = path.extname(name);
      const absPath = path.join(dir, name);
      out.set(baseHash, { absPath, basename: name, ext });
    }
  }
  return out;
}

function guessMimeType(ext: string): string {
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4', pdf: 'application/pdf',
    bin: 'application/octet-stream',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

// ===========================================================================
// Step 3: block_defs
// ===========================================================================

async function applyBlockDefs(
  supabase: SupabaseClient,
  libraryId: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  for (const row of rows) {
    // templates_block_defs uniqueness:
    //   (library_id, key, version) — full unique
    //   (library_id, key) WHERE is_current=true — partial unique
    // The PostgREST upsert can target the (library_id, key, version)
    // unique index, so we always emit version=1 here. If a row already
    // exists at version=1 with the same key, we overwrite it.
    const insertable: Record<string, unknown> = {
      library_id: libraryId,
      key: row.key,
      name: row.name,
      description: row.description ?? null,
      schema: row.schema,
      has_bricks: row.has_bricks ?? false,
      theme_kind: row.theme_kind ?? 'website',
      html: row.html ?? '',
      version: 1,
      is_current: true,
    };
    // Optional columns for gatewaze-internal / dynamic blocks. Only
    // include when the row carries them so we don't overwrite NULL
    // defaults on rows that lack the columns (e.g. the Sanity-derived
    // static blocks).
    if (row.block_kind !== undefined) insertable.block_kind = row.block_kind;
    if (row.freshness !== undefined) insertable.freshness = row.freshness;
    if (row.audience !== undefined) insertable.audience = row.audience;
    if (row.component_export_path !== undefined) insertable.component_export_path = row.component_export_path;
    // Note: kind_attributes is not a column on this DB; static config
    // (API path etc.) is embedded in the block's content_schema instead
    // or implied by the block_def_key + component_export_path.
    const { error } = await supabase.from('templates_block_defs').upsert(insertable, {
      onConflict: 'library_id,key,version',
    });
    if (error) {
      console.warn(`  ⚠ block_def ${row.key} upsert failed: ${error.message}`);
      skipped += 1;
      continue;
    }
    applied += 1;
  }
  return { applied, skipped };
}

// ===========================================================================
// Step 4: personas
// ===========================================================================

async function applyPersonas(
  supabase: SupabaseClient,
  siteId: string,
  personas: ConvertedPersona[],
): Promise<{ applied: number }> {
  let applied = 0;
  for (const p of personas) {
    const insertable = {
      site_id: siteId,
      name: p.name,
      label: p.label,
      description: p.description,
      is_default: p.is_default,
      priority: p.priority,
      conditions: p.conditions,
    };
    const { error } = await supabase.from('site_personas').upsert(insertable, {
      onConflict: 'site_id,name',
    });
    if (error) {
      console.warn(`  ⚠ persona ${p.name} upsert failed: ${error.message}`);
      continue;
    }
    applied += 1;
  }
  return { applied };
}

// ===========================================================================
// Step 5: pages
// ===========================================================================

async function applyPages(
  supabase: SupabaseClient,
  args: {
    siteId: string;
    libraryId: string;
    pages: ConvertedPage[];
    assetRefMap: ReadonlyMap<string, string>;
    /**
     * Optional inline-snapshot resolver for `{_type:'reference', _ref:'<doc-id>'}`
     * pointers carried inside block content (e.g. WrittenContentHub
     * cards). When provided, each ref is replaced with a self-contained
     * snapshot so the published content needs no runtime Sanity lookup.
     */
    docSnapshotResolver?: DocSnapshotResolver;
  },
): Promise<{
  applied: number;
  blocks: number;
  bricks: number;
  variants: number;
  unresolvedAssetRefs: string[];
}> {
  let applied = 0;
  let blocks = 0;
  let bricks = 0;
  let variants = 0;
  const unresolved = new Set<string>();

  // Look up block_def_key → id (we set library_id+key earlier)
  const { data: blockDefs } = await supabase
    .from('templates_block_defs')
    .select('id, key')
    .eq('library_id', args.libraryId);
  const blockDefByKey = new Map(((blockDefs ?? []) as Array<{ id: string; key: string }>).map((d) => [d.key, d.id]));

  const assetMap = { byAssetId: args.assetRefMap };
  const rewriteOpts = {
    assetMap,
    ...(args.docSnapshotResolver ? { docSnapshotResolver: args.docSnapshotResolver } : {}),
  };

  for (const page of args.pages) {
    // Upsert the page row.
    const { error: pageErr } = await supabase.from('pages').upsert({
      id: page.id,
      host_kind: 'site',
      host_id: args.siteId,
      slug: page.slug,
      full_path: page.full_path,
      title: page.title,
      composition_mode: page.composition_mode,
      status: 'draft',
      templates_library_id: args.libraryId,
    }, { onConflict: 'id' });
    if (pageErr) {
      console.warn(`  ⚠ page ${page.slug} upsert failed: ${pageErr.message}`);
      continue;
    }

    // Insert blocks (with content asset-ref rewriting + doc-ref inlining).
    for (const block of page.blocks) {
      const rewrite = rewriteSanityRefsWithOptions(block.content, rewriteOpts);
      for (const u of rewrite.unresolvedAssetRefs) unresolved.add(u);
      const blockDefId = blockDefByKey.get(block.block_def_key);
      if (!blockDefId) {
        console.warn(`  ⚠ page ${page.slug}: unknown block_def_key '${block.block_def_key}'`);
        continue;
      }
      const { error: blockErr } = await supabase.from('page_blocks').upsert({
        id: block.id,
        page_id: page.id,
        block_def_id: blockDefId,
        sort_order: block.sort_order,
        variant_key: block.variant_key,
        content: rewrite.rewritten,
      }, { onConflict: 'id' });
      if (blockErr) {
        console.warn(`  ⚠ block ${block.id} upsert failed: ${blockErr.message}`);
        continue;
      }
      blocks += 1;
    }

    // Variants: rewrite the value too (variants override content; could
    // reference different assets per persona).
    for (const variant of page.variants) {
      const rewrite = rewriteSanityRefsWithOptions(variant.value, rewriteOpts);
      for (const u of rewrite.unresolvedAssetRefs) unresolved.add(u);
      const { error: varErr } = await supabase.from('page_variants').upsert({
        page_id: page.id,
        field_path: variant.field_path,
        match_context: variant.match_context,
        value: rewrite.rewritten,
        priority: variant.priority,
        persona_id: variant.persona_id,
      }, { onConflict: 'page_id,field_path,match_context' });
      if (varErr) {
        console.warn(`  ⚠ variant ${page.slug}/${variant.field_path} upsert failed: ${varErr.message}`);
        continue;
      }
      variants += 1;
    }

    bricks += page.bricks.length;
    applied += 1;
  }

  return {
    applied,
    blocks,
    bricks,
    variants,
    unresolvedAssetRefs: Array.from(unresolved),
  };
}

/**
 * Load the NDJSON export and build a `DocSnapshotResolver` over its
 * documents. When no export directory is supplied (e.g. running against
 * a previously-converted seed only), returns `undefined` and content-ref
 * inlining is skipped.
 */
async function buildDocSnapshotResolverFromExport(
  sanityExportDir: string | null,
): Promise<DocSnapshotResolver | undefined> {
  if (!sanityExportDir) return undefined;
  const ndjsonPath = path.join(sanityExportDir, 'data.ndjson');
  if (!fs.existsSync(ndjsonPath)) return undefined;
  const { docs } = await loadNdjson(ndjsonPath);
  const docList = docs as unknown as SanityDocLike[];
  const byId = indexDocsById(docList);
  console.log(`✓ doc-snapshot index: ${byId.size} docs available for inline-snapshot resolution`);
  return buildDocSnapshotResolver({ byId });
}

// ===========================================================================
// Step 6: embed_media_in_git flag
// ===========================================================================

async function setEmbedMediaInGit(
  supabase: SupabaseClient,
  siteId: string,
  enabled: boolean,
): Promise<void> {
  const { data: site, error } = await supabase
    .from('sites')
    .select('config')
    .eq('id', siteId)
    .maybeSingle();
  if (error) throw new Error(`could not read sites.config: ${error.message}`);
  const existing = ((site as { config: Record<string, unknown> | null } | null)?.config ?? {}) as Record<string, unknown>;
  const next = {
    ...existing,
    publish: {
      ...(existing.publish as Record<string, unknown> ?? {}),
      embed_media_in_git: enabled,
    },
  };
  const { error: updateErr } = await supabase.from('sites').update({ config: next }).eq('id', siteId);
  if (updateErr) throw new Error(`failed to update sites.config: ${updateErr.message}`);
}

// ===========================================================================
// Step 6: blog import (Sanity blog/blogTag/person → Gatewaze blog tables)
// ===========================================================================

async function importBlogsFromExport(
  supabase: SupabaseClient,
  args: { sanityExportDir: string; assetRefMap: ReadonlyMap<string, string> },
): Promise<{ people: number; tags: number; posts: number; postTags: number; skipped: number }> {
  // Read all relevant doc types from the export
  const ndjsonPath = path.join(args.sanityExportDir, 'data.ndjson');
  const { byType } = await loadNdjson(ndjsonPath);
  const blogs = (byType['blog'] ?? []) as unknown as SanityBlogDoc[];
  const people = (byType['person'] ?? []) as unknown as SanityPersonDoc[];
  const tags = (byType['blogTag'] ?? []) as unknown as SanityBlogTagDoc[];

  if (blogs.length === 0) {
    return { people: 0, tags: 0, posts: 0, postTags: 0, skipped: 0 };
  }

  const { bundle, warnings } = convertBlogs({
    blogs,
    people,
    tags,
    assetRefMap: args.assetRefMap,
  });
  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`  ⚠ blog import: ${w.docId} — ${w.reason}`);
  }

  // Insert in dependency order: people → tags → posts → post_tags.
  // Each step uses upserts (or insert+ignore for junctions) so the
  // command is idempotent across re-runs.
  let peopleInserted = 0;
  for (const person of bundle.people) {
    // people.email is the natural key (NOT NULL); upsert on it so re-runs
    // don't duplicate. The table doesn't have a unique constraint on email
    // by default, so we use a manual SELECT-then-INSERT pattern.
    const existing = await supabase.from('people').select('id').eq('email', person.email).maybeSingle();
    if (existing.data) continue;
    const { error } = await supabase.from('people').insert(person);
    if (error) {
      console.warn(`  ⚠ people insert failed for ${person.email}: ${error.message}`);
      continue;
    }
    peopleInserted += 1;
  }

  let tagsInserted = 0;
  for (const tag of bundle.tags) {
    const { error } = await supabase.from('blog_tags').upsert(tag, { onConflict: 'slug' });
    if (error) {
      console.warn(`  ⚠ blog_tag upsert failed for ${tag.slug}: ${error.message}`);
      continue;
    }
    tagsInserted += 1;
  }

  let postsInserted = 0;
  let postsSkipped = 0;
  for (const post of bundle.posts) {
    const { error } = await supabase.from('blog_posts').upsert(post, { onConflict: 'slug' });
    if (error) {
      console.warn(`  ⚠ blog_post upsert failed for ${post.slug}: ${error.message}`);
      postsSkipped += 1;
      continue;
    }
    postsInserted += 1;
  }

  let postTagsInserted = 0;
  for (const link of bundle.postTags) {
    const { error } = await supabase.from('blog_post_tags').upsert(link, { onConflict: 'post_id,tag_id' });
    if (error) {
      console.warn(`  ⚠ blog_post_tags upsert failed: ${error.message}`);
      continue;
    }
    postTagsInserted += 1;
  }

  return {
    people: peopleInserted,
    tags: tagsInserted,
    posts: postsInserted,
    postTags: postTagsInserted,
    skipped: postsSkipped,
  };
}

// ===========================================================================
// Step 6b: menu import (Sanity headerSettings + footerSettings →
// navigation_menus + navigation_menu_items)
// ===========================================================================

async function importMenusFromExport(
  supabase: SupabaseClient,
  args: { sanityExportDir: string; siteId: string },
): Promise<{ menus: number; items: number }> {
  const ndjsonPath = path.join(args.sanityExportDir, 'data.ndjson');
  const { byType } = await loadNdjson(ndjsonPath);

  // headerSettings/footerSettings are singleton docs — find the one
  // without the "drafts." prefix.
  const headerCandidates = (byType['headerSettings'] ?? []) as unknown as SanityHeaderSettingsDoc[];
  const footerCandidates = (byType['footerSettings'] ?? []) as unknown as SanityFooterSettingsDoc[];
  const header = headerCandidates.find((d) => !String(d._id).startsWith('drafts.')) ?? headerCandidates[0];
  const footer = footerCandidates.find((d) => !String(d._id).startsWith('drafts.')) ?? footerCandidates[0];

  if (!header && !footer) {
    return { menus: 0, items: 0 };
  }

  // Build pagePathMap so `type: 'relative'` items can resolve to page_id.
  const { data: pages } = await supabase
    .from('pages')
    .select('id, full_path')
    .eq('host_kind', 'site')
    .eq('host_id', args.siteId);
  const pagePathMap = new Map<string, string>(
    ((pages ?? []) as Array<{ id: string; full_path: string }>).map((p) => [p.full_path, p.id]),
  );

  const result = convertMenus({
    siteId: args.siteId,
    ...(header ? { header } : {}),
    ...(footer ? { footer } : {}),
    pagePathMap,
  });

  for (const w of result.warnings) {
    console.warn(`  ⚠ menu (${w.menu}/${w.key}): ${w.reason}`);
  }

  // Upsert menus first, then items. navigation_menus has UNIQUE
  // (host_kind, host_id, slug); items reference menu_id so dependency
  // order matters.
  let menusInserted = 0;
  for (const menu of result.menus) {
    const { error } = await supabase.from('navigation_menus').upsert({
      id: menu.id,
      host_kind: menu.host_kind,
      host_id: menu.site_id,
      slug: menu.slug,
      name: menu.name,
    }, { onConflict: 'host_kind,host_id,slug' });
    if (error) {
      console.warn(`  ⚠ menu '${menu.slug}' upsert failed: ${error.message}`);
      continue;
    }
    menusInserted += 1;
  }

  // Re-fetch ids in case the existing menu rows had different uuids
  // (upsert keeps the original id when conflict resolved).
  const { data: liveMenus } = await supabase
    .from('navigation_menus')
    .select('id, slug')
    .eq('host_kind', 'site')
    .eq('host_id', args.siteId);
  const liveMenuIdBySlug = new Map<string, string>(
    ((liveMenus ?? []) as Array<{ id: string; slug: string }>).map((m) => [m.slug, m.id]),
  );

  // Clear existing items for these menus before re-inserting (idempotent
  // re-runs). navigation_menu_items has no natural unique constraint
  // beyond `id`, so the simplest path is delete-then-insert.
  for (const menu of result.menus) {
    const liveId = liveMenuIdBySlug.get(menu.slug);
    if (!liveId) continue;
    await supabase.from('navigation_menu_items').delete().eq('menu_id', liveId);
  }

  // Insert items. parent_id references items we're about to insert, so
  // re-map ids using our local converter ids (we kept them stable in
  // `result.items`). Two passes:
  //   1. parents (parent_id === null)
  //   2. children
  // For each item we look up the menu's live id by slug, in case the
  // upsert returned the existing row's id rather than ours.
  const idMap = new Map<string, string>();          // converter-local → live id
  const sortedParents = result.items.filter((i) => i.parent_id === null);
  const sortedChildren = result.items.filter((i) => i.parent_id !== null);

  let itemsInserted = 0;
  for (const item of [...sortedParents, ...sortedChildren]) {
    const sourceMenu = result.menus.find((m) => m.id === item.menu_id);
    if (!sourceMenu) continue;
    const liveMenuId = liveMenuIdBySlug.get(sourceMenu.slug);
    if (!liveMenuId) continue;

    const liveId = randomUUID();
    idMap.set(item.id, liveId);
    const liveParentId = item.parent_id ? idMap.get(item.parent_id) ?? null : null;

    const { error } = await supabase.from('navigation_menu_items').insert({
      id: liveId,
      menu_id: liveMenuId,
      parent_id: liveParentId,
      order_index: item.order_index,
      label: item.label,
      page_id: item.page_id,
      external_url: item.external_url,
      anchor_target: item.anchor_target,
      open_in_new_tab: item.open_in_new_tab,
    });
    if (error) {
      console.warn(`  ⚠ menu_item '${item.label}' insert failed: ${error.message}`);
      continue;
    }
    itemsInserted += 1;
  }

  return { menus: menusInserted, items: itemsInserted };
}

// ===========================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { parseArgs, main };
