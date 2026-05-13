/**
 * Shape of seed records that the converters emit + apply-seed reads.
 *
 * These match the database schema for site_personas, page_blocks,
 * page_variants, templates_block_defs as added by sites migration
 * 037 (and the existing canvas migrations).
 */

export type PersonaAxis =
  | 'persona'
  | 'utm.source'
  | 'utm.medium'
  | 'utm.campaign'
  | 'utm.term'
  | 'utm.content'
  | 'geo.country'
  | 'geo.region'
  | 'geo.city'
  | 'locale'
  | 'viewer.authenticated'
  | '*self_select'
  | (string & {});

export type PersonaOperator = 'eq' | 'in' | 'exists' | 'not_eq';

export interface PersonaCondition {
  axis: PersonaAxis;
  operator: PersonaOperator;
  value: string | boolean | null | readonly string[];
  persist: boolean;
}

export interface ConvertedPersona {
  site_id: string;
  name: string;
  label: string;
  description: string | null;
  is_default: boolean;
  priority: number;
  conditions: PersonaCondition[];
}

export interface ConvertedPageBlock {
  /** Stable id within the seed so variants can reference it. The applier
   *  preserves it as the page_blocks.id when inserting. */
  id: string;
  page_id: string;
  block_def_key: string;
  sort_order: number;
  variant_key: string;
  content: Record<string, unknown>;
}

export interface ConvertedPageBlockBrick {
  id: string;
  page_block_id: string;
  brick_def_key: string;
  sort_order: number;
  variant_key: string;
  content: Record<string, unknown>;
}

export interface ConvertedPageVariant {
  page_id: string;
  field_path: string;
  match_context: Record<string, unknown>;
  value: unknown;
  priority: number;
  persona_id: string | null;
}

export interface ConvertedPage {
  /** Stable id so blocks/variants can reference it. */
  id: string;
  site_id: string;
  slug: string;
  full_path: string;
  title: string;
  composition_mode: 'blocks';
  blocks: ConvertedPageBlock[];
  bricks: ConvertedPageBlockBrick[];
  variants: ConvertedPageVariant[];
}
