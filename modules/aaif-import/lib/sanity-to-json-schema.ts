/**
 * Sanity schema → JSON Schema (the shape `templates_block_defs.schema`
 * stores).
 *
 * Targets the Gatewaze Puck adapter's vocabulary:
 *   - String/number/boolean primitives
 *   - `format` on strings: 'textarea', 'richtext', 'image', 'file-url',
 *     'ref-<doctype>', 'email', 'uri', 'slug'
 *   - `enum` from Sanity's `options.list`
 *   - Object with `properties` + `required`
 *   - Array with `items`
 *   - `x-gatewaze-group` to carry Sanity Studio groups (for the future
 *     editor's grouping UI)
 *   - `x-gatewaze-personalize` is NOT set here — that's authored on the
 *     Gatewaze side after import (per-field opt-in by the editor).
 *
 * Skipped (recorded as warnings):
 *   - Custom Sanity input components (FlatObjectField, LinkInput, etc.)
 *     — Gatewaze has its own equivalents
 *   - Complex `Rule.custom(...)` validations
 *   - `hidden: ({parent}) => ...` discriminators with non-equality logic
 */

import type {
  ParsedSanityField,
  ParsedSanitySchema,
  ParsedArrayMember,
  SanityFieldType,
} from './sanity-types.js';

export interface JsonSchemaNode {
  type?: string | string[];
  format?: string;
  enum?: ReadonlyArray<string | number | boolean>;
  title?: string;
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** Sanity groups — preserved for future editor grouping. */
  'x-gatewaze-group'?: string;
  /** Mark a field as a reference to a doc type. Preserved so the importer
   *  can resolve refs at content-conversion time. */
  'x-aaif-ref-to'?: string[];
  /** Track unmapped Sanity types we punted on. */
  'x-aaif-source-type'?: string;
}

export interface ConvertWarning {
  fieldPath: string;
  reason: string;
}

export interface ConvertResult {
  schema: JsonSchemaNode;
  warnings: ReadonlyArray<ConvertWarning>;
}

/**
 * Convert a top-level Sanity schema (a block_def) into a JSON Schema.
 * The result is what we'd store in `templates_block_defs.schema`.
 */
export function sanitySchemaToJsonSchema(input: ParsedSanitySchema): ConvertResult {
  const warnings: ConvertWarning[] = [];
  const objectNode = convertObjectFields(input.fields, input.name, warnings);
  return {
    schema: {
      type: 'object',
      title: input.title,
      ...objectNode,
    },
    warnings,
  };
}

function convertObjectFields(
  fields: ReadonlyArray<ParsedSanityField>,
  path: string,
  warnings: ConvertWarning[],
): { properties: Record<string, JsonSchemaNode>; required?: string[] } {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];

  for (const field of fields) {
    const fieldPath = `${path}.${field.name}`;
    properties[field.name] = convertField(field, fieldPath, warnings);
    if (isRequired(field)) required.push(field.name);
  }

  return required.length > 0 ? { properties, required } : { properties };
}

