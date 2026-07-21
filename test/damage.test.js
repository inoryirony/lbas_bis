import { describe, expect, test } from 'vitest';
import damage from '../src/damage.js';

const {
  calculateBaseDamagePower,
  calculateBaseSurfaceTargetPowerProxy,
  calculatePlaneDamagePower,
  calculatePlaneSurfaceTargetPowerProxy,
  landBasedReconDamageModifier,
} = damage;

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

  test('applies ordinary land-based recon damage modifier to attacker power', () => {
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

    expect(power).toBe(169);
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

  test('exports explicit surface-target proxy names with compatibility aliases', () => {
    const attacker = plane('proxy-ginga', {
      equipType: 47,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 14,
    });

    expect(calculatePlaneSurfaceTargetPowerProxy(attacker)).toBe(149);
    expect(calculateBaseSurfaceTargetPowerProxy([attacker])).toBe(149);
    expect(calculatePlaneDamagePower).toBe(calculatePlaneSurfaceTargetPowerProxy);
    expect(calculateBaseDamagePower).toBe(calculateBaseSurfaceTargetPowerProxy);
  });

  test('uses 1.125 for ordinary land recon and 1.15 for skilled land recon', () => {
    expect(landBasedReconDamageModifier([{ masterId: 311 }])).toBe(1.125);
    expect(landBasedReconDamageModifier([{ masterId: 480 }])).toBe(1.125);
    expect(landBasedReconDamageModifier([{ masterId: 312 }])).toBe(1.15);
  });

  test('applies ordinary land recon before the LBAS soft cap near its threshold', () => {
    const attacker = plane('near-cap-attacker', {
      equipType: 47,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 164,
    });

    expect(calculateBaseSurfaceTargetPowerProxy(
      [attacker, plane('ordinary-recon', { masterId: 311, isAttacker: false })],
      { slotSize: 1 },
    )).toBe(396);
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
