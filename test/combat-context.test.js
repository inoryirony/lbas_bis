import { describe, expect, test } from 'vitest';
import combatContext from '../src/combat-context.js';

const {
  equipmentDamageMultiplier,
  normalizeCombatContext,
  validateCombatContext,
} = combatContext;

describe('LBAS combat context', () => {
  test('normalizes tags and numeric equipment selectors without mutating input', () => {
    const input = {
      targetTags: [' boss ', 'event-e3', 'boss', ''],
      multiplierRules: [{
        id: ' rule-a ',
        label: ' Rule A ',
        enabled: true,
        targetTags: [' event-e3 ', 'event-e3'],
        equipmentMasterIds: ['301', 301, 0, 'bad'],
        equipmentTypes: ['47', 47],
        group: ' group-a ',
        multiplier: '1.18',
        source: 'automatic',
      }],
    };

    expect(normalizeCombatContext(input)).toEqual({
      targetTags: ['boss', 'event-e3'],
      multiplierRules: [{
        id: 'rule-a',
        label: 'Rule A',
        enabled: true,
        targetTags: ['event-e3'],
        equipmentMasterIds: [301],
        equipmentTypes: [47],
        group: 'group-a',
        multiplier: 1.18,
        source: 'automatic',
        overridden: false,
      }],
    });
    expect(input.targetTags[0]).toBe(' boss ');
  });

  test('takes the strongest same-group match and multiplies independent groups', () => {
    const context = normalizeCombatContext({
      targetTags: ['boss', 'event-e3'],
      multiplierRules: [
        rule('weak-a', 1.1, { group: 'a', equipmentMasterIds: [301] }),
        rule('strong-a', 1.2, { group: 'a', equipmentTypes: [47] }),
        rule('group-b', 1.15, { group: 'b', equipmentMasterIds: [301] }),
      ],
    });

    expect(equipmentDamageMultiplier({ masterId: 301, equipType: 47 }, context))
      .toBeCloseTo(1.2 * 1.15, 10);
  });

  test('requires every target tag and either equipment selector to match', () => {
    const context = normalizeCombatContext({
      targetTags: ['event-e3'],
      multiplierRules: [
        rule('wrong-target', 2, {
          targetTags: ['event-e3', 'boss'],
          equipmentMasterIds: [301],
        }),
        rule('wrong-plane', 3, { equipmentMasterIds: [999] }),
        rule('type-match', 1.25, { equipmentTypes: [47] }),
        { ...rule('disabled', 4, { equipmentMasterIds: [301] }), enabled: false },
      ],
    });

    expect(equipmentDamageMultiplier({ masterId: 301, equipType: 47 }, context)).toBe(1.25);
    expect(equipmentDamageMultiplier({ masterId: 301, equipType: 8 }, context)).toBe(1);
  });

  test('reports invalid IDs, selectors, and multipliers instead of silently applying them', () => {
    const result = validateCombatContext({
      multiplierRules: [
        rule('', 1.2, { equipmentMasterIds: [301] }),
        rule('empty-selector', 1.2),
        rule('zero', 0, { equipmentMasterIds: [301] }),
        rule('infinite', Infinity, { equipmentTypes: [47] }),
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleIndex: 0, field: 'id' }),
      expect.objectContaining({ ruleIndex: 1, field: 'equipmentSelectors' }),
      expect.objectContaining({ ruleIndex: 2, field: 'multiplier' }),
      expect.objectContaining({ ruleIndex: 3, field: 'multiplier' }),
    ]));
  });
});

function rule(id, multiplier, overrides = {}) {
  return {
    id,
    label: id,
    enabled: true,
    targetTags: ['event-e3'],
    equipmentMasterIds: [],
    equipmentTypes: [],
    group: id,
    multiplier,
    source: 'custom',
    overridden: true,
    ...overrides,
  };
}
