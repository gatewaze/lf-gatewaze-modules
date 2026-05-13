/**
 * End-to-end smoke test: parse the real AAIF hero.ts file from disk →
 * convert to JSON Schema → assert the output has the expected shape.
 *
 * The test is skipped automatically when the agency repo isn't checked
 * out locally — same vitest run can pass in environments without it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSanitySchemaFile } from '../lib/parse-sanity-schema.js';
import { sanitySchemaToJsonSchema } from '../lib/sanity-to-json-schema.js';

const AAIF_REPO = '/Users/dan/Git/gatewaze/aaif-internal';
const HERO_PATH = path.join(AAIF_REPO, 'studio/src/schemas/objects/blocks/hero.ts');

const hasHero = fs.existsSync(HERO_PATH);
const conditionalDescribe = hasHero ? describe : describe.skip;

conditionalDescribe('AAIF hero.ts end-to-end', () => {
  it('parses + converts the real hero schema', () => {
    const { schema: parsed, warnings: parseWarnings } = parseSanitySchemaFile(HERO_PATH, {
      // The hero file spreads `...visibilityFields`. We don't resolve the
      // cross-file import in this smoke test — it shows up as a warning.
      // The block_defs orchestrator (next phase) will pre-resolve it.
    });

    expect(parsed.name).toBe('hero');
    expect(parsed.title).toBe('Hero');
    expect(parsed.type).toBe('object');
    expect(parsed.groups?.map((g) => g.name).sort()).toEqual(['content', 'media', 'options']);

    // Fields we expect to see — names are stable.
    const fieldNames = parsed.fields.map((f) => f.name);
    expect(fieldNames).toContain('backgroundMedia');
    expect(fieldNames).toContain('heading');
    expect(fieldNames).toContain('emphasis');
    expect(fieldNames).toContain('emphasisMobile');
    expect(fieldNames).toContain('description');

    // Convert to JSON Schema.
    const { schema: jsonSchema, warnings: convertWarnings } = sanitySchemaToJsonSchema(parsed);
    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.title).toBe('Hero');
    expect(jsonSchema.properties).toBeDefined();
    expect(jsonSchema.properties?.heading).toBeDefined();
    expect(jsonSchema.properties?.description).toMatchObject({ type: 'string', format: 'richtext' });

    // Conversion warnings only complain about unresolved spread + the
    // FlatObjectField component reference — neither is fatal.
    // (Parse warnings for the spread; convert warnings for any types we
    // punted on.)
    expect(parseWarnings.some((w) => w.reason.includes('visibilityFields'))).toBe(true);
    // Don't pin the convertWarnings count — schema can evolve. Just make
    // sure the conversion didn't crash.
    expect(convertWarnings).toBeDefined();
  });
});
