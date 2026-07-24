import { describe, expect, test } from 'vitest';
import combat from '../src/combat-resolution.js';

const {
  COMBAT_FORMULA,
  calculateHitAndCriticalProbabilities,
  prepareAttackSequence,
  resolveArmorDamage,
  resolveAttackSequence,
  resolvePreparedAttackSequence,
} = combat;

describe('stateful LBAS combat primitives', () => {
  test('matches the established single, combined, and B-25 avoidance tables', () => {
    const plane = attacker('ordinary', { proficiency: 0, internalProficiency: 0 });
    const b25 = attacker('b25', { masterId: 459, proficiency: 0, internalProficiency: 0 });
    const target = { type: 1, evasion: 53, luck: 70 };

    expect(calculateHitAndCriticalProbabilities(plane, target)).toMatchObject({
      hitProbability: 0.44,
      criticalProbability: 0.06,
      avoidanceMultiplier: 0.86,
    });
    expect(calculateHitAndCriticalProbabilities(plane, target, { isCombined: true }))
      .toMatchObject({ hitProbability: 0.54, avoidanceMultiplier: 0.68 });
    expect(calculateHitAndCriticalProbabilities(b25, target, { isCombined: true }))
      .toMatchObject({ hitProbability: 0.53, avoidanceMultiplier: 0.7 });
    expect(calculateHitAndCriticalProbabilities(
      b25,
      { ...target, type: 2 },
      { isCombined: true },
    )).toMatchObject({ hitProbability: 0.66, criticalProbability: 0.08 });
    expect(calculateHitAndCriticalProbabilities(
      b25,
      { ...target, type: 9 },
      { isCombined: true },
    )).toMatchObject({ hitProbability: 0.84, criticalProbability: 0.09 });
  });

  test('applies PT hit penalties and suppresses the B-25 destroyer bonus', () => {
    const pt = { type: 2, isPT: true, evasion: 0, luck: 0 };

    expect(calculateHitAndCriticalProbabilities(
      attacker('ordinary'),
      pt,
    )).toMatchObject({ hitProbability: 0.85 });
    expect(calculateHitAndCriticalProbabilities(
      attacker('b25', { masterId: 459 }),
      pt,
    )).toMatchObject({
      hitProbability: 0.76,
      targetAccuracyAdjustment: 0,
    });
    expect(calculateHitAndCriticalProbabilities(
      attacker('type-one-land-attacker', { masterId: 454 }),
      pt,
    )).toMatchObject({ hitProbability: 0.68, targetAccuracyAdjustment: -0.17 });
  });

  test('applies locked special-enemy accuracy multipliers before target adjustments', () => {
    expect(calculateHitAndCriticalProbabilities(
      attacker('ordinary'),
      { id: 1586, type: 17, evasion: 10, luck: 0 },
    )).toMatchObject({ hitProbability: 0.91 });
    expect(calculateHitAndCriticalProbabilities(
      attacker('ordinary'),
      { id: 2000, type: 9, isSummerBB: true, evasion: 10, luck: 0 },
    )).toMatchObject({ hitProbability: 0.91 });
  });

  test('resolves special-enemy post-cap power from its dedicated attack coordinate', () => {
    const target = {
      id: 'special', type: 2, hp: 1000, armor: 0, evasion: 0, luck: 0,
      fleet: 'main',
      specialAirstrikeProfile: {
        id: 'fixture', probability: 0.4, highMultiplier: 3.5, lowMultiplier: 1.7,
      },
    };
    const resolve = (specialPostCapRoll) => resolveAttackSequence({
      planes: [attacker('special-attacker')],
      ships: [target],
      random: (_attackIndex, phase) => {
        if (phase === 'special-postcap') return specialPostCapRoll;
        if (phase === 'hit') return 0.5;
        return 0;
      },
    });

    const high = resolve(0).events[0];
    const low = resolve(0.9).events[0];
    expect(high.hit).toBe(true);
    expect(low.hit).toBe(true);
    expect(high.attackPower).toBeGreaterThan(low.attackPower);
  });

  test('applies one wave contact multiplier in eventful and prepared combat', () => {
    const plane = attacker('contact-attacker', { torpedo: 14, currentSlot: 18 });
    const target = {
      id: 'contact-target', type: 2, hp: 1000, armor: 0, evasion: 0, luck: 0,
      fleet: 'main',
    };
    const random = (_attackIndex, phase) => phase === 'hit' ? 0.5 : 0;
    const eventful = resolveAttackSequence({
      planes: [plane],
      ships: [target],
      contactMultiplier: 1.2,
      random,
    });
    const prepared = prepareAttackSequence({ planes: [plane], ships: [target] });
    const numeric = resolvePreparedAttackSequence({
      prepared,
      contactMultiplier: 1.2,
      random,
      collectEvents: true,
    });

    expect(eventful.events[0].attackPower).toBe(179);
    expect(numeric.events[0].attackPower).toBe(179);
  });

  test('initializes current HP from maxHp when legacy hp is absent', () => {
    const prepared = prepareAttackSequence({
      planes: [],
      ships: [{ id: 'max-hp-only', maxHp: 50, armor: 0 }],
    });
    const hitPoints = Int32Array.from(prepared.initialHitPoints);
    const resolved = resolvePreparedAttackSequence({ prepared, hitPoints });

    expect(Array.from(prepared.initialHitPoints)).toEqual([50]);
    expect(Array.from(hitPoints)).toEqual([50]);
    expect(resolved.sunkCount).toBe(0);
  });

  test('resolves a legacy explicit attacker through the surface target domain', () => {
    const result = resolveAttackSequence({
      planes: [attacker('legacy-explicit-attacker', {
        equipType: 0,
        isAttacker: true,
        isLandAttacker: false,
        torpedo: 30,
        bombing: 30,
      })],
      ships: [{
        id: 'legacy-explicit-target',
        type: 2,
        hp: 100,
        armor: 0,
        evasion: 0,
        luck: 0,
        fleet: 'main',
      }],
      random: (_attackIndex, phase) => phase === 'hit' ? 0.5 : 0,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].attackPower).toBeGreaterThan(100);
    expect(result.totalHpDamage).toBe(100);
  });

  test('applies internal proficiency to hit, critical rate, and critical damage', () => {
    const result = calculateHitAndCriticalProbabilities(
      attacker('max-rank', { proficiency: 7, internalProficiency: 120 }),
      { type: 2, evasion: 0, luck: 0 },
    );

    expect(result.hitProbability).toBe(1);
    expect(result.criticalProbability).toBe(0.18);
    expect(result.criticalDamageMultiplier).toBe(1.8);
    expect(result.proficiencyAssumption).toBe('exact');
  });

  test('applies the ASW patrol proficiency reduction before hit and critical terms', () => {
    const result = calculateHitAndCriticalProbabilities(
      attacker('ranked-asw-patrol', {
        equipType: 26,
        bombing: 4,
        asw: 10,
        proficiency: 7,
        internalProficiency: 120,
      }),
      { type: 13, isSubmarine: true, evasion: 0, luck: 0 },
    );

    expect(result).toMatchObject({
      internalProficiency: 99,
      hitProbability: 0.99,
      criticalProbability: 0.15,
      criticalDamageMultiplier: 1.74,
    });
  });

  test('resolves armor, scratch damage, overkill capping, and sinking', () => {
    expect(resolveArmorDamage({
      attackPower: 100,
      currentHp: 100,
      armor: 100,
      armorRoll: 0,
      scratchRoll: 0,
    })).toMatchObject({
      rawDamage: 30,
      hpDamage: 30,
      remainingHp: 70,
      scratch: false,
      sunk: false,
    });
    expect(resolveArmorDamage({
      attackPower: 100,
      currentHp: 100,
      armor: 100,
      armorRoll: 0.999,
      scratchRoll: 0.999,
    })).toMatchObject({
      rawDamage: 13,
      hpDamage: 13,
      remainingHp: 87,
      scratch: true,
      sunk: false,
    });
    expect(resolveArmorDamage({
      attackPower: 100,
      criticalMultiplier: 1.8,
      currentHp: 100,
      armor: 100,
      armorRoll: 0,
      scratchRoll: 0,
    })).toMatchObject({
      rawDamage: 110,
      hpDamage: 100,
      remainingHp: 0,
      scratch: false,
      sunk: true,
    });
  });

  test('removes an early sunk target before the next aircraft selects', () => {
    const planes = [
      attacker('first', { torpedo: 100, currentSlot: 18 }),
      attacker('second', { torpedo: 100, currentSlot: 18 }),
    ];
    const result = resolveAttackSequence({
      planes,
      ships: [
        { id: 'a', type: 2, hp: 10, armor: 0, evasion: 0, luck: 0, fleet: 'main' },
        { id: 'b', type: 2, hp: 20, armor: 0, evasion: 0, luck: 0, fleet: 'main' },
      ],
      random: (_attackIndex, phase) => phase === 'hit' ? 0.5 : 0,
    });

    expect(result.events.map((event) => event.targetId)).toEqual(['a', 'b']);
    expect(result.events.every((event) => event.sunk)).toBe(true);
    expect(result.sunkCount).toBe(2);
    expect(result.totalHpDamage).toBe(30);
    expect(result.ships.map((ship) => ship.currentHp)).toEqual([0, 0]);
  });

  test('applies an explicit land-recon modifier to target attack power', () => {
    const plane = attacker('recon-boosted');
    const ship = {
      id: 'durable-dd',
      type: 2,
      hp: 1000,
      armor: 0,
      evasion: 0,
      luck: 0,
      fleet: 'main',
    };
    const resolve = (reconModifier) => resolveAttackSequence({
      planes: [plane],
      ships: [ship],
      reconModifier,
      random: (_attackIndex, phase) => phase === 'hit' ? 0.5 : 0,
    });

    expect(resolve(1).events[0]).toMatchObject({
      attackPower: 149,
      hpDamage: 149,
    });
    expect(resolve(1.15).events[0]).toMatchObject({
      attackPower: 172,
      hpDamage: 172,
    });
  });

  test('matches the eventful resolver through a reusable numeric combat core', () => {
    const planes = [
      attacker('prepared-first', { torpedo: 100, currentSlot: 18 }),
      attacker('prepared-second', { torpedo: 100, currentSlot: 17 }),
    ];
    const ships = [
      { id: 'a', type: 2, hp: 10, armor: 0, evasion: 0, luck: 0, fleet: 'main' },
      { id: 'b', type: 2, hp: 20, armor: 0, evasion: 0, luck: 0, fleet: 'main' },
    ];
    const random = (_attackIndex, phase) => phase === 'hit' ? 0.5 : 0;
    const expected = resolveAttackSequence({ planes, ships, random });
    const prepared = prepareAttackSequence({ planes, ships });
    const hitPoints = Int32Array.from(prepared.initialHitPoints);
    const actual = resolvePreparedAttackSequence({
      prepared,
      currentSlots: planes.map((plane) => plane.currentSlot),
      hitPoints,
      random,
      collectEvents: true,
    });

    expect(actual).toMatchObject({
      totalHpDamage: expected.totalHpDamage,
      sunkCount: expected.sunkCount,
      events: expected.events,
    });
    expect(Array.from(hitPoints)).toEqual(expected.ships.map((ship) => ship.currentHp));
  });

  test('does not consume an attack random coordinate for a fighter', () => {
    const fighter = attacker('non-attacking-fighter', {
      equipType: 48,
      isAttacker: false,
      role: 'fighter',
      torpedo: 0,
      bombing: 0,
    });
    const observedHitCoordinates = [];
    const result = resolveAttackSequence({
      planes: [fighter, attacker('actual-attacker', { torpedo: 100 })],
      ships: [{
        id: 'target',
        type: 2,
        hp: 100,
        armor: 0,
        evasion: 0,
        luck: 0,
        fleet: 'main',
      }],
      random: (attackIndex, phase) => {
        if (phase === 'hit') observedHitCoordinates.push(attackIndex);
        return phase === 'hit' && attackIndex > 0 ? 0.999 : 0;
      },
    });

    expect(observedHitCoordinates).toEqual([0]);
    expect(result.events[0].hit).toBe(true);
  });

  test('redirects a selected main-fleet flagship attack to an eligible protector', () => {
    const result = resolveAttackSequence({
      planes: [attacker('protected-attack', { torpedo: 100 })],
      formation: 1,
      ships: [
        {
          id: 'main-flagship',
          type: 9,
          hp: 100,
          armor: 0,
          evasion: 0,
          luck: 0,
          fleet: 'main',
          isFlagship: true,
        },
        {
          id: 'healthy-main-protector',
          type: 2,
          hp: 100,
          armor: 0,
          evasion: 0,
          luck: 0,
          fleet: 'main',
        },
        {
          id: 'exactly-three-quarters',
          type: 2,
          hp: 75,
          maxHp: 100,
          armor: 0,
          evasion: 0,
          luck: 0,
          fleet: 'main',
        },
        {
          id: 'installation',
          type: 3,
          hp: 100,
          armor: 0,
          evasion: 0,
          luck: 0,
          fleet: 'main',
          isInstallation: true,
        },
        {
          id: 'healthy-escort-protector',
          type: 2,
          hp: 100,
          armor: 0,
          evasion: 0,
          luck: 0,
          fleet: 'escort',
        },
      ],
      random: (_attackIndex, phase) => {
        if (phase === 'flagship-protector') return 0.5;
        if (phase === 'fleet' || phase === 'target' || phase === 'flagship-protection') return 0;
        return phase === 'hit' ? 0.5 : 0;
      },
    });

    expect(result.events[0].targetId).toBe('healthy-main-protector');
    expect(result.ships.find((ship) => ship.id === 'main-flagship').currentHp).toBe(100);
  });

  test('lets a Toukai attack a submarine with its dedicated ASW power draw', () => {
    const observedPhases = [];
    const result = resolveAttackSequence({
      planes: [attacker('prototype-toukai', {
        masterId: 269,
        equipType: 47,
        torpedo: 0,
        bombing: 2,
        asw: 10,
      })],
      ships: [{
        id: 'submarine',
        type: 13,
        isSubmarine: true,
        hp: 200,
        armor: 0,
        evasion: 0,
        luck: 0,
        fleet: 'main',
      }],
      random: (_attackIndex, phase) => {
        observedPhases.push(phase);
        if (phase === 'hit') return 0.5;
        return 0;
      },
    });

    expect(result.events[0]).toMatchObject({
      targetId: 'submarine',
      attackPower: 102,
      hpDamage: 102,
    });
    expect(observedPhases).toContain('asw-power');
  });

  test('prefers submarines for dual-capable planes and returns to surface targets after sinking', () => {
    const result = resolveAttackSequence({
      planes: [
        attacker('first-toukai', { masterId: 269, torpedo: 0, bombing: 2, asw: 10 }),
        attacker('second-toukai', { masterId: 269, torpedo: 0, bombing: 2, asw: 10 }),
      ],
      ships: [
        {
          id: 'surface-ship', type: 2, hp: 100, armor: 0, evasion: 0, luck: 0,
          fleet: 'main',
        },
        {
          id: 'fragile-submarine', type: 13, isSubmarine: true, hp: 1, armor: 0,
          evasion: 0, luck: 0, fleet: 'main',
        },
      ],
      random: (_attackIndex, phase) => phase === 'hit' ? 0.5 : 0,
    });

    expect(result.events.map((event) => event.targetId))
      .toEqual(['fragile-submarine', 'surface-ship']);
  });

  test('chooses a combined-fleet pool before applying submarine priority', () => {
    const resolve = (fleetRoll) => resolveAttackSequence({
      planes: [attacker('combined-toukai', {
        masterId: 269, torpedo: 0, bombing: 2, asw: 10,
      })],
      isCombined: true,
      ships: [
        {
          id: 'main-surface', type: 2, hp: 200, armor: 0, evasion: 0, luck: 0,
          fleet: 'main',
        },
        {
          id: 'escort-submarine', type: 13, isSubmarine: true, hp: 200, armor: 0,
          evasion: 0, luck: 0, fleet: 'escort',
        },
      ],
      random: (_attackIndex, phase) => {
        if (phase === 'fleet') return fleetRoll;
        return phase === 'hit' ? 0.5 : 0;
      },
    });

    expect(resolve(0).events[0].targetId).toBe('main-surface');
    expect(resolve(0.5).events[0].targetId).toBe('escort-submarine');
  });

  test('publishes empirical assumptions instead of presenting them as official', () => {
    expect(COMBAT_FORMULA).toMatchObject({
      formulaVersion: 'lbas-combat-v1',
      confidence: 'established_simulator_assumption',
    });
    expect(COMBAT_FORMULA.limitations).not.toContain('CONTACT_OMITTED');
    expect(COMBAT_FORMULA.limitations).not.toContain('FLAGSHIP_PROTECTION_OMITTED');
    expect(COMBAT_FORMULA.limitations).not.toContain('SUBMARINE_TARGETING_PARTIAL');
    expect(COMBAT_FORMULA.limitations).not.toContain('SPECIAL_ENEMY_POSTCAP_OMITTED');
  });
});

/** Creates one complete LBAS attacker fixture for combat resolution tests. */
function attacker(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: 1,
    name: instanceId,
    equipType: 47,
    isPlane: true,
    isAttacker: true,
    isLandAttacker: true,
    torpedo: 14,
    bombing: 14,
    accuracy: 0,
    improvement: 0,
    proficiency: 0,
    internalProficiency: 0,
    currentSlot: 18,
    ...overrides,
  };
}
