/**
 * Convert AAIF Sanity `tierDefinition` + `tierCondition` documents into
 * Gatewaze `site_personas` rows.
 *
 * Maps:
 *   tierDefinition.name             → site_personas.name (slug)
 *   tierDefinition.label            → site_personas.label
 *   tierDefinition.isDefault        → site_personas.is_default
 *   tierDefinition.order            → site_personas.priority
 *   tierDefinition.description      → site_personas.description
 *   tierDefinition.conditions[]     → site_personas.conditions
 *
 * Each Sanity tierCondition has the same shape as Gatewaze
 * personas:
 *   { axis, operator, value, persist }
 *
 * The agency uses these axes today (per audit):
 *   - persona (URL param)
 *   - utm.source / utm.medium / utm.campaign
 *   - *self_select (cookie)
 *
 * Same vocabulary as Gatewaze's `PersonaAxis` constants.
 */

import type {
  PersonaCondition,
  ConvertedPersona,
} from './seed-types.js';

export interface SanityTierDoc {
  _id: string;
  _type: 'tierDefinition';
  name: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  order?: number;
  /**
   * Conditions can be either inline tierCondition objects (when authored
   * that way) or references to tierCondition documents (less likely).
   * We accept both shapes.
   *
   * The agency authors them with `type` + `matchValue` (Sanity vocab);
   * we accept that AND the gatewaze-native `axis` + `operator` + `value`.
   */
  conditions?: ReadonlyArray<{
    _type?: string;
    _key?: string;
    // Sanity-native shape:
    type?: string;
    matchValue?: unknown;
    // Gatewaze-native shape:
    axis?: string;
    operator?: string;
    value?: unknown;
    persist?: boolean;
  }>;
}

/**
 * Map Sanity tierCondition.type values to canonical Gatewaze axes.
 * The agency uses underscored forms (`utm_source`); Gatewaze uses
 * dotted forms (`utm.source`). Anything not in this map is preserved
 * as-is and surfaces a warning.
 */
const SANITY_TYPE_TO_AXIS: Record<string, string> = {
  persona: 'persona',
  utm_source: 'utm.source',
  utm_medium: 'utm.medium',
  utm_campaign: 'utm.campaign',
  utm_term: 'utm.term',
  utm_content: 'utm.content',
  geo_country: 'geo.country',
  geo_region: 'geo.region',
  geo_city: 'geo.city',
  locale: 'locale',
  authenticated: 'viewer.authenticated',
  self_select: '*self_select',
};

export interface ConvertTierDefsArgs {
  siteId: string;
  tiers: ReadonlyArray<SanityTierDoc>;
}

export interface ConvertTierDefsResult {
  personas: ConvertedPersona[];
  /** Sanity tierDefinition _id → Gatewaze persona name. Lets the page-
   *  content converter resolve `visibleTo` refs to persona names. */
  idMap: Record<string, string>;
  warnings: ReadonlyArray<{ tierId: string; reason: string }>;
}

const KNOWN_AXES = new Set([
  'persona',
  'utm.source',
  'utm.medium',
  'utm.campaign',
  'utm.term',
  'utm.content',
  'geo.country',
  'geo.region',
  'geo.city',
  'locale',
  'viewer.authenticated',
  '*self_select',
]);

const KNOWN_OPERATORS = new Set(['eq', 'in', 'exists', 'not_eq']);

export function convertTierDefs(args: ConvertTierDefsArgs): ConvertTierDefsResult {
  const personas: ConvertedPersona[] = [];
  const idMap: Record<string, string> = {};
  const warnings: Array<{ tierId: string; reason: string }> = [];

  for (const tier of args.tiers) {
    const name = sluggify(tier.name);
    const conditions = (tier.conditions ?? [])
      .map((c, i) => normalizeCondition(c, tier._id, i, warnings))
      .filter((c): c is PersonaCondition => c !== null);

    personas.push({
      site_id: args.siteId,
      name,
      label: tier.label,
      description: tier.description ?? null,
      is_default: Boolean(tier.isDefault),
      priority: tier.order ?? 100,
      conditions,
    });
    idMap[tier._id] = name;
  }

  // Sanity allows multiple tiers with isDefault=true; Gatewaze enforces
  // a partial unique index. Warn + only keep the FIRST default.
  let defaultsSeen = 0;
  for (const p of personas) {
    if (p.is_default) {
      defaultsSeen += 1;
      if (defaultsSeen > 1) {
        warnings.push({ tierId: p.name, reason: 'multiple default tiers — clearing isDefault on this one' });
        p.is_default = false;
      }
    }
  }
  if (defaultsSeen === 0 && personas.length > 0) {
    // No default — Gatewaze allows that, but persona resolution then
    // returns null when no condition matches. Surface as a warning.
    warnings.push({ tierId: '*', reason: 'no default tier — requests matching no condition will see unresolved persona' });
  }

  return { personas, idMap, warnings };
}

function sluggify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeCondition(
  c: { type?: string; matchValue?: unknown; axis?: string; operator?: string; value?: unknown; persist?: boolean },
  tierId: string,
  index: number,
  warnings: Array<{ tierId: string; reason: string }>,
): PersonaCondition | null {
  // Accept both Sanity-native (`type` + `matchValue`) and Gatewaze-native
  // (`axis` + `operator` + `value`) shapes. Sanity-native types are
  // translated through SANITY_TYPE_TO_AXIS.
  let axis: string | undefined = c.axis;
  let value: unknown = c.value;
  if (!axis && c.type) {
    axis = SANITY_TYPE_TO_AXIS[c.type] ?? c.type;
    if (!SANITY_TYPE_TO_AXIS[c.type]) {
      warnings.push({ tierId, reason: `condition ${index}: unknown Sanity type '${c.type}' — preserved as axis` });
    }
    if (value === undefined) value = c.matchValue;
  }
  if (!axis) {
    warnings.push({ tierId, reason: `condition ${index}: missing axis (no axis or type field)` });
    return null;
  }
  if (!KNOWN_AXES.has(axis)) {
    warnings.push({ tierId, reason: `condition ${index}: unknown axis '${axis}' — preserved as-is` });
  }
  // Carry the resolved value through normalisation.
  const cn = { ...c, axis, value };
  c = cn;
  const operator = c.operator ?? 'eq';
  if (!KNOWN_OPERATORS.has(operator)) {
    warnings.push({ tierId, reason: `condition ${index}: unknown operator '${operator}' — defaulting to eq` });
  }
  // Coerce the value to the right shape per operator.
  let coercedValue: PersonaCondition['value'];
  if (operator === 'in') {
    if (Array.isArray(c.value)) {
      coercedValue = c.value.filter((v): v is string => typeof v === 'string');
    } else {
      coercedValue = [];
    }
  } else if (operator === 'exists') {
    coercedValue = null;
  } else {
    // eq / not_eq — scalar, falling back to empty string
    if (typeof c.value === 'string' || typeof c.value === 'boolean') {
      coercedValue = c.value;
    } else if (c.value === null || c.value === undefined) {
      coercedValue = c.axis === '*self_select' ? null : '';
    } else {
      coercedValue = String(c.value);
    }
  }

  return {
    axis: c.axis as string,
    operator: KNOWN_OPERATORS.has(operator) ? (operator as PersonaCondition['operator']) : 'eq',
    value: coercedValue,
    persist: Boolean(c.persist),
  };
}
