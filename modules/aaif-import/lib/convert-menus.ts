/**
 * Convert AAIF Sanity headerSettings + footerSettings → Gatewaze
 * navigation_menus + navigation_menu_items.
 *
 * Sanity shape (the relevant excerpts):
 *
 *   headerSettings.menu: [
 *     { _key, _type: 'headerMenuItem',
 *       kind: 'link' | 'dropdown',
 *       label,
 *       link: { type: 'internal' | 'external' | 'relative' | 'email' | 'phone',
 *               external?, relative?, email?, phone?, target? },
 *       links?: [ cta ]  // populated when kind === 'dropdown'
 *     }, ...
 *   ]
 *
 *   footerSettings.menu: [
 *     { _key, _type: 'footerMenuGroup',
 *       title?,
 *       links: [ cta ]
 *     }, ...
 *   ]
 *
 * Gatewaze shape:
 *
 *   navigation_menus(id, host_kind='site', host_id, slug, name)
 *   navigation_menu_items(id, menu_id, parent_id, order_index, label,
 *     page_id, external_url, anchor_target, open_in_new_tab)
 *
 * Mapping:
 *   - One navigation_menus row per Sanity menu (slug='primary' for
 *     header, slug='footer' for footer)
 *   - headerMenuItem kind='link' → one row, parent_id=NULL, target from link
 *   - headerMenuItem kind='dropdown' → one parent row + child rows per
 *     link in `links[]`
 *   - footerMenuGroup with title → parent row (label=title, no target) +
 *     child rows. Group with no title → all links flat at parent_id=NULL.
 *
 *   Link target resolution:
 *     type='relative'  → match against pages.full_path; sets page_id when
 *                        found, falls back to external_url=relative
 *     type='external'  → external_url
 *     type='internal'  → link.internal._ref (a Sanity doc ref); resolved
 *                        via pageSlugMap when possible
 *     type='email'     → external_url = `mailto:${email}`
 *     type='phone'     → external_url = `tel:${phone}`
 *
 *   open_in_new_tab is set when link.target === '_blank'.
 */

import { randomUUID } from 'node:crypto';

export interface SanityCta {
  _type: 'cta';
  _key?: string;
  label?: string;
  type?: 'internal' | 'external' | 'relative' | 'email' | 'phone';
  internal?: { _ref: string; _type: 'reference' };
  external?: string;
  relative?: string;
  email?: string;
  phone?: string;
  target?: '_self' | '_blank';
  hidden?: boolean;
  hideOnDesktop?: boolean;
  hideOnMobile?: boolean;
}

export interface SanityHeaderMenuItem {
  _key: string;
  _type: 'headerMenuItem';
  kind?: 'link' | 'dropdown';
  label?: string;
  link?: SanityCta;
  links?: ReadonlyArray<SanityCta>;
}

export interface SanityFooterMenuGroup {
  _key: string;
  _type: 'footerMenuGroup';
  title?: string;
  links?: ReadonlyArray<SanityCta>;
}

export interface SanityHeaderSettingsDoc {
  _id: 'headerSettings' | string;
  _type: 'headerSettings';
  menu?: ReadonlyArray<SanityHeaderMenuItem>;
}

export interface SanityFooterSettingsDoc {
  _id: 'footerSettings' | string;
  _type: 'footerSettings';
  menu?: ReadonlyArray<SanityFooterMenuGroup>;
}

export interface ConvertedMenu {
  id: string;
  site_id: string;
  host_kind: 'site';
  slug: string;
  name: string;
}

export interface ConvertedMenuItem {
  id: string;
  menu_id: string;
  parent_id: string | null;
  order_index: number;
  label: string;
  page_id: string | null;
  external_url: string | null;
  anchor_target: string | null;
  open_in_new_tab: boolean;
}

export interface ConvertMenusArgs {
  siteId: string;
  header?: SanityHeaderSettingsDoc;
  footer?: SanityFooterSettingsDoc;
  /** Sanity-relative-path → Gatewaze pages.id. When a header/footer item
   *  uses `type: 'relative'` and the path resolves, we set page_id.
   *  Otherwise we fall back to external_url. */
  pagePathMap?: ReadonlyMap<string, string>;
  /** Sanity document _id → relative path (used to resolve `type: 'internal'`
   *  CTAs). When a doc ref resolves, the result becomes the relative URL
   *  for pagePathMap lookup. */
  docIdToPath?: ReadonlyMap<string, string>;
}

export interface ConvertMenusResult {
  menus: ConvertedMenu[];
  items: ConvertedMenuItem[];
  warnings: ReadonlyArray<{ menu: 'header' | 'footer'; key: string; reason: string }>;
}

