import { describe, expect, test } from 'vitest';
import damage from '../src/damage.js';

const { calculateBaseDamagePower, calculatePlaneDamagePower } = damage;

describe('LBAS damage estimates', () => {
  test('calculates anti-ship attack power for a land-based attacker', () => {
    const power = calculatePlaneDamagePower(
      plane('ginga', {
        role: 'attacker',
        isAttacker: true,
        equipType: 47,
        isLandBased: true,
        torpedo: 14,
        bombing: 14,
      }),
    );

    expect(power).toBe(149);
  });

  test('applies Type 2 land-based recon damage modifier to attacker power', () => {
    const power = calculateBaseDamagePower([
      plane('ginga', {
        role: 'attacker',
        isAttacker: true,
        equipType: 47,
        isLandBased: true,
        torpedo: 14,
        bombing: 14,
      }),
      plane('recon', {
        masterId: 311,
        role: 'recon',
        isLandBased: true,
      }),
    ]);

    expect(power).toBe(167);
  });

  test('uses the stronger anti-ship stat when torpedo and bombing differ', () => {
    const torpedoStrong = calculatePlaneDamagePower(plane('torpedo-strong', {
      role: 'attacker',
      isAttacker: true,
      isLandBased: true,
      torpedo: 14,
      bombing: 10,
    }));
    const bombingStrong = calculatePlaneDamagePower(plane('bombing-strong', {
      role: 'attacker',
      isAttacker: true,
      isLandBased: true,
      torpedo: 10,
      bombing: 14,
    }));

    expect(bombingStrong).toBe(torpedoStrong);
  });

  test('uses nine planes by default for heavy land attackers', () => {
    const heavy = plane('heavy', {
      equipType: 53,
      isAttacker: true,
      isHeavyLandAttacker: true,
      isLandBased: true,
      torpedo: 14,
      bombing: 14,
    });

    expect(calculatePlaneDamagePower(heavy)).toBe(70);
    expect(calculatePlaneDamagePower(heavy, { slotSize: 18 })).toBe(88);
    expect(calculatePlaneDamagePower({ ...heavy, currentSlot: 18 })).toBe(88);
  });

  test('preserves explicit zero current slots instead of falling back to eighteen', () => {
    const attacker = plane('empty-ginga', {
      equipType: 47,
      isAttacker: true,
      isLandBased: true,
      torpedo: 14,
    });

    expect(calculatePlaneDamagePower(attacker, { slotSize: 0 })).toBe(0);
    expect(calculatePlaneDamagePower(attacker, { currentSlot: 0 })).toBe(0);
    expect(calculatePlaneDamagePower({ ...attacker, currentSlot: 0 })).toBe(0);
  });

  test('uses the LBAS soft cap and applies the 1.8 multiplier only to type 47', () => {
    const landAttacker = plane('strong-land-attacker', {
      equipType: 47,
      isAttacker: true,
      isLandAttacker: true,
      isLandBased: true,
      torpedo: 100,
    });
    const heavy = { ...landAttacker, equipType: 53, isHeavyLandAttacker: true };

    expect(calculatePlaneDamagePower(landAttacker)).toBe(423);
    expect(calculatePlaneDamagePower(heavy, { slotSize: 18 })).toBe(236);
  });

  test('adds land-attacker torpedo improvement before the damage formula', () => {
    const attacker = plane('improved-ginga', {
      equipType: 47,
      isAttacker: true,
      isLandAttacker: true,
      isLandBased: true,
      torpedo: 14,
      improvement: 9,
    });

    expect(calculatePlaneDamagePower(attacker)).toBe(167);
  });
});

/** Creates a damage-plane fixture with stable defaults. */
function plane(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: Number(String(instanceId).replace(/\D/g, '')) || 1,
    name: instanceId,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 0,
    improvement: 0,
    proficiency: 0,
    role: 'attacker',
    torpedo: 0,
    bombing: 0,
    isLandBased: false,
    ...overrides,
  };
}
