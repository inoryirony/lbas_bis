import { describe, expect, test } from 'vitest';
import damage from '../src/damage.js';

const {
  calculateBaseDamagePower,
  calculateBaseSurfaceTargetPowerProxy,
  calculatePlaneDamagePower,
  calculatePlaneSurfaceTargetPowerProxy,
  calculatePlaneTargetAttackPower,
  landBasedReconDamageModifier,
  TARGET_POWER_FORMULA,
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

  test('combines matching equipment damage multipliers before the final post-cap floor', () => {
    const attacker = plane('bonus-ginga', {
      masterId: 301,
      role: 'attacker',
      isAttacker: true,
      equipType: 47,
      isLandBased: true,
      torpedo: 14,
      bombing: 14,
    });

    const power = calculatePlaneDamagePower(attacker, {
      combatContext: {
        targetTags: ['event-e3'],
        multiplierRules: [{
          id: 'event-e3-a',
          enabled: true,
          targetTags: ['event-e3'],
          equipmentMasterIds: [301],
          equipmentTypes: [],
          group: 'event-e3-a',
          multiplier: 1.5,
        }],
      },
    });

    expect(power).toBe(224);
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

  test('uses the normal surface formula for an explicit surface-only capability', () => {
    const custom = plane('explicit-surface-capability', {
      equipType: 0,
      isAttacker: false,
      canAttackSurface: true,
      torpedo: 30,
      bombing: 30,
    });

    expect(calculatePlaneSurfaceTargetPowerProxy(custom)).toBeGreaterThan(100);
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

  test('uses bombing against land targets and 65th Sentai torpedo 25 against destroyers', () => {
    const ordinary = plane('ordinary-land-attacker', {
      masterId: 999,
      equipType: 47,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 20,
      bombing: 5,
    });
    const sentai65 = plane('65th-sentai', {
      masterId: 224,
      equipType: 47,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 9,
      bombing: 6,
    });

    expect(calculatePlaneTargetAttackPower(ordinary, { type: 2 }, { slotSize: 1 })).toBe(73);
    expect(calculatePlaneTargetAttackPower(
      ordinary,
      { type: 17, speed: 0, isLand: true },
      { slotSize: 1 },
    )).toBe(45);
    expect(calculatePlaneTargetAttackPower(sentai65, { type: 2 }, { slotSize: 1 })).toBe(82);
    expect(calculatePlaneTargetAttackPower(sentai65, { type: 3 }, { slotSize: 1 })).toBe(52);
  });

  test('matches established B-25 and guided-weapon target matrices before armor', () => {
    const b25 = plane('b25', {
      masterId: 459,
      equipType: 47,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 10,
      bombing: 10,
    });
    const hs293 = { ...b25, masterId: 405 };
    const fritzX = { ...b25, masterId: 406 };
    const guidedTypeA = { ...b25, masterId: 444 };

    expect(calculatePlaneTargetAttackPower(b25, { type: 2 }, { slotSize: 1 })).toBe(104);
    expect(calculatePlaneTargetAttackPower(b25, { type: 3 }, { slotSize: 1 })).toBe(95);
    expect(calculatePlaneTargetAttackPower(b25, { type: 5 }, { slotSize: 1 })).toBe(88);
    expect(calculatePlaneTargetAttackPower(b25, { type: 9 }, { slotSize: 1 })).toBe(70);
    expect(calculatePlaneTargetAttackPower(
      b25,
      { type: 17, speed: 0, isLand: true },
      { slotSize: 1 },
    )).toBe(48);
    expect(calculatePlaneTargetAttackPower(hs293, { type: 2 }, { slotSize: 1 })).toBe(55);
    expect(calculatePlaneTargetAttackPower(fritzX, { type: 9 }, { slotSize: 1 })).toBe(64);
    expect(calculatePlaneTargetAttackPower(guidedTypeA, { type: 2 }, { slotSize: 18 })).toBe(129);
    expect(calculatePlaneTargetAttackPower(guidedTypeA, { type: 11 }, { slotSize: 18 })).toBe(127);
  });

  test('uses the randomized LBAS ASW formula for submarine targets', () => {
    const toukai = plane('prototype-toukai', {
      masterId: 269,
      equipType: 47,
      bombing: 2,
      torpedo: 0,
      asw: 10,
    });
    const patrol = plane('asw-nine', {
      masterId: 900,
      equipType: 26,
      bombing: 0,
      torpedo: 0,
      asw: 9,
    });
    const submarine = { type: 13, isSubmarine: true };

    expect(calculatePlaneTargetAttackPower(
      toukai,
      submarine,
      { slotSize: 18, aswPowerRoll: 0 },
    )).toBe(102);
    expect(calculatePlaneTargetAttackPower(
      toukai,
      submarine,
      { slotSize: 18, aswPowerRoll: 1 },
    )).toBe(145);
    expect(calculatePlaneTargetAttackPower(
      patrol,
      submarine,
      { slotSize: 18, aswPowerRoll: 0 },
    )).toBe(26);
    expect(calculatePlaneTargetAttackPower(
      patrol,
      submarine,
      { slotSize: 18, aswPowerRoll: 1 },
    )).toBe(60);
  });

  test('retains the type-47 base strike when its surface torpedo stat is zero', () => {
    expect(calculatePlaneTargetAttackPower(plane('zero-torpedo-toukai', {
      masterId: 269,
      equipType: 47,
      bombing: 2,
      torpedo: 0,
      asw: 10,
    }), { type: 2 }, { slotSize: 18 })).toBe(36);
  });

  test('applies the enemy combined-fleet post-cap modifier to LBAS attacks', () => {
    const ginga = plane('combined-ginga', {
      masterId: 187,
      equipType: 47,
      torpedo: 14,
      bombing: 14,
      asw: 3,
    });

    expect(calculatePlaneTargetAttackPower(
      ginga,
      { type: 2 },
      { slotSize: 18, isCombined: true },
    )).toBe(164);
  });

  test('combines contact with every post-cap multiplier before one final floor', () => {
    const ginga = plane('contact-ginga', {
      masterId: 187,
      equipType: 47,
      torpedo: 14,
      bombing: 14,
      asw: 10,
    });

    expect(calculatePlaneTargetAttackPower(
      ginga,
      { type: 2 },
      { slotSize: 18, contactMultiplier: 1.2 },
    )).toBe(179);
    expect(calculatePlaneTargetAttackPower(
      ginga,
      { id: 1637, type: 2, isPT: true },
      { slotSize: 18, contactMultiplier: 1.2, specialPostCapRoll: 0 },
    )).toBe(125);
    expect(calculatePlaneTargetAttackPower(
      ginga,
      { type: 2 },
      { slotSize: 18, contactMultiplier: 1.2, isCombined: true },
    )).toBe(197);
    expect(calculatePlaneTargetAttackPower(
      ginga,
      { type: 13, isSubmarine: true },
      { slotSize: 18, contactMultiplier: 1.2, aswPowerRoll: 1 },
    )).toBe(174);
  });

  test('applies deterministic PT and special-enemy post-cap branches', () => {
    const ginga = plane('special-target-ginga', {
      masterId: 187,
      equipType: 47,
      torpedo: 14,
      bombing: 14,
    });

    expect(calculatePlaneTargetAttackPower(
      ginga,
      { id: 1637, type: 2, isPT: true },
      { slotSize: 18, specialPostCapRoll: 0 },
    )).toBe(104);
    expect(calculatePlaneTargetAttackPower(
      ginga,
      { id: 1637, type: 2, isPT: true },
      { slotSize: 18, specialPostCapRoll: 0.4 },
    )).toBe(59);
    expect(calculatePlaneTargetAttackPower(
      ginga,
      { id: 1653, type: 17 },
      { slotSize: 18, specialPostCapRoll: 0 },
    )).toBe(522);
    expect(calculatePlaneTargetAttackPower(
      ginga,
      { id: 1653, type: 17 },
      { slotSize: 18, specialPostCapRoll: 0, isCombined: true },
    )).toBe(575);
  });

  test('publishes source revisions and keeps disputed target formulas unresolved', () => {
    expect(TARGET_POWER_FORMULA).toMatchObject({
      formulaVersion: 'lbas-target-power-v1',
      confidence: 'established_simulator_assumption',
      sources: [
        expect.objectContaining({ repository: 'noro6/kc-web', revision: 'd490a8411c92669ecbd258bb7c47af392402ea99' }),
        expect.objectContaining({ repository: 'KC3Kai/kancolle-replay', revision: 'ec3094c5ba57e289d2716a75ab5f4dee31f1b07f' }),
      ],
    });
    expect(TARGET_POWER_FORMULA.unresolved).toEqual(expect.arrayContaining([
      'type53AirstrikeModifier',
      'master484TargetAdjustment',
      'master454CvlBranch',
      'master562BattleshipAdjustment',
    ]));
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
