import { describe, expect, test } from 'vitest';
import exhaustiveModule from '../src/exhaustive-optimizer.js';
import optimizer from '../src/optimizer.js';
import scoreModule from '../src/search-score.js';

const { exhaustiveOptimize } = exhaustiveModule;
const { optimizeLoadouts, optimisticScoreForPartial } = optimizer;
const { canonicalPlanKey, comparePlanScores, scorePlan } = scoreModule;

describe('exhaustive optimizer oracle', () => {
  test('matches production on a scarce-fighter two-base optimum', () => {
    const options = {
      equipment: [
        plane('strong', { antiAir: 12, role: 'fighter' }),
        plane('medium', { antiAir: 10, role: 'fighter' }),
        plane('weak', { antiAir: 8, role: 'fighter' }),
        ...Array.from({ length: 5 }, (_, index) => plane(`attacker-${index}`, {
          antiAir: 1,
          role: 'attacker',
          torpedo: 14 - index,
        })),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 50,
      targetStates: ['parity', 'parity', 'superiority', 'superiority'],
      maxResults: 3,
      nodeBudget: Infinity,
    };

    const production = optimizeLoadouts(options);
    const exhaustive = exhaustiveOptimize(options);

    expect(resultSignatures(production)).toEqual(resultSignatures(exhaustive));
    expect(production.results[0].bases[1].loadout.filter(Boolean).map((item) => item.instanceId))
      .toContain('strong');
  });

  test('matches the exhaustive optimum when an equipment bonus changes damage order', () => {
    const options = {
      equipment: [
        plane('unbonused', { masterId: 800, torpedo: 18, role: 'attacker' }),
        plane('bonused', { masterId: 801, torpedo: 10, role: 'attacker' }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 0,
      targetStates: ['denial', 'denial'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      combatContext: {
        targetTags: ['event-test'],
        multiplierRules: [{
          id: 'event-test-bonus',
          enabled: true,
          targetTags: ['event-test'],
          equipmentMasterIds: [801],
          equipmentTypes: [],
          group: 'event-test-bonus',
          multiplier: 3,
        }],
      },
      maxResults: 1,
      nodeBudget: Infinity,
    };

    const production = optimizeLoadouts(options);
    const exhaustive = exhaustiveOptimize(options);

    expect(resultSignatures(production)).toEqual(resultSignatures(exhaustive));
    expect(production.results[0].bases[0].loadout[0].instanceId).toBe('bonused');
  });

  test('keeps explicit formula capabilities in separate equivalence groups', () => {
    const plain = plane('plain-type-54', {
      masterId: 700,
      equipType: 54,
      role: 'other',
      isPlane: false,
      isFighter: false,
      isAttacker: false,
      isLandAttacker: false,
      antiAir: 5,
      improvement: 10,
    });
    const explicitFighter = { ...plain, instanceId: 'explicit-fighter', isFighter: true };
    const options = {
      equipment: [plain, explicitFighter],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 36,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
      nodeBudget: Infinity,
    };

    const production = optimizeLoadouts(options);
    const exhaustive = exhaustiveOptimize(options);

    expect(resultSignatures(production)).toEqual(resultSignatures(exhaustive));
    expect(production.results[0].bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .toEqual(['explicit-fighter']);
  });

  test('deduplicates slot permutations and interchangeable instance IDs by counts', () => {
    const equipment = Array.from({ length: 5 }, (_, index) => plane(`equivalent-${index}`, {
      masterId: 900,
      role: 'attacker',
      torpedo: 12,
    }));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 0,
      enemyAir: 0,
      targetStates: ['none', 'none'],
      maxResults: 10,
      nodeBudget: Infinity,
    });

    expect(result.results).toHaveLength(5);
    expect(new Set(result.results.map(canonicalPlanKey)).size).toBe(5);
    expect(result.results[0].bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .toEqual(['equivalent-0', 'equivalent-1', 'equivalent-2', 'equivalent-3']);
  });

  test('uses independently fixed score and empty-plan key expectations', () => {
    expect(scorePlan({
      totalDamagePower: 50,
      totalResourceCost: 18,
      worstMargin: 7,
      scarcityCost: 2,
      canonicalKey: 'fixed-key',
    })).toEqual({
      damage: 50,
      resource: -18,
      margin: 7,
      scarcity: -2,
      canonicalKey: 'fixed-key',
    });
    expect(canonicalPlanKey({
      bases: [{ loadout: [null, null, null, null] }],
    })).toBe('[{"empty":4,"groups":[]}]');
  });

  test('reports the same target-air infeasibility as production', () => {
    const options = {
      equipment: [plane('reachable-but-weak', { antiAir: 0, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 999,
      targetStates: ['supremacy', 'supremacy'],
      maxResults: 1,
      nodeBudget: Infinity,
    };

    expect(exhaustiveOptimize(options).messages)
      .toEqual(['No loadout can satisfy the target air state.']);
    expect(exhaustiveOptimize({
      ...options,
      equipment: [plane('too-short', { antiAir: 20, radius: 2, role: 'fighter' })],
      targetRadius: 9,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
    }).messages).toEqual(['No candidate loadout can reach radius 9.']);
  });

  test('matches complete Top K scores and canonical keys on 120 seeded small inventories', () => {
    const random = seededRandom(0x5eed1234);

    for (let caseIndex = 0; caseIndex < 120; caseIndex += 1) {
      const options = randomOptions(random, caseIndex);
      const production = optimizeLoadouts({ ...options, nodeBudget: Infinity });
      const exhaustive = exhaustiveOptimize(options);

      expect({
        caseIndex,
        feasible: production.results.length > 0,
        status: production.search.status,
        signatures: resultSignatures(production),
      }).toEqual({
        caseIndex,
        feasible: exhaustive.results.length > 0,
        status: exhaustive.search.status,
        signatures: resultSignatures(exhaustive),
      });
    }
  });

  test('production optimistic bounds dominate true best completions for random partial states', () => {
    const random = seededRandom(0xb01d5);
    let compared = 0;

    for (let caseIndex = 0; caseIndex < 40; caseIndex += 1) {
      const equipment = randomEquipment(random, 5, caseIndex + 500);
      const firstBase = canonicalPartial(equipment, random);
      const options = {
        equipment,
        baseCount: 2,
        targetRadius: 5,
        enemyAir: randomInt(random, 0, 35),
        targetStates: ['denial', 'denial', 'denial', 'denial'],
        maxResults: 1,
        nodeBudget: Infinity,
      };
      const lockedBases = [
        { slots: firstBase.map((item) => ({ plane: item, locked: true })) },
        { slots: [] },
      ];
      const exhaustive = exhaustiveOptimize({ ...options, lockedBases });
      const upperBound = optimisticScoreForPartial(options, [firstBase]);

      if (!exhaustive.results.length) {
        expect(upperBound).toBeNull();
        continue;
      }

      compared += 1;
      expect(upperBound).not.toBeNull();
      expect(comparePlanScores(upperBound, scorePlan(exhaustive.results[0]))).toBeGreaterThanOrEqual(0);
    }

    expect(compared).toBeGreaterThan(5);
  });
});

/** Returns score-and-key signatures in optimizer output order. */
function resultSignatures(output) {
  return output.results.map((plan) => ({
    score: scorePlan(plan),
    key: canonicalPlanKey(plan),
  }));
}

/** Creates deterministic optimizer options with occasional locks and equivalent items. */
function randomOptions(random, caseIndex) {
  const baseCount = random() < 0.3 ? 2 : 1;
  const equipmentCount = baseCount === 2
    ? randomInt(random, 3, 5)
    : randomInt(random, 1, 6);
  const equipment = randomEquipment(random, equipmentCount, caseIndex);
  const lockedBases = Array.from({ length: baseCount }, () => ({ slots: [] }));

  if (random() < 0.25) {
    lockedBases[0].slots[0] = { plane: equipment[0], locked: true };
  }
  if (random() < 0.2) {
    lockedBases[baseCount - 1].slots[3] = { plane: null, locked: true };
  }

  return {
    equipment,
    baseCount,
    targetRadius: randomInt(random, 4, 7),
    enemyAir: randomInt(random, 0, 45),
    targetStates: Array.from(
      { length: baseCount * 2 },
      () => random() < 0.5 ? 'denial' : 'parity',
    ),
    lockedBases,
    maxResults: randomInt(random, 1, 4),
  };
}

/** Creates a small inventory with deliberate equivalence classes. */
function randomEquipment(random, count, namespace) {
  const archetypes = Array.from({ length: 3 }, (_, archetypeIndex) => {
    const role = random() < 0.45 ? 'fighter' : 'attacker';
    return {
      masterId: namespace * 10 + archetypeIndex + 1,
      antiAir: role === 'fighter' ? randomInt(random, 6, 12) : randomInt(random, 0, 4),
      radius: randomInt(random, 4, 8),
      role,
      torpedo: role === 'attacker' ? randomInt(random, 8, 15) : 0,
      improvement: randomInt(random, 0, 3),
      isFighter: role === 'fighter' || random() < 0.2,
      missing: random() < 0.08,
    };
  });

  return Array.from({ length: count }, (_, index) =>
    plane(`case-${namespace}-item-${index}`, archetypes[randomInt(random, 0, archetypes.length - 1)]));
}

/** Chooses a canonical locked first-base assignment including explicit empties. */
function canonicalPartial(equipment, random) {
  const chosen = equipment
    .filter(() => random() < 0.45)
    .slice(0, 4)
    .sort((left, right) => String(left.instanceId).localeCompare(String(right.instanceId)));
  return Array.from({ length: 4 }, (_, index) => chosen[index] || null);
}

/** Creates a deterministic pseudo-random number generator. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Returns an inclusive deterministic random integer. */
function randomInt(random, minimum, maximum) {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

/** Creates an aircraft fixture with explicit Task 1 capabilities. */
function plane(instanceId, overrides = {}) {
  const role = overrides.role ?? 'attacker';
  return {
    instanceId,
    masterId: Number(instanceId.replace(/\D/g, '')) || 1,
    name: instanceId,
    equipType: role === 'fighter' ? 48 : 47,
    iconType: 0,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 7,
    improvement: 0,
    proficiency: 0,
    scout: 0,
    isPlane: true,
    isFighter: role === 'fighter',
    isAttacker: role === 'attacker',
    isLandAttacker: role === 'attacker',
    isRecon: false,
    isLandRecon: false,
    role,
    torpedo: 0,
    bombing: 0,
    isLandBased: true,
    available: true,
    missing: false,
    ...overrides,
  };
}
