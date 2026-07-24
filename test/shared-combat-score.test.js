import { describe, expect, test } from 'vitest';
import sharedScoreModule from '../src/shared-combat-score.js';

const {
  createSharedCombatScoreBuffer,
  publishSharedCombatScore,
  readSharedCombatScore,
} = sharedScoreModule;

describe('shared combat score', () => {
  test('publishes only a lexicographically stronger sink and HP score', () => {
    const buffer = createSharedCombatScoreBuffer(SharedArrayBuffer);

    expect(readSharedCombatScore(buffer, 4)).toBeNull();
    expect(publishSharedCombatScore(buffer, { sunk: 1.5, hpDamage: 20 }, 4)).toBe(true);
    expect(publishSharedCombatScore(buffer, { sunk: 1.25, hpDamage: 100 }, 4)).toBe(false);
    expect(publishSharedCombatScore(buffer, { sunk: 1.5, hpDamage: 21 }, 4)).toBe(true);
    expect(readSharedCombatScore(buffer, 4)).toEqual({ sunk: 1.5, hpDamage: 21 });
  });

  test('skips scores whose exact numerator cannot fit without failing the proof', () => {
    const buffer = createSharedCombatScoreBuffer(SharedArrayBuffer);

    expect(publishSharedCombatScore(
      buffer,
      { sunk: 1, hpDamage: 1500000000 },
      2,
    )).toBe(false);
    expect(readSharedCombatScore(buffer, 2)).toBeNull();
  });
});
