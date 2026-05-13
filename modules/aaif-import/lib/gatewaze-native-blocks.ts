/**
 * Curated Gatewaze-native block_defs that aren't derived from AAIF's
 * Sanity schemas. These are blocks the AAIF Next.js theme uses to surface
 * Gatewaze module content (blogs, podcasts, events) — they don't have a
 * 1:1 source in the agency repo.
 *
 * Each entry is upserted into `templates_block_defs` keyed by
 * (library_id, key, version). Adding entries here = adding a block to
 * the AAIF library that the Puck editor can drop onto pages.
 *
 * Schema convention: same shape the Puck adapter (PuckConfigAdapter)
 * eats. `x-gatewaze-personalize` on a field marks it as wrappable with
 * the Personalize side panel.
 *
 * block_kind='gatewaze-internal' + freshness='live' tells the theme to
 * fetch the data at render time (calling /api/blog/posts in this case).
 */

export interface NativeBlockDef {
  key: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  block_kind: 'gatewaze-internal';
  freshness: 'live';
  audience: 'public';
  kind_attributes: Record<string, unknown>;
  component_export_path: string;
  /** Default Mustache template for the canvas preview. Empty string
   *  when the Puck adapter will use the React component instead. */
  html: string;
}

/**
 * Blog feed — surfaces Gatewaze blog_posts in a configurable list.
 *
 * The theme component reads kind_attributes + content props to build
 * the API query: GET /api/blog/posts?limit=N&category=<slug>&featured=true
 */
const BLOG_FEED: NativeBlockDef = {
  key: 'blog-feed',
  name: 'Blog Feed',
  description: 'Surface Gatewaze blog posts as a configurable list. Live-fetched from /api/blog/posts at render time.',
  block_kind: 'gatewaze-internal',
  freshness: 'live',
  audience: 'public',
  kind_attributes: {
    source: 'blog-posts',
    api_path: '/api/blog/posts',
  },
  component_export_path: '@/components/blocks/BlogFeed',
  html: '',
  schema: {
    type: 'object',
    title: 'Blog Feed',
    properties: {
      heading: {
        type: 'string',
        title: 'Heading',
        default: 'Latest from the blog',
        'x-gatewaze-personalize': true,
      },
      subheading: {
        type: 'string',
        title: 'Subheading',
        default: '',
      },
      limit: {
        type: 'integer',
        title: 'Number of posts',
        default: 6,
        minimum: 1,
        maximum: 24,
      },
      categorySlug: {
        type: 'string',
        title: 'Filter by category slug',
        description: 'Leave empty to show all categories.',
        default: '',
      },
      tagSlug: {
        type: 'string',
        title: 'Filter by tag slug',
        default: '',
      },
      featuredOnly: {
        type: 'boolean',
        title: 'Only show featured posts',
        default: false,
      },
      showExcerpt: {
        type: 'boolean',
        title: 'Show post excerpt',
        default: true,
      },
      showAuthor: {
        type: 'boolean',
        title: 'Show author',
        default: true,
      },
      ctaLabel: {
        type: 'string',
        title: 'CTA label (e.g. "Read more")',
        default: 'Read more',
        'x-gatewaze-personalize': true,
      },
      layout: {
        type: 'string',
        title: 'Layout',
        enum: ['grid', 'list', 'featured-grid'],
        default: 'grid',
      },
    },
  },
};

export const GATEWAZE_NATIVE_BLOCKS: ReadonlyArray<NativeBlockDef> = [
  BLOG_FEED,
];
