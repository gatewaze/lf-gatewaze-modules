/**
 * Convert AAIF Sanity blog documents → Gatewaze native blog_posts +
 * blog_tags + blog_post_tags + people rows.
 *
 * Per the user direction "import Sanity blog into Gatewaze blog module
 * so the AAIF Next.js can fetch blogs from Gatewaze instead of Sanity"
 * (Phase 1 of the cross-module import).
 *
 * Output is a `ConvertedBlogBundle` containing every row the applier
 * needs to insert, in dependency order:
 *   1. authors (people rows)  — referenced by blog_posts.author_id
 *   2. tags    (blog_tags)    — referenced by blog_post_tags
 *   3. blogs   (blog_posts)
 *   4. links   (blog_post_tags junction)
 *
 * Out of scope for this pass:
 *   - blog_categories: Sanity allows multi-category per post, but
 *     blog_posts has a single category_id. We surface the first category
 *     as a TODO warning and DO NOT import categories yet — the
 *     applier can prompt for a schema extension when needed.
 *   - Portable text → rich content: Sanity stores `content` as an array
 *     of typed blocks. blog_posts.content is plain text. We flatten the
 *     portableText to plain text for v1 (lossy) and note the loss as a
 *     warning. Future work: emit HTML or markdown.
 */

import { randomUUID } from 'node:crypto';

export interface SanityBlogDoc {
  _id: string;
  _type: 'blog';
  title?: string;
  baseSlug?: { current?: string };
  slug?: { current?: string };
  summary?: string;
  publishedAt?: string;
  featured?: boolean;
  author?: { _ref: string; _type: 'reference' };
  categories?: ReadonlyArray<{ _ref: string; _type: 'reference' }>;
  tags?: ReadonlyArray<{ _ref: string; _type: 'reference' }>;
  thumbnail?: unknown;
  content?: ReadonlyArray<SanityPortableTextBlock>;
  seo?: {
    metaTitle?: string;
    metaDescription?: string;
    canonicalUrl?: string;
    noIndex?: boolean;
    ogImage?: unknown;
  };
}

export interface SanityPortableTextBlock {
  _type: 'block' | string;
  _key?: string;
  style?: string;
  children?: ReadonlyArray<{ _type: string; text?: string; marks?: string[] }>;
  markDefs?: unknown[];
}

export interface SanityPersonDoc {
  _id: string;
  _type: 'person';
  name?: string;
  summary?: string;
  designation?: string;
  companyName?: string;
  bio?: string;
  headshot?: unknown;
  otherInfo?: {
    twitter?: string;
    linkedin?: string;
    github?: string;
    website?: string;
    email?: string;
  };
}

export interface SanityBlogTagDoc {
  _id: string;
  _type: 'blogTag';
  title?: string;
  slug?: { current?: string };
  description?: string;
}

export interface ConvertedPersonRow {
  id: string;
  email: string;
  avatar_url: string | null;
  is_guest: true;
  attributes: Record<string, unknown>;
}

export interface ConvertedBlogTagRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface ConvertedBlogPostRow {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  content: string;
  featured_image: string | null;
  featured_image_alt: string | null;
  published_at: string | null;
  status: 'draft' | 'published' | 'archived';
  is_featured: boolean;
  meta_title: string | null;
  meta_description: string | null;
  canonical_url: string | null;
  og_image: string | null;
  author_id: string;
  category_id: string | null;
}

export interface ConvertedBlogPostTagRow {
  post_id: string;
  tag_id: string;
}

export interface ConvertedBlogBundle {
  people: ConvertedPersonRow[];
  tags: ConvertedBlogTagRow[];
  posts: ConvertedBlogPostRow[];
  postTags: ConvertedBlogPostTagRow[];
  /** Sanity person _id → Gatewaze people.id (so the applier can resolve refs). */
  personIdMap: Record<string, string>;
  /** Sanity blogTag _id → Gatewaze blog_tags.id. */
  tagIdMap: Record<string, string>;
}

