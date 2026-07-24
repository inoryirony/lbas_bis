import { describe, expect, test } from 'vitest';
import rules from '../src/enemy-airstrike-rules.js';

const {
  decorateEnemyAirstrikeRules,
  specialAirstrikeAccuracyMultiplier,
  specialAirstrikeProfile,
} = rules;

describe('versioned enemy airstrike rules', () => {
  test('marks every locked-revision PT enemy without guessing from names or ship type', () => {
    for (const id of [1637, 1638, 1639, 1640, 2192, 2193, 2194]) {
      expect(decorateEnemyAirstrikeRules({ id })).toMatchObject({
        isPT: true,
        specialAirstrikeRuleId: 'pt',
      });
    }
    expect(decorateEnemyAirstrikeRules({ id: 2000, name: 'PT-looking DD', type: 2 }).isPT)
      .toBe(false);
  });

  test('publishes the locked special multiplier branches and provisional metadata', () => {
    expect(specialAirstrikeProfile({ id: 1653 })).toMatchObject({
      probability: 0.4,
      highMultiplier: 3.5,
      lowMultiplier: 1.7,
      confidence: 'established_simulator_assumption',
    });
    expect(specialAirstrikeProfile({ id: 1620 })).toMatchObject({
      probability: 0.35,
      highMultiplier: 3,
      lowMultiplier: 1.7,
      confidence: 'provisional_simulator_assumption',
    });
  });

  test('returns the locked special-target accuracy multipliers', () => {
    expect(specialAirstrikeAccuracyMultiplier({ id: 1586 })).toBe(1.1);
    expect(specialAirstrikeAccuracyMultiplier({ id: 1665 })).toBe(1.06);
    expect(specialAirstrikeAccuracyMultiplier({ id: 2180 })).toBe(1.15);
    expect(specialAirstrikeAccuracyMultiplier({ id: 2000, isSummerBB: true })).toBe(1.1);
    expect(specialAirstrikeAccuracyMultiplier({ id: 2000 })).toBe(1);
  });
});
