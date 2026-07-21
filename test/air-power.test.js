import { describe, expect, test } from 'vitest';
import airPower from '../src/air-power.js';

const {
  airStateFor,
  calculateBaseAirPower,
  calculateBaseAirPowerBounds,
  calculateEffectiveRadius,
  calculateSlotAirPower,
  calculateSlotAirPowerBounds,
  defaultSlotSizeForPlane,
  internalProficiencyBounds,
} = airPower;

describe('LBAS air power formulas', () => {
  test('classifies air states from KanColle threshold borders', () => {
    expect(airStateFor(108, 36).key).toBe('supremacy');
    expect(airStateFor(54, 36).key).toBe('superiority');
    expect(airStateFor(25, 36).key).toBe('parity');
    expect(airStateFor(13, 36).key).toBe('denial');
    expect(airStateFor(12, 36).key).toBe('loss');
  });

  test('returns NONE only when both sides have zero air power and the base has no plane', () => {
    expect(airStateFor(0, 0, false).key).toBe('none');
    expect(airStateFor(0, 0, true).key).toBe('supremacy');
  });

  test('uses sortie intercept, improvement, and proficiency for one LBAS slot', () => {
    const airPowerValue = calculateSlotAirPower({
      antiAir: 11,
      intercept: 5,
      improvement: 4,
      proficiency: 7,
      equipType: 48,
      isPlane: true,
      isFighter: true,
      slotSize: 18,
    });

    expect(airPowerValue).toBe(107);
  });

  test('prefers currentSlot over an explicit slot argument and preserves zero', () => {
    const fighter = {
      antiAir: 10,
      intercept: 0,
      internalProficiency: 0,
      isPlane: true,
      isFighter: true,
      slotSize: 18,
      currentSlot: 4,
    };

    expect(calculateSlotAirPower(fighter, 1)).toBe(20);
    expect(calculateSlotAirPower({ ...fighter, currentSlot: 0 }, 18)).toBe(0);
  });

  test('ignores null slots when calculating base air power and bounds', () => {
    const fighter = {
      antiAir: 10,
      intercept: 0,
      internalProficiency: 0,
      isPlane: true,
      isFighter: true,
      slotSize: 4,
    };

    expect(calculateBaseAirPower([null, fighter, null])).toBe(20);
    expect(calculateBaseAirPowerBounds([null, fighter, null])).toEqual({ lower: 20, upper: 20 });
  });

  test('provides bounds when only visible proficiency is known', () => {
    const ginga = {
      antiAir: 3,
      intercept: 0,
      improvement: 0,
      proficiency: 7,
      equipType: 47,
      isPlane: true,
      isAttacker: true,
      slotSize: 18,
    };

    expect(calculateSlotAirPower(ginga)).toBe(15);
    expect(calculateSlotAirPowerBounds(ginga)).toEqual({ lower: 15, upper: 16 });
    expect(calculateSlotAirPower({ ...ginga, internalProficiency: 120 })).toBe(16);
    expect(calculateSlotAirPowerBounds({ ...ginga, internalProficiency: 120 }))
      .toEqual({ lower: 16, upper: 16 });
    expect(calculateSlotAirPowerBounds({ ...ginga, internalProficiency: Number.NaN }))
      .toEqual({ lower: 15, upper: 16 });
    expect(calculateSlotAirPowerBounds({ ...ginga, internalProficiency: Number.POSITIVE_INFINITY }))
      .toEqual({ lower: 15, upper: 16 });
    expect(calculateSlotAirPowerBounds({ ...ginga, internalProficiency: 0 }))
      .toEqual({ lower: 12, upper: 12 });
    expect(calculateBaseAirPower([ginga, ginga, ginga, ginga])).toBe(60);
    expect(airStateFor(calculateBaseAirPower([ginga, ginga, ginga, ginga]), 72).key).toBe('parity');
  });

  test('sums per-slot proficiency bounds before applying the best land recon coefficient', () => {
    const loadout = [
      {
        equipType: 48,
        isPlane: true,
        isFighter: true,
        antiAir: 1,
        intercept: 0,
        improvement: 0,
        proficiency: 6,
        slotSize: 1,
      },
      {
        equipType: 47,
        isPlane: true,
        isAttacker: true,
        antiAir: 1,
        intercept: 0,
        improvement: 0,
        proficiency: 6,
        slotSize: 4,
      },
      {
        equipType: 49,
        isPlane: true,
        isRecon: true,
        isLandRecon: true,
        scout: 8,
        antiAir: 1,
        intercept: 0,
        improvement: 0,
        proficiency: 0,
        slotSize: 4,
      },
    ];

    expect(calculateBaseAirPowerBounds(loadout)).toEqual({ lower: 26, upper: 28 });
    expect(calculateBaseAirPower(loadout)).toBe(26);
  });

  test('maps visible proficiency to the kc-web internal lower and upper bounds', () => {
    expect(internalProficiencyBounds(0)).toEqual({ lower: 0, upper: 9 });
    expect(internalProficiencyBounds(6)).toEqual({ lower: 85, upper: 99 });
    expect(internalProficiencyBounds(7)).toEqual({ lower: 100, upper: 120 });
  });

  test('gives ASW patrol planes fighter proficiency bonuses unless anti-air is zero', () => {
    const patrol = {
      antiAir: 2,
      intercept: 0,
      improvement: 0,
      internalProficiency: 100,
      equipType: 26,
      isPlane: true,
      isAswPatrol: true,
      slotSize: 1,
    };

    expect(calculateSlotAirPower(patrol)).toBe(27);
    expect(calculateSlotAirPower({ ...patrol, antiAir: 0 })).toBe(0);
  });

  test('uses four planes for land recon slots when calculating air power', () => {
    const recon = {
      masterId: 311,
      antiAir: 3,
      intercept: 0,
      improvement: 0,
      proficiency: 0,
      equipType: 49,
      isPlane: true,
      isRecon: true,
      isLandRecon: true,
    };

    expect(calculateSlotAirPower(recon)).toBe(6);
    expect(calculateBaseAirPower([recon])).toBe(6);
  });

  test('applies land recon coefficient and range extension to a base loadout', () => {
    const loadout = [
      plane('fighter-1', { antiAir: 10, radius: 4, equipType: 48, isFighter: true }),
      plane('fighter-2', { antiAir: 10, radius: 4, equipType: 48, isFighter: true }),
      plane('attacker-1', { antiAir: 3, radius: 8, equipType: 47, isAttacker: true }),
      plane('recon', {
        masterId: 311,
        antiAir: 3,
        radius: 8,
        equipType: 49,
        scout: 8,
        isRecon: true,
        isLandRecon: true,
      }),
    ];

    expect(calculateEffectiveRadius(loadout)).toBe(6);
    expect(calculateBaseAirPower(loadout)).toBe(117);
  });

  test('derives land recon air-power coefficients from type and scout', () => {
    const recon = {
      masterId: 999,
      equipType: 49,
      isPlane: true,
      isRecon: true,
      isLandRecon: true,
      antiAir: 25,
      intercept: 0,
      improvement: 0,
      internalProficiency: 0,
    };

    expect(calculateBaseAirPower([{ ...recon, scout: 8 }])).toBe(57);
    expect(calculateBaseAirPower([{ ...recon, scout: 9 }])).toBe(59);
    expect(calculateBaseAirPower([{ ...recon, scout: 7 }])).toBe(50);
  });

  test('uses every plane for base range and extends only from a longer recon plane', () => {
    const shortRecon = plane('short-recon', { radius: 4, isRecon: true });
    const longFighter = plane('long-fighter', { radius: 8, isFighter: true });
    const longRecon = plane('long-recon', { radius: 8, isRecon: true });
    const shortFighter = plane('short-fighter', { radius: 4, isFighter: true });

    expect(calculateEffectiveRadius([shortRecon, longFighter])).toBe(4);
    expect(calculateEffectiveRadius([longRecon, shortFighter])).toBe(6);
  });

  test('disables recon range extension for a non-attacking ASW patrol plane', () => {
    const loadout = [
      plane('long-recon', { radius: 8, isRecon: true }),
      plane('short-fighter', { radius: 4, isFighter: true }),
      plane('asw-patrol', { radius: 5, isAswPatrol: true, blocksRangeExtension: true }),
    ];

    expect(calculateEffectiveRadius(loadout)).toBe(4);
  });

  test('uses capability-based default LBAS slot sizes', () => {
    expect(defaultSlotSizeForPlane({ isRecon: true })).toBe(4);
    expect(defaultSlotSizeForPlane({ isHeavyLandAttacker: true })).toBe(9);
    expect(defaultSlotSizeForPlane({ isPlane: true })).toBe(18);
  });

  test('applies kc-web aircraft improvement air-power rules', () => {
    const cases = /** @type {Array<[Record<string, any>, number]>} */ ([
      [{ masterId: 486, improvement: 10 }, 6],
      [{ isFighter: true, improvement: 10 }, 4],
      [{ equipType: 7, isBakusen: true, improvement: 10 }, 5],
      [{ isLandAttacker: true, improvement: 9 }, 3],
      [{ equipType: 49, isLandRecon: true, improvement: 10 }, 4],
      [{ equipType: 41, isRecon: true, improvement: 10 }, 3],
    ]);

    for (const [capabilities, expected] of cases) {
      expect(calculateSlotAirPower({
        antiAir: 0,
        intercept: 0,
        proficiency: 0,
        internalProficiency: 0,
        slotSize: 4,
        ...capabilities,
      })).toBe(expected);
    }
  });
});

/** Creates a plane fixture with stable defaults. */
function plane(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: Number(instanceId.replace(/\D/g, '')) || 1,
    name: instanceId,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 0,
    improvement: 0,
    proficiency: 0,
    isPlane: true,
    role: 'attacker',
    torpedo: 0,
    bombing: 0,
    ...overrides,
  };
}
