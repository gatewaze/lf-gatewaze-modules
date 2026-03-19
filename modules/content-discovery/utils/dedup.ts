/**
 * Cross-Platform Content Deduplication Utilities
 *
 * Handles detecting and managing duplicate content across platforms:
 * - Fuzzy title matching (trigram similarity via pg_trgm)
 * - Duration-based matching for audio/video content
 * - Canonical URL detection from HTML <link rel="canonical">
 * - Content type preference: video > podcast > article
 *
 * The general strategy:
 * 1. During triage: quick check for obvious duplicates (same title + author)
 * 2. During processing: thorough check with canonical URL extraction
 * 3. Post-processing: if the new item is the canonical source, promote it
 */

import { supabase } from '@/lib/supabase';

// ============================================================================
// Types
// ============================================================================

export interface DedupCandidate {
  item_id: string;
  item_url: string;
  item_title: string;
  item_content_type: string;
  item_source_type: string;
  item_author: string | null;
  item_duration_seconds: number | null;
  title_similarity: number;
}

export interface DedupResult {
  isDuplicate: boolean;
  canonicalItemId?: string;
  duplicateItemId?: string;
  relationshipType: 'cross_platform' | 'canonical' | 'syndicated' | 'derivative';
  matchMethod: 'fuzzy_title' | 'canonical_link' | 'exact_url' | 'fingerprint';
  confidenceScore: number;
  matchDetails: Record<string, any>;
}

// ============================================================================
// Content type preference — higher number = preferred as canonical
// ============================================================================

const CONTENT_TYPE_PREFERENCE: Record<string, number> = {
  video: 10,
  talk: 9,
  podcast: 5,
  article: 3,
  tutorial: 3,
  documentation: 2,
  repo: 1,
  image: 0,
};

// ============================================================================
// Core dedup functions
// ============================================================================

/**
 * Find potential duplicates for content being processed.
 * Uses the database RPC for trigram title matching + duration tolerance.
 */
export async function findDuplicates(
  title: string,
  author?: string | null,
  durationSeconds?: number | null,
  excludeItemId?: string
): Promise<DedupCandidate[]> {
  const { data, error } = await supabase.rpc('content_find_duplicates', {
    p_title: title,
    p_author: author || null,
    p_duration_seconds: durationSeconds || null,
    p_exclude_item_id: excludeItemId || null,
  });

  if (error) {
    console.error('[dedup] Failed to find duplicates:', error);
    return [];
  }

  return (data || []) as DedupCandidate[];
}

/**
 * Check if a piece of content is a duplicate and determine which should be canonical.
 *
 * Returns a DedupResult if a match is found, or null if no duplicate detected.
 */
