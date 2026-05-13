/**
 * Shape of a parsed Sanity field definition.
 *
 * We don't import Sanity's types directly — Sanity uses heavy type
 * generics that pull in the whole Studio framework, and we only need
 * the static shape for conversion. The parser populates these from
 * either ts-morph extraction or JSON dataset exports.
 */

export interface ParsedSanityField {
  name: string;
  title?: string;
  description?: string;
  type: SanityFieldType;
  /** Default value (initialValue in Sanity terms). */
  initialValue?: unknown;
  /**
   * Required, min/max, etc. Extracted from `validation: Rule => Rule.required().min(5)`
   * by introspecting the call chain. Custom `Rule.custom(...)` is recorded as
   * `{ kind: 'custom', source: '<text of fn>' }` and dropped during conversion.
   */
  validation?: ParsedValidation[];
  /** Sanity's `options: { list: [...], layout: 'radio', hotspot: true, ... }`. */
  options?: ParsedFieldOptions;
  /** Discriminator-style `hidden: ({parent}) => parent.x !== '...'`. Best-effort. */
  hidden?: ParsedHiddenCondition;
  /** Sanity's groups — surfaced as JSON Schema `x-gatewaze-group`. */
  group?: string;
  /** For object/array types — the nested children. */
  fields?: ParsedSanityField[];
  /** For arrays — `of: [{ type: 'object', ... }]`. */
  of?: ParsedArrayMember[];
  /** For references — `to: [{ type: 'page' }, { type: 'blog' }]`. */
  to?: string[];
}

export type SanityFieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'slug'
  | 'url'
  | 'email'
  | 'image'
  | 'file'
  | 'reference'
  | 'array'
  | 'object'
  | 'block'
  // Custom types declared in the AAIF schema set:
  | 'heading'
  | 'cta'
  | 'media'
  | 'portableText'
  | 'seo'
  | 'personalizedBlock'
  | 'personalizedVariant'
  | 'tierCondition';

export interface ParsedValidation {
  kind: 'required' | 'min' | 'max' | 'minLength' | 'maxLength' | 'custom';
  value?: number;
  /** For custom validation rules — original function source. */
  source?: string;
}

export interface ParsedFieldOptions {
  list?: ReadonlyArray<{ title?: string; value: string | number | boolean }>;
  layout?: 'radio' | 'dropdown' | 'tags';
  hotspot?: boolean;
  accept?: string;
  direction?: 'horizontal' | 'vertical';
  collapsible?: boolean;
  collapsed?: boolean;
  rows?: number;
}

export interface ParsedHiddenCondition {
  /** Parent prop the visibility depends on, e.g. 'videoType' for `parent.videoType !== 'file'`. */
  parentField: string;
  /** Equality test — visible when parent[parentField] equals this value. */
  expectedValue: string | number | boolean;
}

export interface ParsedArrayMember {
  type: string;
  /** When `type: 'reference'`, the document types it can point to. */
  to?: string[];
  /** When the member is an inline object, its fields. */
  fields?: ParsedSanityField[];
  /** For block (portable text) entries — the allowed styles. */
  styles?: ReadonlyArray<{ title: string; value: string }>;
}

export interface ParsedSanitySchema {
  /** `defineType({ name, ... }).name` — the schema's stable identifier. */
  name: string;
  /** Display title in Sanity Studio. */
  title?: string;
  /** 'object' | 'document'. */
  type: 'object' | 'document';
  /** Sanity Studio field groups (tabs in the inspector). */
  groups?: ReadonlyArray<{ name: string; title: string; default?: boolean }>;
  fields: ParsedSanityField[];
}