function convertField(
  field: ParsedSanityField,
  fieldPath: string,
  warnings: ConvertWarning[],
): JsonSchemaNode {
  const node: JsonSchemaNode = {};
  if (field.title) node.title = field.title;
  if (field.description) node.description = field.description;
  if (field.group) node['x-gatewaze-group'] = field.group;
  if (field.initialValue !== undefined) node.default = field.initialValue;

  applyEnum(field, node);
  applyValidationRanges(field, node);

  switch (field.type) {
    case 'string':
      return { ...node, ...mapStringType(field) };

    case 'text':
      return { ...node, type: 'string', format: 'textarea' };

    case 'number':
      return { ...node, type: 'number' };

    case 'boolean':
      return { ...node, type: 'boolean' };

    case 'slug':
      return { ...node, type: 'string', format: 'slug' };

    case 'url':
      return { ...node, type: 'string', format: 'uri' };

    case 'email':
      return { ...node, type: 'string', format: 'email' };

    case 'image':
      // Sanity images are objects with asset + hotspot + crop + alt; we
      // collapse them into a single string URL field for now. The hotspot
      // / crop data is dropped — themes can re-author it if needed. Per
      // the AAIF deliverable §5.1 we use the host-media picker for asset
      // selection, which produces simple URLs.
      return { ...node, type: 'string', format: 'image' };

    case 'file':
      return { ...node, type: 'string', format: 'file-url' };

    case 'reference':
      return {
        ...node,
        type: 'string',
        format: refFormat(field.to),
        ...(field.to ? { 'x-aaif-ref-to': field.to } : {}),
      };

    case 'array':
      return convertArray(field, fieldPath, warnings, node);

    case 'object':
      return convertObject(field, fieldPath, warnings, node);

    case 'portableText':
    case 'block':
      // Sanity portable text → richtext. The Puck adapter already has a
      // 'richtext' custom format (TipTap-backed) — content arrives as
      // HTML, not Sanity's block array, so the importer also needs to
      // serialise portable text → HTML at content-conversion time.
      return { ...node, type: 'string', format: 'richtext' };

    case 'heading':
      // AAIF's `heading` custom object — has `text`, `type` (h1..h6),
      // `fontSize`. Flatten so the editor sees a single object with
      // those three properties.
      return {
        ...node,
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] },
          fontSize: { type: 'string', enum: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'] },
        },
        required: ['text'],
      };

    case 'cta':
      // AAIF's `cta` custom object — flatten so we get a stable shape
      // independent of the agency's custom Studio input. The full Sanity
      // shape is preserved in case a theme needs it.
      return {
        ...node,
        type: 'object',
        properties: {
          label: { type: 'string' },
          variant: { type: 'string', enum: ['default', 'secondary', 'text'] },
          type: { type: 'string', enum: ['internal', 'external', 'relative', 'email', 'phone'] },
          internal: { type: 'string', format: 'ref-page' },
          external: { type: 'string', format: 'uri' },
          relative: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string' },
          target: { type: 'string', enum: ['_self', '_blank'], default: '_self' },
        },
      };

    case 'media':
      // AAIF's `media` custom object — image + video sub-objects.
      return {
        ...node,
        type: 'object',
        properties: {
          image: {
            type: 'object',
            properties: {
              desktop: { type: 'string', format: 'image' },
              mobile: { type: 'string', format: 'image' },
              alt: { type: 'string' },
            },
          },
          video: {
            type: 'object',
            properties: {
              file: { type: 'string', format: 'file-url' },
              url: { type: 'string', format: 'uri' },
              thumbnail: { type: 'string', format: 'image' },
            },
          },
        },
      };

    case 'seo':
      return {
        ...node,
        type: 'object',
        properties: {
          metaTitle: { type: 'string' },
          metaDescription: { type: 'string', format: 'textarea' },
          canonicalUrl: { type: 'string', format: 'uri' },
          noIndex: { type: 'boolean' },
          ogImage: { type: 'string', format: 'image' },
        },
      };

    case 'personalizedBlock':
    case 'personalizedVariant':
      // These are AAIF's tier-driven personalization wrappers. We don't
      // model them as block schemas — they're decomposed at content-
      // import time into page_blocks + page_variants. The editor never
      // sees personalizedBlock; it sees the underlying block + variants.
      warnings.push({
        fieldPath,
        reason: 'personalizedBlock/variant types are decomposed into page_variants at import; not exposed as block_def fields',
      });
      return { ...node, type: 'object', 'x-aaif-source-type': field.type };

    case 'tierCondition':
      // Tier conditions live on tierDefinition documents → site_personas;
      // not surfaced inside block_defs.
      warnings.push({
        fieldPath,
        reason: 'tierCondition mapped to site_personas.conditions, not a block_def field',
      });
      return { ...node, type: 'object', 'x-aaif-source-type': 'tierCondition' };

    default:
      warnings.push({ fieldPath, reason: `unmapped Sanity type: ${field.type}` });
      return { ...node, type: 'string', 'x-aaif-source-type': field.type };
  }
}

function mapStringType(field: ParsedSanityField): JsonSchemaNode {
  // Long text rows → textarea (matches existing classifyEditorKind heuristic).
  if (field.options?.rows && field.options.rows >= 3) {
    return { type: 'string', format: 'textarea' };
  }
  return { type: 'string' };
}

