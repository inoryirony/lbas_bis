import { describe, expect, test } from 'vitest';
import catalogModule from '../src/event-multiplier-catalog.js';

const {
  resolveEventCombatContext,
  validateEventMultiplierCatalog,
} = catalogModule;

describe('event multiplier catalog', () => {
  test('resolves an exact map selector while preserving a custom override', () => {
    const catalog = {
      version: 1,
      entries: [{
        id: 'event-2026-e3-z-final',
        selectors: [{ area: 623, node: 'Z', difficulty: 4, formationIndex: 0 }],
        targetTags: ['event-2026-e3', 'boss'],
        source: {
          name: 'community verification fixture',
          url: 'https://example.invalid/event-2026-e3',
          revision: 'fixture-r1',
          checkedAt: '2026-07-23',
        },
        multiplierRules: [automaticRule('event-e3-group-a', 1.18)],
      }],
    };
    const existing = {
      targetTags: ['manual-tag'],
      multiplierRules: [{
        ...automaticRule('event-e3-group-a', 1.25),
        source: 'custom',
        overridden: true,
      }],
    };

    const result = resolveEventCombatContext(
      { area: 623, node: 'Z', difficulty: 4, formationIndex: 0 },
      existing,
      catalog,
    );

    expect(result.valid).toBe(true);
    expect(result.matchedEntryIds).toEqual(['event-2026-e3-z-final']);
    expect(result.context.targetTags).toEqual(['manual-tag', 'event-2026-e3', 'boss']);
    expect(result.context.multiplierRules).toHaveLength(1);
    expect(result.context.multiplierRules[0]).toMatchObject({
      id: 'event-e3-group-a',
      multiplier: 1.25,
      source: 'custom',
      overridden: true,
    });
  });

  test('does not apply a rule to a different formation or difficulty', () => {
    const catalog = {
      version: 1,
      entries: [{
        id: 'specific',
        selectors: [{ area: 623, node: 'Z', difficulty: 4, formationIndex: 0 }],
        targetTags: ['specific-target'],
        source: validSource(),
        multiplierRules: [automaticRule('specific-rule', 1.2)],
      }],
    };

    const result = resolveEventCombatContext(
      { area: 623, node: 'Z', difficulty: 3, formationIndex: 0 },
      { targetTags: ['existing'] },
      catalog,
    );

    expect(result.valid).toBe(true);
    expect(result.matchedEntryIds).toEqual([]);
    expect(result.context.targetTags).toEqual(['existing']);
    expect(result.context.multiplierRules).toEqual([]);
  });

  test('keeps automatic rule source metadata inspectable in the resolved context', () => {
    const source = validSource();
    const result = resolveEventCombatContext(
      { area: 623, node: 'Z', difficulty: 4, formationIndex: 0 },
      {},
      {
        version: 1,
        entries: [{
          id: 'source-entry',
          selectors: [{ area: 623, node: 'Z', difficulty: 4, formationIndex: 0 }],
          targetTags: ['event-2026-e3'],
          source,
          multiplierRules: [automaticRule('source-rule', 1.2)],
        }],
      },
    );

    expect(result.context.multiplierRules[0]).toMatchObject({
      source: 'automatic',
      overridden: false,
      catalogEntryId: 'source-entry',
      catalogSource: source,
    });
  });

  test('removes stale automatic tags and rules when the map no longer matches', () => {
    const result = resolveEventCombatContext(
      { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
      {
        targetTags: ['manual-tag', 'old-event'],
        automaticTargetTags: ['old-event'],
        multiplierRules: [{
          ...automaticRule('old-rule', 1.2),
          catalogEntryId: 'old-entry',
          catalogSource: validSource(),
        }],
      },
      { version: 1, entries: [] },
    );

    expect(result.context.targetTags).toEqual(['manual-tag']);
    expect(result.context.multiplierRules).toEqual([]);
    expect(result.context.automaticTargetTags).toEqual([]);
  });

  test('rejects malformed map selectors and missing source metadata', () => {
    const result = validateEventMultiplierCatalog({
      version: 1,
      entries: [{
        id: 'broken',
        selectors: [{ area: '623x', node: '', difficulty: -1, formationIndex: 0 }],
        targetTags: ['boss'],
        source: {},
        multiplierRules: [automaticRule('rule', 1.2)],
      }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'selectors' }),
      expect.objectContaining({ field: 'source' }),
    ]));
  });
});

/** Builds one valid automatic multiplier rule for catalog tests. */
function automaticRule(id, multiplier) {
  return {
    id,
    label: id,
    enabled: true,
    targetTags: ['event-2026-e3'],
    equipmentMasterIds: [301],
    equipmentTypes: [],
    group: id,
    multiplier,
    source: 'automatic',
    overridden: false,
  };
}

/** Builds complete inspectable source metadata for catalog tests. */
function validSource() {
  return {
    name: 'fixture',
    url: 'https://example.invalid/fixture',
    revision: 'r1',
    checkedAt: '2026-07-23',
  };
}