export async function checkForDuplicate(
  title: string,
  contentType: string,
  sourceType: string,
  author?: string | null,
  durationSeconds?: number | null,
  canonicalUrl?: string | null,
  excludeItemId?: string
): Promise<DedupResult | null> {
  // 1. Check canonical URL match first (strongest signal)
  if (canonicalUrl) {
    const canonicalMatch = await findByCanonicalUrl(canonicalUrl, excludeItemId);
    if (canonicalMatch) {
      return {
        isDuplicate: true,
        canonicalItemId: canonicalMatch.id,
        relationshipType: 'canonical',
        matchMethod: 'canonical_link',
        confidenceScore: 1.0,
        matchDetails: { canonical_url: canonicalUrl },
      };
    }

    // Check if the canonical URL is an existing item's URL
    const urlMatch = await findByExactUrl(canonicalUrl, excludeItemId);
    if (urlMatch) {
      return {
        isDuplicate: true,
        canonicalItemId: urlMatch.id,
        relationshipType: 'canonical',
        matchMethod: 'canonical_link',
        confidenceScore: 1.0,
        matchDetails: { canonical_url: canonicalUrl, matched_on: 'url' },
      };
    }
  }

  // 2. Fuzzy title + duration matching
  const candidates = await findDuplicates(title, author, durationSeconds, excludeItemId);

  if (candidates.length === 0) return null;

  // Score each candidate
  const scored = candidates.map((c) => {
    let score = c.title_similarity;

    // Boost if author matches
    if (author && c.item_author) {
      const authorSim = normalizedSimilarity(author, c.item_author);
      if (authorSim > 0.7) score = Math.min(1, score + 0.15);
    }

    // Boost if duration is close (for audio/video)
    if (durationSeconds && c.item_duration_seconds) {
      const durationDiff = Math.abs(durationSeconds - c.item_duration_seconds);
      const durationPct = durationDiff / durationSeconds;
      if (durationPct < 0.05) score = Math.min(1, score + 0.2);
      else if (durationPct < 0.1) score = Math.min(1, score + 0.1);
    }

    return { candidate: c, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];

  // Only consider it a duplicate if confidence is high enough
  if (best.score < 0.6) return null;

  // Determine which should be canonical based on content type preference
  const newPref = CONTENT_TYPE_PREFERENCE[contentType] ?? 0;
  const existingPref = CONTENT_TYPE_PREFERENCE[best.candidate.item_content_type] ?? 0;

  // The existing item is canonical if it has higher or equal preference
  const existingIsCanonical = existingPref >= newPref;

  return {
    isDuplicate: true,
    canonicalItemId: existingIsCanonical ? best.candidate.item_id : undefined,
    duplicateItemId: existingIsCanonical ? undefined : best.candidate.item_id,
    relationshipType: 'cross_platform',
    matchMethod: 'fuzzy_title',
    confidenceScore: best.score,
    matchDetails: {
      title_similarity: best.candidate.title_similarity,
      matched_title: best.candidate.item_title,
      matched_type: best.candidate.item_content_type,
      matched_source: best.candidate.item_source_type,
      preference_decision: existingIsCanonical ? 'existing_preferred' : 'new_preferred',
    },
  };
}

/**
 * Record a duplicate relationship in the database.
 */
export async function recordDuplicate(
  canonicalItemId: string,
  duplicateItemId: string,
  result: DedupResult
): Promise<void> {
  const { error } = await supabase
    .from('content_duplicates')
    .upsert({
      canonical_item_id: canonicalItemId,
      duplicate_item_id: duplicateItemId,
      relationship_type: result.relationshipType,
      match_method: result.matchMethod,
      confidence_score: result.confidenceScore,
      match_details: result.matchDetails,
    }, {
      onConflict: 'canonical_item_id,duplicate_item_id',
    });

  if (error) {
    console.error('[dedup] Failed to record duplicate:', error);
  }
}

/**
 * When we discover the original/canonical source of content we already have,
 * promote it to be the canonical version.
 */
export async function promoteToCanonical(
  newCanonicalId: string,
  oldCanonicalId: string
): Promise<void> {
  const { error } = await supabase.rpc('content_promote_to_canonical', {
    p_new_canonical_id: newCanonicalId,
    p_old_canonical_id: oldCanonicalId,
  });

  if (error) {
    console.error('[dedup] Failed to promote to canonical:', error);
  }
}

// ============================================================================
// Canonical URL extraction
// ============================================================================

/**
 * Extract the canonical URL from an HTML page.
 * Looks for <link rel="canonical" href="..."> in the HTML.
 */
export function extractCanonicalUrl(html: string): string | null {
  // Match <link rel="canonical" href="..."> in any order of attributes
  const canonicalMatch = html.match(
    /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i
  ) || html.match(
    /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i
  );

  if (canonicalMatch?.[1]) {
    return canonicalMatch[1];
  }

  // Also check Open Graph url as a fallback
  const ogMatch = html.match(
    /<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["'][^>]*>/i
  ) || html.match(
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:url["'][^>]*>/i
  );

  return ogMatch?.[1] || null;
}

/**
 * Extract published/updated dates from HTML meta tags.
 */
export function extractDates(html: string): {
  publishedAt: string | null;
  updatedAt: string | null;
} {
  const published = extractMetaContent(html, [
    'article:published_time',
    'datePublished',
    'date',
    'DC.date.issued',
    'sailthru.date',
  ]);

  const updated = extractMetaContent(html, [
    'article:modified_time',
    'dateModified',
    'DC.date.modified',
    'last-modified',
  ]);

  return {
    publishedAt: published,
    updatedAt: updated,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function extractMetaContent(html: string, properties: string[]): string | null {
  for (const prop of properties) {
    // Try property="" format (OpenGraph style)
    const propMatch = html.match(
      new RegExp(`<meta[^>]*(?:property|name)=["']${escapeRegex(prop)}["'][^>]*content=["']([^"']+)["']`, 'i')
    ) || html.match(
      new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escapeRegex(prop)}["']`, 'i')
    );
    if (propMatch?.[1]) return propMatch[1];
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Simple normalized string similarity (Dice coefficient).
 * Used for quick author name comparison without hitting the DB.
 */
function normalizedSimilarity(a: string, b: string): number {
  const sa = a.toLowerCase().trim();
  const sb = b.toLowerCase().trim();
  if (sa === sb) return 1;
  if (sa.length < 2 || sb.length < 2) return 0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < sa.length - 1; i++) bigramsA.add(sa.slice(i, i + 2));

  const bigramsB = new Set<string>();
  for (let i = 0; i < sb.length - 1; i++) bigramsB.add(sb.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

async function findByCanonicalUrl(
  canonicalUrl: string,
  excludeItemId?: string
): Promise<{ id: string } | null> {
  let query = supabase
    .from('content_items')
    .select('id')
    .eq('canonical_url', canonicalUrl);

  if (excludeItemId) query = query.neq('id', excludeItemId);

  const { data } = await query.maybeSingle();
  return data;
}

async function findByExactUrl(
  url: string,
  excludeItemId?: string
): Promise<{ id: string } | null> {
  let query = supabase
    .from('content_items')
    .select('id')
    .eq('url', url);

  if (excludeItemId) query = query.neq('id', excludeItemId);

  const { data } = await query.maybeSingle();
  return data;
}