function refFormat(to: ReadonlyArray<string> | undefined): string {
  if (!to || to.length === 0) return 'ref';
  if (to.length === 1) return `ref-${to[0]}`;
  // Multi-target refs (e.g. internal CTA can point to page/blog/event/...).
  return `ref-multi`;
}

function convertArray(
  field: ParsedSanityField,
  fieldPath: string,
  warnings: ConvertWarning[],
  base: JsonSchemaNode,
): JsonSchemaNode {
  const members = field.of ?? [];
  if (members.length === 0) {
    warnings.push({ fieldPath, reason: 'array with no `of` members' });
    return { ...base, type: 'array', items: { type: 'string' } };
  }

  // The common AAIF pattern: array of one anonymous-object member. Map
  // the member's fields to items.properties.
  if (members.length === 1) {
    return { ...base, type: 'array', items: convertArrayMember(members[0]!, `${fieldPath}[]`, warnings) };
  }

  // Mixed-type arrays (e.g. page.pageBuilder: [hero, faq, meetup, ...]).
  // JSON Schema can't natively express discriminated unions in a way the
  // Puck adapter consumes — Puck arrays require one item shape. We flag
  // these so the importer can decide: usually pageBuilder arrays become
  // page_blocks rows, not array items.
  warnings.push({
    fieldPath,
    reason: `heterogeneous array with ${members.length} member types — likely a page-builder array; importer handles separately`,
  });
  return {
    ...base,
    type: 'array',
    items: { type: 'object' },
    'x-aaif-source-type': 'heterogeneous-array',
  };
}

function convertArrayMember(
  member: ParsedArrayMember,
  path: string,
  warnings: ConvertWarning[],
): JsonSchemaNode {
  if (member.type === 'reference') {
    return {
      type: 'string',
      format: refFormat(member.to),
      ...(member.to ? { 'x-aaif-ref-to': member.to } : {}),
    };
  }
  if (member.type === 'block') {
    // Inside a portable-text array — but if we got here as a member, the
    // outer array is itself portable text. Fold to richtext.
    return { type: 'string', format: 'richtext' };
  }
  if (member.fields && member.fields.length > 0) {
    const obj = convertObjectFields(member.fields, path, warnings);
    return { type: 'object', ...obj };
  }
  // Bare scalar member.
  if (member.type === 'string') return { type: 'string' };
  if (member.type === 'number') return { type: 'number' };
  warnings.push({ fieldPath: path, reason: `array member type ${member.type} has no fields` });
  return { type: 'string' };
}

function convertObject(
  field: ParsedSanityField,
  fieldPath: string,
  warnings: ConvertWarning[],
  base: JsonSchemaNode,
): JsonSchemaNode {
  if (!field.fields || field.fields.length === 0) {
    warnings.push({ fieldPath, reason: 'object field with no nested fields' });
    return { ...base, type: 'object' };
  }
  const inner = convertObjectFields(field.fields, fieldPath, warnings);
  return { ...base, type: 'object', ...inner };
}

function applyEnum(field: ParsedSanityField, node: JsonSchemaNode): void {
  const list = field.options?.list;
  if (!list || list.length === 0) return;
  node.enum = list.map((opt) => opt.value);
}

function applyValidationRanges(field: ParsedSanityField, node: JsonSchemaNode): void {
  if (!field.validation) return;
  for (const rule of field.validation) {
    if (rule.kind === 'min' && rule.value !== undefined) {
      if (field.type === 'number') node.minimum = rule.value;
      else node.minLength = rule.value;
    }
    if (rule.kind === 'max' && rule.value !== undefined) {
      if (field.type === 'number') node.maximum = rule.value;
      else node.maxLength = rule.value;
    }
    if (rule.kind === 'minLength' && rule.value !== undefined) node.minLength = rule.value;
    if (rule.kind === 'maxLength' && rule.value !== undefined) node.maxLength = rule.value;
  }
}

function isRequired(field: ParsedSanityField): boolean {
  return field.validation?.some((r) => r.kind === 'required') ?? false;
}

/** Re-export for the parser to reference. */
export type { SanityFieldType };
