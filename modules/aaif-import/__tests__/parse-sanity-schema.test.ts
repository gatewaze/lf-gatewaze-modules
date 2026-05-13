import { describe, expect, it } from 'vitest';
import { parseSanitySchemaString } from '../lib/parse-sanity-schema.js';

describe('parseSanitySchemaString — basic', () => {
  it('parses name, title, type', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType} from 'sanity';
      export const hero = defineType({
        name: 'hero',
        title: 'Hero',
        type: 'object',
        fields: [],
      });
    `);
    expect(schema.name).toBe('hero');
    expect(schema.title).toBe('Hero');
    expect(schema.type).toBe('object');
    expect(schema.fields).toEqual([]);
  });

  it('parses groups', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType} from 'sanity';
      export const x = defineType({
        name: 'x',
        type: 'object',
        groups: [
          {name: 'content', title: 'Content', default: true},
          {name: 'media', title: 'Media'},
        ],
        fields: [],
      });
    `);
    expect(schema.groups).toEqual([
      { name: 'content', title: 'Content', default: true },
      { name: 'media', title: 'Media' },
    ]);
  });
});

describe('parseSanitySchemaString — fields', () => {
  it('parses primitive fields with title + description', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType, defineField} from 'sanity';
      export const x = defineType({
        name: 'x',
        type: 'object',
        fields: [
          defineField({ name: 'title', type: 'string', title: 'Title', description: 'The thing' }),
          defineField({ name: 'count', type: 'number' }),
        ],
      });
    `);
    expect(schema.fields).toHaveLength(2);
    expect(schema.fields[0]).toMatchObject({ name: 'title', type: 'string', title: 'Title', description: 'The thing' });
    expect(schema.fields[1]).toMatchObject({ name: 'count', type: 'number' });
  });

  it('parses options.list', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType, defineField} from 'sanity';
      export const x = defineType({
        name: 'x', type: 'object',
        fields: [
          defineField({
            name: 'size',
            type: 'string',
            options: {
              list: [{title: 'Small', value: 'sm'}, {title: 'Large', value: 'lg'}],
              layout: 'radio',
            },
          }),
        ],
      });
    `);
    expect(schema.fields[0]?.options?.list).toEqual([
      { title: 'Small', value: 'sm' },
      { title: 'Large', value: 'lg' },
    ]);
    expect(schema.fields[0]?.options?.layout).toBe('radio');
  });

  it('parses validation Rule.required().min(5)', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType, defineField} from 'sanity';
      export const x = defineType({
        name: 'x', type: 'object',
        fields: [
          defineField({
            name: 'title',
            type: 'string',
            validation: Rule => Rule.required().min(5).max(100),
          }),
        ],
      });
    `);
    const v = schema.fields[0]?.validation ?? [];
    expect(v).toContainEqual({ kind: 'required' });
    expect(v).toContainEqual({ kind: 'min', value: 5 });
    expect(v).toContainEqual({ kind: 'max', value: 100 });
  });

  it('parses initialValue (literal)', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType, defineField} from 'sanity';
      export const x = defineType({
        name: 'x', type: 'object',
        fields: [
          defineField({ name: 'kind', type: 'string', initialValue: 'file' }),
          defineField({ name: 'active', type: 'boolean', initialValue: true }),
        ],
      });
    `);
    expect(schema.fields[0]?.initialValue).toBe('file');
    expect(schema.fields[1]?.initialValue).toBe(true);
  });

  it('parses hidden discriminator (parent.x !== "y")', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType, defineField} from 'sanity';
      export const x = defineType({
        name: 'x', type: 'object',
        fields: [
          defineField({
            name: 'videoFile',
            type: 'file',
            hidden: ({parent}) => parent?.videoType !== 'file',
          }),
        ],
      });
    `);
    expect(schema.fields[0]?.hidden).toEqual({ parentField: 'videoType', expectedValue: 'file' });
  });

  it('parses nested object fields', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType, defineField} from 'sanity';
      export const x = defineType({
        name: 'x', type: 'object',
        fields: [
          defineField({
            name: 'media',
            type: 'object',
            fields: [
              {name: 'url', type: 'url'},
              {name: 'alt', type: 'string'},
            ],
          }),
        ],
      });
    `);
    const media = schema.fields[0];
    expect(media?.type).toBe('object');
    expect(media?.fields).toHaveLength(2);
    expect(media?.fields?.[0]).toMatchObject({ name: 'url', type: 'url' });
  });

  it('parses array of objects', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType, defineField} from 'sanity';
      export const x = defineType({
        name: 'x', type: 'object',
        fields: [
          defineField({
            name: 'items',
            type: 'array',
            of: [{ type: 'object', fields: [{name: 'label', type: 'string'}] }],
          }),
        ],
      });
    `);
    expect(schema.fields[0]?.of).toHaveLength(1);
    expect(schema.fields[0]?.of?.[0]).toMatchObject({
      type: 'object',
      fields: [{ name: 'label', type: 'string' }],
    });
  });

  it('parses reference with `to`', () => {
    const { schema } = parseSanitySchemaString(`
      import {defineType, defineField} from 'sanity';
      export const x = defineType({
        name: 'x', type: 'object',
        fields: [
          defineField({ name: 'page', type: 'reference', to: [{type: 'page'}, {type: 'blog'}] }),
        ],
      });
    `);
    expect(schema.fields[0]?.to).toEqual(['page', 'blog']);
  });
});

describe('parseSanitySchemaString — spreads', () => {
  it('warns on unresolved spread', () => {
    const { warnings } = parseSanitySchemaString(`
      import {defineType} from 'sanity';
      import {visibilityFields} from './fields';
      export const x = defineType({
        name: 'x', type: 'object',
        fields: [...visibilityFields, {name: 'title', type: 'string'}],
      });
    `);
    expect(warnings.some((w) => w.reason.includes('visibilityFields'))).toBe(true);
  });

  it('inlines a known spread', () => {
    const knownFieldSets = {
      visibilityFields: [{ name: 'visibleTo', type: 'array' as const }],
    };
    const { schema } = parseSanitySchemaString(
      `
        import {defineType} from 'sanity';
        export const x = defineType({
          name: 'x', type: 'object',
          fields: [...visibilityFields, {name: 'title', type: 'string'}],
        });
      `,
      'demo.ts',
      { knownFieldSets },
    );
    expect(schema.fields).toHaveLength(2);
    expect(schema.fields[0]?.name).toBe('visibleTo');
    expect(schema.fields[1]?.name).toBe('title');
  });
});
