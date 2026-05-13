/**
 * Read a Sanity dataset export (.ndjson, one JSON document per line) and
 * group documents by `_type`.
 *
 * Sanity's export format: `sanity dataset export production export.ndjson`
 * produces a newline-delimited JSON file with one record per line. Each
 * record is a complete document; references appear as `{_type, _ref, _key}`
 * objects rather than embedded.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

export interface NdjsonLoadResult {
  byType: Record<string, Array<Record<string, unknown>>>;
  /** Flat list of every doc in NDJSON order — useful for building cross-type indexes. */
  docs: Array<Record<string, unknown>>;
  totalDocs: number;
}

export async function loadNdjson(filePath: string): Promise<NdjsonLoadResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`NDJSON file not found: ${filePath}`);
  }
  const byType: Record<string, Array<Record<string, unknown>>> = {};
  const docs: Array<Record<string, unknown>> = [];
  let totalDocs = 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`malformed NDJSON line (doc ${totalDocs}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const type = typeof doc._type === 'string' ? doc._type : 'unknown';
    if (!byType[type]) byType[type] = [];
    byType[type].push(doc);
    docs.push(doc);
    totalDocs += 1;
  }

  return { byType, docs, totalDocs };
}
