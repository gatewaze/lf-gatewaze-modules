import { describe, expect, it } from 'vitest';
import { convertMenus, type SanityHeaderSettingsDoc, type SanityFooterSettingsDoc } from '../lib/convert-menus.js';

const SITE_ID = 'site-aaif';

function header(menu: SanityHeaderSettingsDoc['menu'] = []): SanityHeaderSettingsDoc {
  return { _id: 'headerSettings', _type: 'headerSettings', menu };
}

function footer(menu: SanityFooterSettingsDoc['menu'] = []): SanityFooterSettingsDoc {
  return { _id: 'footerSettings', _type: 'footerSettings', menu };
}

describe('convertMenus — header', () => {
  it('builds one menu row + top-level items', () => {
    const { menus, items } = convertMenus({
      siteId: SITE_ID,
      header: header([
        { _key: 'a', _type: 'headerMenuItem', kind: 'link', label: 'Projects',
          link: { _type: 'cta', type: 'relative', relative: '/projects' } },
      ]),
    });
    expect(menus).toHaveLength(1);
    expect(menus[0]).toMatchObject({ slug: 'primary', name: 'Header', site_id: SITE_ID });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: 'Projects',
      parent_id: null,
      external_url: '/projects',
      page_id: null,
    });
  });

  it('resolves relative paths to page_id via pagePathMap', () => {
    const pagePathMap = new Map([['/projects', 'page-projects-uuid']]);
    const { items } = convertMenus({
      siteId: SITE_ID,
      pagePathMap,
      header: header([
        { _key: 'a', _type: 'headerMenuItem', kind: 'link', label: 'Projects',
          link: { _type: 'cta', type: 'relative', relative: '/projects' } },
      ]),
    });
    expect(items[0]).toMatchObject({
      page_id: 'page-projects-uuid',
      external_url: null,
    });
  });

  it('expands dropdowns into parent + child rows', () => {
    const { items } = convertMenus({
      siteId: SITE_ID,
      header: header([
        { _key: 'about', _type: 'headerMenuItem', kind: 'dropdown', label: 'About AAIF',
          links: [
            { _key: 'sub1', _type: 'cta', label: 'About Us', type: 'relative', relative: '/about-us' },
            { _key: 'sub2', _type: 'cta', label: 'Members', type: 'relative', relative: '/members' },
          ],
        },
      ]),
    });
    expect(items).toHaveLength(3);
    const parent = items.find((i) => i.label === 'About AAIF');
    expect(parent?.parent_id).toBeNull();
    expect(parent?.page_id).toBeNull();
    expect(parent?.external_url).toBeNull();
    const children = items.filter((i) => i.parent_id === parent?.id);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.label).sort()).toEqual(['About Us', 'Members']);
  });

  it('sets open_in_new_tab when target=_blank', () => {
    const { items } = convertMenus({
      siteId: SITE_ID,
      header: header([
        { _key: 'a', _type: 'headerMenuItem', kind: 'link', label: 'External',
          link: { _type: 'cta', type: 'external', external: 'https://other.com', target: '_blank' } },
      ]),
    });
    expect(items[0]).toMatchObject({
      external_url: 'https://other.com',
      open_in_new_tab: true,
    });
  });

  it('handles email + phone cta types', () => {
    const { items } = convertMenus({
      siteId: SITE_ID,
      header: header([
        { _key: 'a', _type: 'headerMenuItem', kind: 'link', label: 'Email',
          link: { _type: 'cta', type: 'email', email: 'hi@aaif.io' } },
        { _key: 'b', _type: 'headerMenuItem', kind: 'link', label: 'Phone',
          link: { _type: 'cta', type: 'phone', phone: '+1-555-0100' } },
      ]),
    });
    expect(items[0]?.external_url).toBe('mailto:hi@aaif.io');
    expect(items[1]?.external_url).toBe('tel:+1-555-0100');
  });

  it('warns + skips items missing a label', () => {
    const { items, warnings } = convertMenus({
      siteId: SITE_ID,
      header: header([
        { _key: 'a', _type: 'headerMenuItem', kind: 'link',
          link: { _type: 'cta', type: 'relative', relative: '/x' } },
      ]),
    });
    expect(items).toHaveLength(0);
    expect(warnings.some((w) => w.reason.includes('missing label'))).toBe(true);
  });
});

describe('convertMenus — footer', () => {
  it('builds parent rows for titled groups, hoists titleless link arrays', () => {
    const { menus, items } = convertMenus({
      siteId: SITE_ID,
      footer: footer([
        { _key: 'g1', _type: 'footerMenuGroup', title: 'About',
          links: [
            { _key: 'a', _type: 'cta', label: 'Members', type: 'relative', relative: '/members' },
          ],
        },
        { _key: 'g2', _type: 'footerMenuGroup', // no title
          links: [
            { _key: 'b', _type: 'cta', label: 'Privacy', type: 'relative', relative: '/privacy' },
          ],
        },
      ]),
    });
    expect(menus[0]?.slug).toBe('footer');
    expect(items).toHaveLength(3);
    const parent = items.find((i) => i.label === 'About');
    expect(parent?.parent_id).toBeNull();
    const child = items.find((i) => i.label === 'Members');
    expect(child?.parent_id).toBe(parent?.id);
    // titleless group's link is at parent_id=null
    const privacy = items.find((i) => i.label === 'Privacy');
    expect(privacy?.parent_id).toBeNull();
  });
});

describe('convertMenus — both menus', () => {
  it('emits header + footer rows with distinct menu ids', () => {
    const { menus } = convertMenus({
      siteId: SITE_ID,
      header: header([
        { _key: 'a', _type: 'headerMenuItem', kind: 'link', label: 'Projects',
          link: { _type: 'cta', type: 'relative', relative: '/projects' } },
      ]),
      footer: footer([
        { _key: 'g1', _type: 'footerMenuGroup', title: 'About',
          links: [{ _key: 'b', _type: 'cta', label: 'Members', type: 'relative', relative: '/members' }] },
      ]),
    });
    expect(menus).toHaveLength(2);
    expect(menus.map((m) => m.slug).sort()).toEqual(['footer', 'primary']);
    expect(menus[0]?.id).not.toBe(menus[1]?.id);
  });

  it('returns empty result when nothing is provided', () => {
    const { menus, items } = convertMenus({ siteId: SITE_ID });
    expect(menus).toHaveLength(0);
    expect(items).toHaveLength(0);
  });
});