export interface ConvertBlogsArgs {
  /** All Sanity blog documents from the export. */
  blogs: ReadonlyArray<SanityBlogDoc>;
  /** All Sanity person documents from the export. */
  people: ReadonlyArray<SanityPersonDoc>;
  /** All Sanity blogTag documents. */
  tags: ReadonlyArray<SanityBlogTagDoc>;
  /** Sanity asset _id → media URL (built earlier by the asset uploader). */
  assetRefMap: ReadonlyMap<string, string>;
  /** Fallback email domain for synthesized author emails when Sanity has none. */
  fallbackEmailDomain?: string;
}

export interface ConvertBlogsResult {
  bundle: ConvertedBlogBundle;
  warnings: ReadonlyArray<{ docId: string; reason: string }>;
}

const DEFAULT_FALLBACK_DOMAIN = 'imported.aaif.invalid';

export function convertBlogs(args: ConvertBlogsArgs): ConvertBlogsResult {
  const warnings: Array<{ docId: string; reason: string }> = [];

  // -------------------------------------------------------------------------
  // 1. People (authors)
  // -------------------------------------------------------------------------
  const personIdMap: Record<string, string> = {};
  const peopleRows: ConvertedPersonRow[] = [];
  for (const person of args.people) {
    const id = randomUUID();
    personIdMap[person._id] = id;
    const email = person.otherInfo?.email ?? synthesizeEmail(person, args.fallbackEmailDomain ?? DEFAULT_FALLBACK_DOMAIN);
    const fullName = person.name ?? 'Unknown Author';
    const [firstName, ...rest] = fullName.split(' ');
    peopleRows.push({
      id,
      email,
      avatar_url: resolveAsset(person.headshot, args.assetRefMap),
      is_guest: true,
      attributes: {
        first_name: firstName ?? fullName,
        last_name: rest.join(' '),
        full_name: fullName,
        title: person.designation ?? null,
        company: person.companyName ?? null,
        summary: person.summary ?? null,
        bio: person.bio ?? null,
        social_twitter: person.otherInfo?.twitter ?? null,
        social_linkedin: person.otherInfo?.linkedin ?? null,
        social_github: person.otherInfo?.github ?? null,
        website_url: person.otherInfo?.website ?? null,
        // Trace back to source for debugging — never used by the app.
        _sanity_id: person._id,
      },
    });
  }

  // -------------------------------------------------------------------------
  // 2. Tags
  // -------------------------------------------------------------------------
  const tagIdMap: Record<string, string> = {};
  const tagRows: ConvertedBlogTagRow[] = [];
  for (const tag of args.tags) {
    const id = randomUUID();
    tagIdMap[tag._id] = id;
    const slug = tag.slug?.current ?? sluggify(tag.title ?? tag._id);
    tagRows.push({
      id,
      name: tag.title ?? tag._id,
      slug,
      description: tag.description ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // 3. Blog posts
  // -------------------------------------------------------------------------
  const postRows: ConvertedBlogPostRow[] = [];
  const postTagRows: ConvertedBlogPostTagRow[] = [];

  for (const blog of args.blogs) {
    if (!blog.title || !blog.title.trim()) {
      warnings.push({ docId: blog._id, reason: 'missing title — skipping' });
      continue;
    }
    if (!blog.author?._ref) {
      warnings.push({ docId: blog._id, reason: 'missing author ref — skipping (blog_posts.author_id is NOT NULL)' });
      continue;
    }
    const authorId = personIdMap[blog.author._ref];
    if (!authorId) {
      warnings.push({ docId: blog._id, reason: `author ref '${blog.author._ref}' not in people map — skipping` });
      continue;
    }

    const slug = blog.baseSlug?.current ?? blog.slug?.current ?? sluggify(blog.title);
    const content = portableTextToPlain(blog.content ?? []);
    if (blog.content && blog.content.length > 0 && content.length === 0) {
      warnings.push({ docId: blog._id, reason: 'portable-text flattened to empty string' });
    }

    const id = randomUUID();
    const ogImage = resolveAsset(blog.seo?.ogImage, args.assetRefMap);
    const thumbnail = resolveAsset(blog.thumbnail, args.assetRefMap);

    postRows.push({
      id,
      title: blog.title,
      slug,
      excerpt: blog.summary ?? null,
      content,
      featured_image: thumbnail,
      featured_image_alt: null,
      published_at: blog.publishedAt ?? null,
      // If publishedAt is in the past, treat as published. Sanity doesn't
      // track explicit draft state; assume documents with a publish date
      // are intended to be live.
      status: blog.publishedAt && new Date(blog.publishedAt) <= new Date()
        ? 'published'
        : 'draft',
      is_featured: Boolean(blog.featured),
      meta_title: blog.seo?.metaTitle ?? null,
      meta_description: blog.seo?.metaDescription ?? null,
      canonical_url: blog.seo?.canonicalUrl ?? null,
      og_image: ogImage,
      author_id: authorId,
      // blog_posts allows ONE category. AAIF uses multi-category. Drop the
      // rest with a warning so editors know.
      category_id: null,
    });

    if (blog.categories && blog.categories.length > 1) {
      warnings.push({
        docId: blog._id,
        reason: `${blog.categories.length} categories on Sanity blog; blog_posts.category_id supports 1 — all dropped pending multi-category junction`,
      });
    }

    // Tag junction rows
    for (const tagRef of blog.tags ?? []) {
      const tagId = tagIdMap[tagRef._ref];
      if (!tagId) {
        warnings.push({ docId: blog._id, reason: `tag ref '${tagRef._ref}' not in tag map — junction skipped` });
        continue;
      }
      postTagRows.push({ post_id: id, tag_id: tagId });
    }
  }

  return {
    bundle: {
      people: peopleRows,
      tags: tagRows,
      posts: postRows,
      postTags: postTagRows,
      personIdMap,
      tagIdMap,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sluggify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Sanity portable-text → plain text. Concatenates all `block.children[].text`.
 * Lossy — drops marks, link annotations, embedded media. Sufficient for v1
 * where blog_posts.content is a plain text column; future work emits
 * HTML/markdown.
 */
function portableTextToPlain(blocks: ReadonlyArray<SanityPortableTextBlock>): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block._type !== 'block') continue;
    const text = (block.children ?? [])
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .join('');
    if (text.trim().length > 0) {
      out.push(text);
    }
  }
  return out.join('\n\n');
}

/**
 * Pull an image/file ref out of a Sanity object and look it up in the
 * pre-built asset URL map. Handles both bare ref objects and
 * `{_type:'image', asset:{_ref}}` shapes.
 */
function resolveAsset(value: unknown, assetRefMap: ReadonlyMap<string, string>): string | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  // {_type: 'reference', _ref: 'image-...'}
  if (obj._type === 'reference' && typeof obj._ref === 'string') {
    const url = lookupAssetRef(obj._ref, assetRefMap);
    if (url) return url;
  }
  // {_type: 'image' | 'file', asset: { _ref: 'image-...' }, ...}
  if (obj.asset && typeof obj.asset === 'object') {
    const asset = obj.asset as Record<string, unknown>;
    if (asset._type === 'reference' && typeof asset._ref === 'string') {
      const url = lookupAssetRef(asset._ref, assetRefMap);
      if (url) return url;
    }
  }
  return null;
}

function lookupAssetRef(ref: string, assetRefMap: ReadonlyMap<string, string>): string | null {
  // Strip Sanity's prefix; the map is keyed by bare hash or full ref.
  const stripped = ref.replace(/^(image|file)-/, '');
  return assetRefMap.get(stripped) ?? assetRefMap.get(ref) ?? null;
}

function synthesizeEmail(person: SanityPersonDoc, fallbackDomain: string): string {
  // Try to build something stable based on the name + Sanity _id. We
  // need a unique email per person; people.email has a NOT NULL
  // constraint and (likely) a unique index.
  const safeName = (person.name ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  const idSuffix = person._id.replace(/^seed\.person\./, '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return `${safeName}-${idSuffix}@${fallbackDomain}`;
}
