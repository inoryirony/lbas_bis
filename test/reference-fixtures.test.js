import { describe, expect, test } from 'vitest';
import airPower from '../src/air-power.js';
import waveSimulator from '../src/wave-simulator.js';

const {
  airStateFor,
  calculateEffectiveRadius,
  defaultSlotSizeForPlane,
  internalProficiencyBounds,
} = airPower;
const { enemyStageOneLoss, playerStageOneLoss } = waveSimulator;

describe('kc-web reference fixtures', () => {
  test('uses reference LBAS slot sizes', () => {
    // kc-web src/classes/item/itemMaster.ts: airbase slot-size categories.
    expect(defaultSlotSizeForPlane({ equipType: 53 })).toBe(9);
    expect(defaultSlotSizeForPlane({ equipType: 49 })).toBe(4);
    expect(defaultSlotSizeForPlane({ equipType: 47 })).toBe(18);
  });

  test('includes every plane in the natural minimum radius', () => {
    // kc-web src/classes/airbase/airbase.ts: get radius and recon extension.
    expect(calculateEffectiveRadius([
      { equipType: 49, radius: 4 },
      { equipType: 48, radius: 8 },
    ])).toBe(4);
  });

  test('blocks range extension for a non-attacking ASW patrol plane', () => {
    // kc-web src/classes/airbase/airbase.ts: ASW patrol extension prohibition.
    expect(calculateEffectiveRadius([
      { equipType: 26, bombing: 0, radius: 3 },
      { equipType: 49, radius: 9 },
      { equipType: 48, radius: 4 },
    ])).toBe(3);
  });

  test('keeps visible proficiency as an internal range', () => {
    // kc-web src/classes/constants/items.ts: proficiency borders.
    expect(internalProficiencyBounds(0)).toEqual({ lower: 0, upper: 9 });
    expect(internalProficiencyBounds(7)).toEqual({ lower: 100, upper: 120 });
  });

  test('distinguishes an empty base from a zero-air participating plane', () => {
    // kc-web src/classes/constants/enums.ts: NONE is separate from KAKUHO.
    expect(airStateFor(0, 0, false).key).toBe('none');
    expect(airStateFor(0, 0, true).key).toBe('supremacy');
  });

  test('matches player Stage 1 boundary draws', () => {
    // kc-web src/classes/commonCalc.ts: getStage1ShootDownValue.
    expect(playerStageOneLoss('supremacy', 18, () => 0)).toBe(0);
    expect(playerStageOneLoss('supremacy', 18, () => 1 - Number.EPSILON)).toBe(1);
    expect(playerStageOneLoss('loss', 18, () => 1 - Number.EPSILON)).toBe(10);
  });

  test('matches enemy Stage 1 boundary draws', () => {
    // kc-web src/classes/commonCalc.ts: getStage1EnemyShootDownValue.
    expect(enemyStageOneLoss('supremacy', 18, () => 0)).toBe(0);
    expect(enemyStageOneLoss('supremacy', 18, () => 1 - Number.EPSILON)).toBe(18);
    expect(enemyStageOneLoss('loss', 18, () => 1 - Number.EPSILON)).toBe(1);
  });
});
