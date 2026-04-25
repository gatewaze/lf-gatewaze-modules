/**
 * AAIF members scraper.
 *
 * Fetches https://aaif.io/members/ (server-rendered HTML), parses tier
 * sections, upserts member_organizations rows, downloads each logo to the
 * `media` bucket at `member-logos/<slug>.<ext>`, deactivates members no
 * longer present on the page.
 */

import { createClient } from '@supabase/supabase-js';

const STORAGE_BUCKET = 'media';
const LOGO_PREFIX = 'member-logos';

let _supabase = null;
function supabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[membership] SUPABASE env required');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function inferExt(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i);
    return (m ? m[1] : 'png').toLowerCase();
  } catch { return 'png'; }
}

/**
 * Map a tier heading (e.g. "Gold Members", "Platinum") to a canonical
 * tier key matching membership_tier_ranks.tier.
 */
function canonicalTier(heading) {
  const h = (heading || '').toLowerCase();
  if (h.includes('platinum')) return 'platinum';
  if (h.includes('gold')) return 'gold';
  if (h.includes('silver')) return 'silver';
  if (h.includes('associate')) return 'associate';
  return null;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      // Some sites block default fetch UA — mimic a normal browser.
      'User-Agent': 'Mozilla/5.0 (compatible; GatewazeMemberScraper/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`AAIF fetch ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Walk the page using regex (no DOM library — keeps the module
 * dependency-free against the API container's package.json).
 *
 * Strategy:
 *   1. Find heading positions for each tier word (Platinum/Gold/Silver/Associate).
 *   2. For each <a ...><img alt="..." src="..."></a> in the document, match it
 *      to whichever tier heading it appears AFTER but BEFORE the next.
 *   3. Dedupe by company name within a tier.
 *
 * AAIF's page wraps each member as <a href="..."><img src="..." alt="Name"></a>
 * — straightforward to extract.
 */
function parseMembersHtml(html, baseUrl) {
  // Find tier marker positions (start index of each tier heading).
  const tierMarkers = [];
  const tierRegex = /(platinum|gold|silver|associate)\s+members?/gi;
  let mm;
  while ((mm = tierRegex.exec(html)) !== null) {
    const tier = canonicalTier(mm[0]);
    if (tier) tierMarkers.push({ tier, index: mm.index });
  }
  // De-duplicate consecutive same-tier markers (multiple "Gold Members" headings).
  const uniqueMarkers = tierMarkers.filter((m, i, arr) =>
    i === 0 || arr[i - 1].tier !== m.tier);
  if (uniqueMarkers.length === 0) return {};

  // For each anchor with a nested img, identify which tier section it falls in.
  const tiers = {};
  const anchorRegex = /<a\b([^>]*?)>\s*<img\b([^>]*?)>\s*<\/a>/gi;
  let am;
  while ((am = anchorRegex.exec(html)) !== null) {
    const anchorAttrs = am[1] || '';
    const imgAttrs = am[2] || '';
    const idx = am.index;

    // Locate the latest tier marker before this anchor.
    let activeTier = null;
    for (const marker of uniqueMarkers) {
      if (marker.index <= idx) activeTier = marker.tier;
      else break;
    }
    if (!activeTier) continue;

    const href = (anchorAttrs.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    const imgSrc = (imgAttrs.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1]
                || (imgAttrs.match(/data-src\s*=\s*["']([^"']+)["']/i) || [])[1];
    const name = ((imgAttrs.match(/alt\s*=\s*["']([^"']+)["']/i) || [])[1]
                || (anchorAttrs.match(/title\s*=\s*["']([^"']+)["']/i) || [])[1]
                || '').trim();

    if (!href || !imgSrc || !name) continue;

    const website = (() => {
      try { return new URL(href, baseUrl).toString(); } catch { return null; }
    })();
    const logoUrl = (() => {
      try { return new URL(imgSrc, baseUrl).toString(); } catch { return null; }
    })();
    if (!website || !logoUrl) continue;

    tiers[activeTier] ??= [];
    if (!tiers[activeTier].some(m => m.name === name)) {
      tiers[activeTier].push({ name, website, logoUrl });
    }
  }

  return tiers;
}

async function uploadLogo(sb, slug, sourceUrl) {
  const res = await fetch(sourceUrl, {
    headers: { 'User-Agent': 'GatewazeMemberScraper/1.0' },
  });
  if (!res.ok) throw new Error(`logo fetch ${res.status} ${sourceUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = inferExt(sourceUrl);
  const path = `${LOGO_PREFIX}/${slug}.${ext}`;
  const contentType = res.headers.get('content-type') || `image/${ext}`;

  const { error } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(path, buf, { contentType, upsert: true });
  if (error) throw new Error(`storage upload ${error.message}`);

  const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return pub.publicUrl;
}

/**
 * Run the AAIF sync end-to-end. Returns counts.
 */
export async function runAaifSync({ sourceUrl = 'https://aaif.io/members/' } = {}) {
  const sb = supabase();

  // Create a sync_run row.
  const { data: runRow, error: runErr } = await sb
    .from('membership_sync_runs')
    .insert({ source_url: sourceUrl, status: 'running', started_at: new Date().toISOString() })
    .select().single();
  if (runErr) throw new Error(`sync_run insert: ${runErr.message}`);

  let seen = 0, inserted = 0, updated = 0, deactivated = 0, logos = 0;

  try {
    const html = await fetchPage(sourceUrl);
    const tiers = parseMembersHtml(html, sourceUrl);

    // Look up tier_rank values once.
    const { data: tierRows } = await sb.from('membership_tier_ranks').select('tier, rank');
    const rankByTier = new Map((tierRows ?? []).map(r => [r.tier, r.rank]));

    // Track which slugs we saw this run so we can deactivate the rest.
    const seenSlugs = new Set();
    const now = new Date().toISOString();

    for (const [tier, members] of Object.entries(tiers)) {
      const rank = rankByTier.get(tier) ?? 0;
      for (const m of members) {
        seen++;
        const slug = slugify(m.name);
        seenSlugs.add(slug);

        // Existing row?
        const { data: existing } = await sb
          .from('member_organizations')
          .select('id, logo_source_url, logo_url, tier, tier_rank, name, website_url')
          .eq('slug', slug).maybeSingle();

        // Logo: only re-fetch if changed or missing.
        let logoPublicUrl = existing?.logo_url ?? null;
        if (existing?.logo_source_url !== m.logoUrl) {
          try {
            logoPublicUrl = await uploadLogo(sb, slug, m.logoUrl);
            logos++;
          } catch (e) {
            console.warn(`[membership] logo upload failed for ${slug}: ${e.message}`);
          }
        }

        const payload = {
          name: m.name,
          slug,
          website_url: m.website,
          tier,
          tier_rank: rank,
          logo_source_url: m.logoUrl,
          logo_url: logoPublicUrl,
          logo_synced_at: logoPublicUrl ? now : null,
          source_url: sourceUrl,
          last_synced_at: now,
          is_active: true,
        };

        if (existing) {
          const { error: upErr } = await sb
            .from('member_organizations').update(payload).eq('id', existing.id);
          if (upErr) throw new Error(`update ${slug}: ${upErr.message}`);
          updated++;
        } else {
          const { error: insErr } = await sb
            .from('member_organizations').insert(payload);
          if (insErr) throw new Error(`insert ${slug}: ${insErr.message}`);
          inserted++;
        }
      }
    }

    // Deactivate members no longer on the page (don't delete — preserves
    // historical audit, but the sync trigger flips their rule is_active=false
    // so matched items lose their member tag on next eval). Diff client-side
    // to dodge supabase-js's awkward NOT-IN-array filter syntax.
    if (seenSlugs.size > 0) {
      const { data: existing } = await sb
        .from('member_organizations')
        .select('id, slug')
        .eq('is_active', true);
      for (const row of (existing ?? [])) {
        if (seenSlugs.has(row.slug)) continue;
        const { error: deactErr } = await sb
          .from('member_organizations')
          .update({ is_active: false, last_synced_at: now })
          .eq('id', row.id);
        if (!deactErr) deactivated++;
      }
    }

    await sb.from('membership_sync_runs').update({
      status: 'complete',
      members_seen: seen,
      members_inserted: inserted,
      members_updated: updated,
      members_deactivated: deactivated,
      logos_downloaded: logos,
      finished_at: new Date().toISOString(),
    }).eq('id', runRow.id);

    return {
      run_id: runRow.id,
      seen, inserted, updated, deactivated, logos,
    };
  } catch (e) {
    await sb.from('membership_sync_runs').update({
      status: 'failed',
      error_message: String(e?.message ?? e).slice(0, 1000),
      finished_at: new Date().toISOString(),
      members_seen: seen,
      members_inserted: inserted,
      members_updated: updated,
      members_deactivated: deactivated,
      logos_downloaded: logos,
    }).eq('id', runRow.id);
    throw e;
  }
}
