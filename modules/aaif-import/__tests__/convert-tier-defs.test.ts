import { describe, expect, it } from 'vitest';
import { convertTierDefs, type SanityTierDoc } from '../lib/convert-tier-defs.js';

const SITE_ID = 'site-aaif';

function tier(over: Partial<SanityTierDoc>): SanityTierDoc {
  return {
    _id: 'tier-1',
    _type: 'tierDefinition',
    name: 'General',
    label: 'General',
    isDefault: false,
    order: 100,
    conditions: [],
    ...over,
  };
}

describe('convertTierDefs', () => {
  it('maps name, label, description, is_default, priority', () => {
    const out = convertTierDefs({
      siteId: SITE_ID,
      tiers: [tier({
        _id: 'tier-dev',
        name: 'Developer',
        label: 'Developer audience',
        description: 'Tech-fluent builders',
        isDefault: false,
        order: 50,
      })],
    });
    expect(out.personas[0]).toMatchObject({
      site_id: SITE_ID,
      name: 'developer',
      label: 'Developer audience',
      description: 'Tech-fluent builders',
      is_default: false,
      priority: 50,
    });
  });

  it('sluggifies the tier name', () => {
    const out = convertTierDefs({
      siteId: SITE_ID,
      tiers: [tier({ name: 'Enterprise Buyer / Procurement' })],
    });
    expect(out.personas[0]?.name).toBe('enterprise-buyer-procurement');
  });

  it('normalises tierCondition shape', () => {
    const out = convertTierDefs({
      siteId: SITE_ID,
      tiers: [tier({
        _id: 'tier-1',
        conditions: [
          { axis: 'utm.source', operator: 'eq', value: 'dev-hub', persist: true },
          { axis: 'persona', operator: 'in', value: ['developer', 'enterprise'] },
        ],
      })],
    });
    expect(out.personas[0]?.conditions).toEqual([
      { axis: 'utm.source', operator: 'eq', value: 'dev-hub', persist: true },
      { axis: 'persona', operator: 'in', value: ['developer', 'enterprise'], persist: false },
    ]);
  });

  it('keeps first default tier, warns + clears later defaults', () => {
    const out = convertTierDefs({
      siteId: SITE_ID,
      tiers: [
        tier({ _id: 't1', name: 'A', isDefault: true }),
        tier({ _id: 't2', name: 'B', isDefault: true }),
      ],
    });
    expect(out.personas[0]?.is_default).toBe(true);
    expect(out.personas[1]?.is_default).toBe(false);
    expect(out.warnings.some((w) => w.reason.includes('multiple default'))).toBe(true);
  });

  it('warns when no default tier exists', () => {
    const out = convertTierDefs({
      siteId: SITE_ID,
      tiers: [tier({ isDefault: false })],
    });
    expect(out.warnings.some((w) => w.reason.includes('no default'))).toBe(true);
  });

  it('builds idMap for downstream resolution', () => {
    const out = convertTierDefs({
      siteId: SITE_ID,
      tiers: [
        tier({ _id: 'tier-general', name: 'General' }),
        tier({ _id: 'tier-dev', name: 'Developer' }),
      ],
    });
    expect(out.idMap).toEqual({
      'tier-general': 'general',
      'tier-dev': 'developer',
    });
  });

  it('coerces in-operator values to string array', () => {
    const out = convertTierDefs({
      siteId: SITE_ID,
      tiers: [tier({
        conditions: [{ axis: 'persona', operator: 'in', value: 'not-an-array' }],
      })],
    });
    expect(out.personas[0]?.conditions[0]?.value).toEqual([]);
  });

  it('warns on unknown axis but preserves it', () => {
    const out = convertTierDefs({
      siteId: SITE_ID,
      tiers: [tier({
        conditions: [{ axis: 'custom.weird-axis', operator: 'eq', value: 'x' }],
      })],
    });
    expect(out.personas[0]?.conditions[0]?.axis).toBe('custom.weird-axis');
    expect(out.warnings.some((w) => w.reason.includes('unknown axis'))).toBe(true);
  });
});
