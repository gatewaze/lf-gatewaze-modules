#!/usr/bin/env tsx
/**
 * Convert AAIF Sanity block schemas → Gatewaze templates_block_defs seed.
 *
 * Reads every `.ts` file under `<aaif>/studio/src/schemas/objects/blocks/`,
 * parses each via ts-morph, converts to JSON Schema, and writes a single
 * `seed/block-defs.json` containing one row per block_def. The
 * `apply-seed.ts` script reads this file and INSERTs into Supabase.
 *
 * Usage:
 *   pnpm convert:block-defs --aaif=/path/to/aaif-internal --out=./seed
 *
 * Output (block-defs.json shape):
 *   [
 *     {
 *       library_id: <stable uuid; same per run>,
 *       key: 'hero',
 *       name: 'Hero',
 *       schema: { ...JSON Schema },
 *       has_bricks: false,
 *       theme_kind: 'website',
 *       html: '',                  // placeholder; see convert-block-html.ts (later)
 *       is_current: true,
 *       source_file: 'objects/blocks/hero.ts',
 *       conversion_warnings: [...] // diagnostic
 *     },
 *     ...
 *   ]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSanitySchemaFile } from '../lib/parse-sanity-schema.js';
import { sanitySchemaToJsonSchema } from '../lib/sanity-to-json-schema.js';
import type { ParsedSanityField } from '../lib/sanity-types.js';

interface CliArgs {
  aaifRepo: string;
  outDir: string;
  libraryId: string;
}

interface SeedRow {
  library_id: string;
  key: string;
  name: string;
  description: string | null;
  schema: ReturnType<typeof sanitySchemaToJsonSchema>['schema'];
  has_bricks: boolean;
  theme_kind: 'website' | 'email';
  html: string;
  is_current: true;
  source_file: string;
  conversion_warnings: ReadonlyArray<{ fieldPath: string; reason: string }>;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: Record<string, string> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]!] = m[2]!;
  }
  if (!args.aaif) throw new Error('Missing --aaif=<path to aaif-internal>');
  return {
    aaifRepo: args.aaif,
    outDir: args.out ?? path.join(process.cwd(), 'seed'),
    libraryId: args['library-id'] ?? '00000000-aaaa-aaaa-aaaa-000000000001',
  };
}

/**
 * Pre-resolve the agency's shared field-sets so spreads like
 * `...visibilityFields` get inlined rather than warned. We could parse
 * the originals too — for now we declare the AAIF-known set inline.
 */
const KNOWN_FIELD_SETS: Record<string, ParsedSanityField[]> = {
  visibilityFields: [
    {
      name: 'visibleTo',
      type: 'array',
      title: 'Visible to',
      description: 'Tiers that see this block. Empty = all tiers.',
      of: [{ type: 'reference', to: ['tierDefinition'] }],
    },
  ],
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const blocksDir = path.join(args.aaifRepo, 'studio/src/schemas/objects/blocks');
  if (!fs.existsSync(blocksDir)) {
    throw new Error(`AAIF blocks dir not found: ${blocksDir}`);
  }

  const files = fs.readdirSync(blocksDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('index'))
    .map((f) => path.join(blocksDir, f))
    .sort();

  const rows: SeedRow[] = [];
  let totalWarnings = 0;

  for (const file of files) {
    const rel = path.relative(args.aaifRepo, file);
    try {
      const { schema: parsed, warnings: parseWarnings } = parseSanitySchemaFile(file, {
        knownFieldSets: KNOWN_FIELD_SETS,
      });
      const { schema, warnings: convertWarnings } = sanitySchemaToJsonSchema(parsed);

      const allWarnings = [
        ...parseWarnings.map((w) => ({ fieldPath: w.location, reason: `parse: ${w.reason}` })),
        ...convertWarnings.map((w) => ({ fieldPath: w.fieldPath, reason: `convert: ${w.reason}` })),
      ];
      totalWarnings += allWarnings.length;

      rows.push({
        library_id: args.libraryId,
        key: parsed.name,
        name: parsed.title ?? parsed.name,
        description: null,
        schema,
        has_bricks: false,
        theme_kind: 'website',
        // Canvas-preview Mustache is deferred — themes render via the
        // agency's Next.js components at runtime. The editor sidebar
        // form-driven UI works without a preview template.
        html: '',
        is_current: true,
        source_file: rel,
        conversion_warnings: allWarnings,
      });
    } catch (err) {
      console.error(`✗ ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const outPath = path.join(args.outDir, 'block-defs.json');
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));

  console.log(`✓ Wrote ${rows.length} block_defs to ${outPath}`);
  console.log(`  total conversion warnings: ${totalWarnings}`);
  for (const row of rows) {
    const wc = row.conversion_warnings.length;
    console.log(`    - ${row.key.padEnd(28)} ${wc === 0 ? '✓ clean' : `${wc} warning${wc === 1 ? '' : 's'}`}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { parseArgs, KNOWN_FIELD_SETS };
