import { describe, expect, it } from 'vitest';
import { sanitySchemaToJsonSchema } from '../lib/sanity-to-json-schema.js';
import type { ParsedSanitySchema } from '../lib/sanity-types.js';

describe('sanitySchemaToJsonSchema — primitives', () => {
  it('maps string', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'title', type: 'string', title: 'Title' }],
    });
    expect(out.schema.properties?.title).toEqual({ type: 'string', title: 'Title' });
  });

  it('maps text with rows=3 to textarea', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'body', type: 'string', options: { rows: 4 } }],
    });
    expect(out.schema.properties?.body).toMatchObject({ type: 'string', format: 'textarea' });
  });

  it('maps Sanity text type', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'body', type: 'text' }],
    });
    expect(out.schema.properties?.body).toMatchObject({ type: 'string', format: 'textarea' });
  });

  it('maps number, boolean, url, email', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [
        { name: 'count', type: 'number' },
        { name: 'visible', type: 'boolean' },
        { name: 'link', type: 'url' },
        { name: 'contact', type: 'email' },
      ],
    });
    expect(out.schema.properties?.count).toMatchObject({ type: 'number' });
    expect(out.schema.properties?.visible).toMatchObject({ type: 'boolean' });
    expect(out.schema.properties?.link).toMatchObject({ type: 'string', format: 'uri' });
    expect(out.schema.properties?.contact).toMatchObject({ type: 'string', format: 'email' });
  });
});

describe('sanitySchemaToJsonSchema — image/file/reference', () => {
  it('maps image to string format=image', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'thumbnail', type: 'image' }],
    });
    expect(out.schema.properties?.thumbnail).toMatchObject({ type: 'string', format: 'image' });
  });

  it('maps file to format=file-url', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'videoFile', type: 'file' }],
    });
    expect(out.schema.properties?.videoFile).toMatchObject({ type: 'string', format: 'file-url' });
  });

  it('maps reference with single target', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'page', type: 'reference', to: ['page'] }],
    });
    expect(out.schema.properties?.page).toMatchObject({
      type: 'string',
      format: 'ref-page',
      'x-aaif-ref-to': ['page'],
    });
  });

  it('maps reference with multi targets', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'target', type: 'reference', to: ['page', 'blog', 'event'] }],
    });
    expect(out.schema.properties?.target).toMatchObject({
      type: 'string',
      format: 'ref-multi',
      'x-aaif-ref-to': ['page', 'blog', 'event'],
    });
  });
});

describe('sanitySchemaToJsonSchema — enum + validation', () => {
  it('options.list becomes enum', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{
        name: 'level',
        type: 'string',
        options: {
          list: [
            { title: 'H1', value: 'h1' },
            { title: 'H2', value: 'h2' },
          ],
        },
      }],
    });
    expect(out.schema.properties?.level?.enum).toEqual(['h1', 'h2']);
  });

  it('required validation collects on parent', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [
        { name: 'title', type: 'string', validation: [{ kind: 'required' }] },
        { name: 'subtitle', type: 'string' },
      ],
    });
    expect(out.schema.required).toEqual(['title']);
  });

  it('min/max on number → minimum/maximum', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{
        name: 'count',
        type: 'number',
        validation: [{ kind: 'min', value: 1 }, { kind: 'max', value: 10 }],
      }],
    });
    expect(out.schema.properties?.count).toMatchObject({ type: 'number', minimum: 1, maximum: 10 });
  });

  it('min on string → minLength', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'slug', type: 'string', validation: [{ kind: 'min', value: 3 }] }],
    });
    expect(out.schema.properties?.slug).toMatchObject({ type: 'string', minLength: 3 });
  });
});

describe('sanitySchemaToJsonSchema — composite', () => {
  it('object with nested fields', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{
        name: 'media',
        type: 'object',
        fields: [
          { name: 'url', type: 'url' },
          { name: 'alt', type: 'string', validation: [{ kind: 'required' }] },
        ],
      }],
    });
    expect(out.schema.properties?.media).toMatchObject({
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        alt: { type: 'string' },
      },
      required: ['alt'],
    });
  });

  it('array of objects', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{
        name: 'items',
        type: 'array',
        of: [{
          type: 'object',
          fields: [
            { name: 'label', type: 'string' },
            { name: 'value', type: 'number' },
          ],
        }],
      }],
    });
    expect(out.schema.properties?.items).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, value: { type: 'number' } },
      },
    });
  });

  it('array of references', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{
        name: 'related',
        type: 'array',
        of: [{ type: 'reference', to: ['blog'] }],
      }],
    });
    expect(out.schema.properties?.related).toMatchObject({
      type: 'array',
      items: { type: 'string', format: 'ref-blog', 'x-aaif-ref-to': ['blog'] },
    });
  });

  it('heterogeneous array (page-builder) emits warning', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'page',
      type: 'document',
      fields: [{
        name: 'pageBuilder',
        type: 'array',
        of: [{ type: 'hero' }, { type: 'faq' }, { type: 'meetup' }],
      }],
    });
    expect(out.warnings.some((w) => w.fieldPath === 'page.pageBuilder')).toBe(true);
    expect(out.schema.properties?.pageBuilder).toMatchObject({
      type: 'array',
      'x-aaif-source-type': 'heterogeneous-array',
    });
  });
});

describe('sanitySchemaToJsonSchema — AAIF custom types', () => {
  it('heading type expands to {text, type, fontSize}', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'h', type: 'heading' }],
    });
    expect(out.schema.properties?.h).toMatchObject({
      type: 'object',
      properties: {
        text: { type: 'string' },
        type: { type: 'string', enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] },
      },
    });
  });

  it('cta type expands with variants + link type', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'cta', type: 'cta' }],
    });
    expect(out.schema.properties?.cta).toMatchObject({
      type: 'object',
      properties: {
        label: { type: 'string' },
        variant: { enum: ['default', 'secondary', 'text'] },
        type: { enum: ['internal', 'external', 'relative', 'email', 'phone'] },
      },
    });
  });

  it('portableText maps to richtext format', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'body', type: 'portableText' }],
    });
    expect(out.schema.properties?.body).toMatchObject({ type: 'string', format: 'richtext' });
  });

  it('personalizedBlock emits warning + marker', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      fields: [{ name: 'wrap', type: 'personalizedBlock' }],
    });
    expect(out.warnings.some((w) => w.reason.includes('decomposed'))).toBe(true);
    expect(out.schema.properties?.wrap).toMatchObject({ 'x-aaif-source-type': 'personalizedBlock' });
  });
});

describe('sanitySchemaToJsonSchema — groups', () => {
  it('preserves group as x-gatewaze-group', () => {
    const out = sanitySchemaToJsonSchema({
      name: 'demo',
      type: 'object',
      groups: [{ name: 'content', title: 'Content', default: true }],
      fields: [{ name: 'title', type: 'string', group: 'content' }],
    });
    expect(out.schema.properties?.title).toMatchObject({ 'x-gatewaze-group': 'content' });
  });
});