export function convertMenus(args: ConvertMenusArgs): ConvertMenusResult {
  const warnings: Array<{ menu: 'header' | 'footer'; key: string; reason: string }> = [];
  const menus: ConvertedMenu[] = [];
  const items: ConvertedMenuItem[] = [];

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------
  if (args.header && args.header.menu && args.header.menu.length > 0) {
    const headerMenuId = randomUUID();
    menus.push({
      id: headerMenuId,
      site_id: args.siteId,
      host_kind: 'site',
      slug: 'primary',
      name: 'Header',
    });

    args.header.menu.forEach((entry, idx) => {
      if (!entry.label) {
        warnings.push({ menu: 'header', key: entry._key, reason: 'missing label — skipping' });
        return;
      }
      if (entry.kind === 'dropdown' && entry.links && entry.links.length > 0) {
        // Parent row carries the label only (no link target).
        const parentId = randomUUID();
        items.push({
          id: parentId,
          menu_id: headerMenuId,
          parent_id: null,
          order_index: idx,
          label: entry.label,
          page_id: null,
          external_url: null,
          anchor_target: null,
          open_in_new_tab: false,
        });
        entry.links.forEach((subLink, subIdx) => {
          items.push(buildItemFromCta({
            menuId: headerMenuId,
            parentId,
            orderIndex: subIdx,
            cta: subLink,
            fallbackLabel: subLink.label ?? '',
            args,
            menu: 'header',
            warnings,
          }));
        });
      } else {
        // Plain link
        items.push(buildItemFromCta({
          menuId: headerMenuId,
          parentId: null,
          orderIndex: idx,
          cta: entry.link ?? { _type: 'cta', label: entry.label },
          fallbackLabel: entry.label,
          args,
          menu: 'header',
          warnings,
        }));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Footer
  // -------------------------------------------------------------------------
  if (args.footer && args.footer.menu && args.footer.menu.length > 0) {
    const footerMenuId = randomUUID();
    menus.push({
      id: footerMenuId,
      site_id: args.siteId,
      host_kind: 'site',
      slug: 'footer',
      name: 'Footer',
    });

    // Track a running index across groups so order_index stays globally
    // monotonic — easier for the admin UI to render in stable order.
    let cursor = 0;
    args.footer.menu.forEach((group) => {
      if (group.title && group.title.trim().length > 0) {
        // Group with a heading: emit a parent row.
        const parentId = randomUUID();
        items.push({
          id: parentId,
          menu_id: footerMenuId,
          parent_id: null,
          order_index: cursor++,
          label: group.title,
          page_id: null,
          external_url: null,
          anchor_target: null,
          open_in_new_tab: false,
        });
        (group.links ?? []).forEach((link, idx) => {
          items.push(buildItemFromCta({
            menuId: footerMenuId,
            parentId,
            orderIndex: idx,
            cta: link,
            fallbackLabel: link.label ?? '',
            args,
            menu: 'footer',
            warnings,
          }));
        });
      } else {
        // Title-less group: hoist links to top-level.
        (group.links ?? []).forEach((link) => {
          items.push(buildItemFromCta({
            menuId: footerMenuId,
            parentId: null,
            orderIndex: cursor++,
            cta: link,
            fallbackLabel: link.label ?? '',
            args,
            menu: 'footer',
            warnings,
          }));
        });
      }
    });
  }

  return { menus, items, warnings };
}

// ---------------------------------------------------------------------------
// CTA → menu item
// ---------------------------------------------------------------------------

function buildItemFromCta(opts: {
  menuId: string;
  parentId: string | null;
  orderIndex: number;
  cta: SanityCta;
  fallbackLabel: string;
  args: ConvertMenusArgs;
  menu: 'header' | 'footer';
  warnings: Array<{ menu: 'header' | 'footer'; key: string; reason: string }>;
}): ConvertedMenuItem {
  const label = opts.cta.label ?? opts.fallbackLabel;
  const id = randomUUID();
  const target = opts.cta.target === '_blank' ? true : false;

  const base: ConvertedMenuItem = {
    id,
    menu_id: opts.menuId,
    parent_id: opts.parentId,
    order_index: opts.orderIndex,
    label,
    page_id: null,
    external_url: null,
    anchor_target: null,
    open_in_new_tab: target,
  };

  const type = opts.cta.type;
  if (type === 'relative' && opts.cta.relative) {
    const pageId = opts.args.pagePathMap?.get(opts.cta.relative);
    if (pageId) {
      base.page_id = pageId;
    } else {
      // No page yet (e.g. /about-us doesn't exist in Gatewaze) — fall
      // back to a relative URL so the navigation still works once the
      // page is created or via a passthrough route.
      base.external_url = opts.cta.relative;
    }
  } else if (type === 'external' && opts.cta.external) {
    base.external_url = opts.cta.external;
  } else if (type === 'internal' && opts.cta.internal?._ref) {
    const path = opts.args.docIdToPath?.get(opts.cta.internal._ref);
    if (path) {
      const pageId = opts.args.pagePathMap?.get(path);
      if (pageId) {
        base.page_id = pageId;
      } else {
        base.external_url = path;
      }
    } else {
      opts.warnings.push({
        menu: opts.menu,
        key: opts.cta._key ?? '?',
        reason: `internal doc ref '${opts.cta.internal._ref}' not resolved`,
      });
    }
  } else if (type === 'email' && opts.cta.email) {
    base.external_url = `mailto:${opts.cta.email}`;
  } else if (type === 'phone' && opts.cta.phone) {
    base.external_url = `tel:${opts.cta.phone}`;
  } else {
    opts.warnings.push({
      menu: opts.menu,
      key: opts.cta._key ?? '?',
      reason: `unrecognised cta type '${type ?? 'unset'}' — leaving item with empty target`,
    });
  }
  return base;
}
