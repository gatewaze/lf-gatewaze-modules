#!/usr/bin/env tsx
/**
 * Convert AAIF page documents from a Sanity dataset export into
 * Gatewaze page_blocks + page_variants seed.
 *
 * Reads:
 *   - The NDJSON export (--export)
 *   - The previously-generated personas.json (--personas) to resolve
 *     tierDefinition refs in visibleTo / personalizedVariant.tiers
 *
 * Usage:
 *   pnpm convert:page-content \
 *     --export=/path/to/export.ndjson \
 *     --personas=./seed/personas.json \
 *     --site-id=<uuid> \
 *     --out=./seed
 *
 * Output:
 *   seed/pages.json    — ConvertedPage[]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadNdjson } from '../lib/load-ndjson.js';
import { convertPageContent, type SanityPageDoc } from '../lib/convert-page-content.js';
import type { SanityTierDoc } from '../lib/convert-tier-defs.js';
import type { ConvertedPersona } from '../lib/seed-types.js';

interface CliArgs {
  exportPath: string;
  personasPath: string;
  siteId: string;
  outDir: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: Record<string, string> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  if (!args.export) throw new Error('Missing --export=<path to NDJSON>');
  if (!args.personas) throw new Error('Missing --personas=<path to personas.json>');
  if (!args['site-id']) throw new Error('Missing --site-id=<uuid>');
  return {
    exportPath: args.export,
    personasPath: args.personas,
    siteId: args['site-id'],
    outDir: args.out ?? path.join(process.cwd(), 'seed'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const personasFile = JSON.parse(fs.readFileSync(args.personasPath, 'utf8')) as {
    personas: ConvertedPersona[];
    idMap: Record<string, string>;
  };
  const allPersonaNames = personasFile.personas.map((p) => p.name);

  const { byType, totalDocs } = await loadNdjson(args.exportPath);
  const pageDocs = (byType['page'] ?? []) as unknown as SanityPageDoc[];
  const tierDocs = (byType['tierDefinition'] ?? []) as unknown as SanityTierDoc[];
  // Sanity allows multiple default-flagged tiers but Gatewaze enforces
  // one per site. Pick the first — convertTierDefs has already surfaced
  // a warning if there were several.
  const defaultTier = tierDocs.find((t) => t.isDefault === true);
  console.log(`✓ Loaded ${totalDocs} docs (${pageDocs.length} pages, ${tierDocs.length} tiers, default=${defaultTier?._id ?? '<none>'})`);
  console.log(`  resolving against ${allPersonaNames.length} personas: ${allPersonaNames.join(', ')}`);

  const results = pageDocs.map((doc) => {
    const slug = doc.baseSlug?.current ?? doc.slug?.current ?? doc._id;
    const fullPath = slug === 'home' || slug === 'index' ? '/' : `/${slug}`;
    return convertPageContent({
      siteId: args.siteId,
      personaIdMap: personasFile.idMap,
      allPersonaNames,
      pageDoc: doc,
      fullPath,
      ...(defaultTier ? { defaultTierId: defaultTier._id } : {}),
    });
  });

  fs.mkdirSync(args.outDir, { recursive: true });
  const outPath = path.join(args.outDir, 'pages.json');
  fs.writeFileSync(outPath, JSON.stringify(results.map((r) => r.page), null, 2));

  let totalBlocks = 0;
  let totalVariants = 0;
  let totalWarnings = 0;
  for (const r of results) {
    totalBlocks += r.page.blocks.length;
    totalVariants += r.page.variants.length;
    totalWarnings += r.warnings.length;
  }

  console.log(`✓ Wrote ${results.length} pages (${totalBlocks} blocks, ${totalVariants} variants) to ${outPath}`);
  if (totalWarnings > 0) {
    console.log(`  ${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}:`);
    for (const r of results) {
      for (const w of r.warnings) {
        console.log(`    - ${r.page.slug} ${w.entryKey}: ${w.reason}`);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
