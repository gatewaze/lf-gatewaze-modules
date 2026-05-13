#!/usr/bin/env tsx
/**
 * Convert tierDefinition docs from a Sanity dataset export into a
 * site_personas seed file.
 *
 * Usage:
 *   pnpm convert:tier-defs \
 *     --export=/path/to/export.ndjson \
 *     --site-id=<uuid> \
 *     --out=./seed
 *
 * Output:
 *   seed/personas.json    — { personas: ConvertedPersona[], idMap: { sanityId: personaName } }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadNdjson } from '../lib/load-ndjson.js';
import { convertTierDefs, type SanityTierDoc } from '../lib/convert-tier-defs.js';

interface CliArgs {
  exportPath: string;
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
  if (!args['site-id']) throw new Error('Missing --site-id=<uuid>');
  return {
    exportPath: args.export,
    siteId: args['site-id'],
    outDir: args.out ?? path.join(process.cwd(), 'seed'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { byType, totalDocs } = await loadNdjson(args.exportPath);
  const tierDocs = (byType['tierDefinition'] ?? []) as unknown as SanityTierDoc[];
  console.log(`✓ Loaded ${totalDocs} docs from ${path.basename(args.exportPath)} (${tierDocs.length} tierDefinitions)`);

  const result = convertTierDefs({ siteId: args.siteId, tiers: tierDocs });

  fs.mkdirSync(args.outDir, { recursive: true });
  const outPath = path.join(args.outDir, 'personas.json');
  fs.writeFileSync(outPath, JSON.stringify({
    personas: result.personas,
    idMap: result.idMap,
  }, null, 2));

  console.log(`✓ Wrote ${result.personas.length} personas to ${outPath}`);
  if (result.warnings.length > 0) {
    console.log(`  warnings:`);
    for (const w of result.warnings) {
      console.log(`    - ${w.tierId}: ${w.reason}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
