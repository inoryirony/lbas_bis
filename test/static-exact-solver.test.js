import { describe, expect, test } from 'vitest';
import exhaustiveModule from '../src/exhaustive-optimizer.js';
import exactModule from '../src/static-exact-solver.js';
import scoreModule from '../src/search-score.js';
import optimizerModule from '../src/optimizer.js';

const { exhaustiveOptimize } = exhaustiveModule;
const {
  combineCandidateSets,
  createBaseContext,
  enumerateBase,
  featureForGroup,
  solveStaticExact,
} = exactModule;
const { scorePlan } = scoreModule;
const { prepareSearch } = optimizerModule;

describe('static exact solver', () => {
  test('reports immediate cancellation instead of proving an empty search infeasible', () => {
    const result = solveStaticExact({
      equipment: [],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    }, {
      isCancelled: () => true,
    });

    expect(result).toMatchObject({
      provenOptimal: false,
      solverStats: { status: 'cancelled', stopReason: 'cancelled' },
    });
  });

  test('visits high-damage branches early enough for the exact upper bound to prune', () => {
    const equipment = Array.from({ length: 80 }, (_, index) => plane(`ordered-${index}`, {
      masterId: 10000 + index,
      antiAir: 80 - index,
      torpedo: 1 + index * 0.2,
      radius: 80 - index,
    }));
    const prepared = prepareSearch({
      equipment,
      baseCount: 1,
      targetRadius: 0,
      enemyAir: 0,
      targetStates: ['none', 'none'],
      maxResults: 1,
    });
    const features = prepared.groups.map((group, groupIndex) =>
      featureForGroup(group, groupIndex, prepared.inventoryCounts));
    const context = createBaseContext(prepared, prepared.baseLocks[0], 0, features);
    let nodesExplored = 0;
    const work = {
      stopped: false,
      consume() {
        nodesExplored += 1;
        return true;
      },
    };

    const result = enumerateBase(context, work, { findMaximum: true });

    expect(result.maximumDamage).toBeGreaterThan(0);
    expect(nodesExplored).toBeLessThan(150000);
  });

  test('polls cancellation after proof frontiers are enumerated', () => {
    let proofFrontiers = 0;
    const result = solveStaticExact({
      equipment: [
        plane('cancel-fighter', { masterId: 91, role: 'fighter', antiAir: 12 }),
        plane('cancel-fighter-b', { masterId: 96, role: 'fighter', antiAir: 10 }),
        plane('cancel-attacker-a', { masterId: 92, torpedo: 15 }),
        plane('cancel-attacker-b', { masterId: 93, torpedo: 14 }),
        plane('cancel-attacker-c', { masterId: 94, torpedo: 13 }),
        plane('cancel-attacker-d', { masterId: 95, torpedo: 12 }),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 9,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
    }, {
      isCancelled: () => proofFrontiers >= 2,
      onProgress: (progress) => {
        if (progress.phase === 'proving_optimal') proofFrontiers += 1;
      },
    });

    expect(proofFrontiers).toBe(2);
    expect(result.provenOptimal).toBe(false);
    expect(result.solverStats).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
  });

  test('polls cancellation while skipping inventory-conflicting candidates', () => {
    const candidate = {
      pairs: [[0, 1]],
      damage: 1,
      resource: 0,
      scarcity: 0,
      margin: 0,
    };
    let stopChecks = 0;
    const work = {
      stats: { combinationsEvaluated: 0 },
      stopped: false,
      checkStop() {
        stopChecks += 1;
        if (stopChecks < 2) return true;
        this.stopped = true;
        return false;
      },
    };

    combineCandidateSets(
      [[candidate], Array.from({ length: 5000 }, () => candidate)],
      { groups: [{ instances: [{}] }] },
      work,
      null,
    );

    expect(stopChecks).toBeGreaterThanOrEqual(2);
    expect(work.stopped).toBe(true);
  });

  test('matches the exhaustive rank-1 oracle for a scarce two-base inventory', () => {
    const options = {
      equipment: [
        plane('fighter-strong', { masterId: 101, role: 'fighter', antiAir: 12 }),
        plane('fighter-medium', { masterId: 102, role: 'fighter', antiAir: 9 }),
        plane('attacker-a', { masterId: 201, torpedo: 15 }),
        plane('attacker-b', { masterId: 202, torpedo: 14 }),
        plane('attacker-c', { masterId: 203, torpedo: 13 }),
        plane('attacker-d', { masterId: 204, torpedo: 12 }),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 45,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
    };

    const oracle = exhaustiveOptimize(options);
    const exact = solveStaticExact(options);

    expect(exact.provenOptimal).toBe(true);
    expect(scorePlan(exact.plan)).toEqual(scorePlan(oracle.results[0]));
    expect(exact.plan.canonicalKey).toBe(oracle.results[0].canonicalKey);
    expect(exact.solverStats.status).toBe('optimal');
  });

  test('reserves locked equipment and preserves locked empty slots', () => {
    const locked = plane('locked-attacker', { masterId: 301, torpedo: 16 });
    const options = {
      equipment: [
        locked,
        plane('fighter', { masterId: 302, role: 'fighter', antiAir: 12 }),
        plane('attacker', { masterId: 303, torpedo: 14 }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 24,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
      lockedBases: [{ slots: [
        { plane: locked, locked: true },
        { plane: null, locked: true },
        { locked: false },
        { locked: false },
      ] }],
    };

    const oracle = exhaustiveOptimize(options);
    const exact = solveStaticExact(options);

    expect(exact.provenOptimal).toBe(true);
    expect(scorePlan(exact.plan)).toEqual(scorePlan(oracle.results[0]));
    expect(exact.plan.canonicalKey).toBe(oracle.results[0].canonicalKey);
    expect(exact.plan.bases[0].loadout[0]).toBe(locked);
    expect(exact.plan.bases[0].loadout[1]).toBeNull();
  });

  test('models land-recon air and damage coefficients with actual range extension', () => {
    const recon = plane('recon-312', {
      masterId: 312,
      equipType: 49,
      role: 'recon',
      antiAir: 6,
      scout: 8,
      radius: 9,
      isAttacker: false,
      isLandAttacker: false,
      isRecon: true,
      isLandRecon: true,
    });
    const options = {
      equipment: [
        recon,
        plane('short-strong', { masterId: 401, radius: 4, antiAir: 1, torpedo: 16 }),
        plane('long-medium', { masterId: 402, radius: 5, antiAir: 1, torpedo: 13 }),
        plane('fighter', { masterId: 403, role: 'fighter', radius: 5, antiAir: 8 }),
      ],
      baseCount: 1,
      targetRadius: 5,
      enemyAir: 25,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    };

    expectExactToMatchOracle(options);
    expect(solveStaticExact(options).plan.bases[0].loadout).toContain(recon);
    expect(solveStaticExact(options).plan.bases[0].loadout)
      .toContainEqual(expect.objectContaining({ instanceId: 'short-strong' }));
  });

  test('disables all recon extension when a blocking aircraft is locked', () => {
    const blocker = plane('blocking-patrol', {
      masterId: 501,
      equipType: 25,
      role: 'other',
      antiAir: 8,
      radius: 7,
      isAttacker: false,
      isLandAttacker: false,
      isAswPatrol: true,
      blocksRangeExtension: true,
    });
    const recon = plane('range-recon', {
      masterId: 502,
      equipType: 49,
      role: 'recon',
      scout: 7,
      radius: 9,
      isAttacker: false,
      isLandAttacker: false,
      isRecon: true,
      isLandRecon: true,
    });
    const options = {
      equipment: [
        blocker,
        recon,
        plane('short-best', { masterId: 503, radius: 4, torpedo: 18 }),
        plane('long-valid', { masterId: 504, radius: 5, torpedo: 12 }),
      ],
      baseCount: 1,
      targetRadius: 5,
      enemyAir: 0,
      targetStates: ['none', 'none'],
      maxResults: 1,
      lockedBases: [{ slots: [
        { plane: blocker, locked: true },
        { locked: false },
        { locked: false },
        { locked: false },
      ] }],
    };

    expectExactToMatchOracle(options);
    expect(solveStaticExact(options).plan.bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .not.toContain('short-best');
  });

  test('accepts a prepared search object without changing its rank-1 result', () => {
    const options = {
      equipment: [
        plane('prepared-fighter', { masterId: 601, role: 'fighter', antiAir: 10 }),
        plane('prepared-attacker', { masterId: 602, torpedo: 15 }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 20,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    };

    const fromOptions = solveStaticExact(options);
    const fromPrepared = solveStaticExact(prepareSearch(options));

    expect(fromPrepared.provenOptimal).toBe(true);
    expect(scorePlan(fromPrepared.plan)).toEqual(scorePlan(fromOptions.plan));
    expect(fromPrepared.plan.canonicalKey).toBe(fromOptions.plan.canonicalKey);
  });

  test('matches exhaustive rank-1 scores and keys on 60 seeded mixed inventories', () => {
    const random = seededRandom(0x81565);

    for (let caseIndex = 0; caseIndex < 60; caseIndex += 1) {
      const options = randomMixedOptions(random, caseIndex);
      const oracle = exhaustiveOptimize(options);
      const exact = solveStaticExact(options);

      expect({
        caseIndex,
        plan: exact.plan && scorePlan(exact.plan),
        key: exact.plan?.canonicalKey || null,
        provenOptimal: exact.provenOptimal,
      }).toEqual({
        caseIndex,
        plan: oracle.results[0] ? scorePlan(oracle.results[0]) : null,
        key: oracle.results[0]?.canonicalKey || null,
        provenOptimal: true,
      });
    }
  });

  test('proves a two-base optimum after safely removing dominated inventory groups', () => {
    const elite = Array.from({ length: 8 }, (_, index) => plane(`elite-${index}`, {
      masterId: 8000 + index,
      antiAir: 5,
      torpedo: 16,
      radius: 7,
    }));
    const distractions = Array.from({ length: 140 }, (_, index) => plane(`obsolete-${index}`, {
      masterId: 9000 + index,
      antiAir: 0,
      torpedo: 1,
      radius: 5,
    }));
    const options = {
      equipment: [...elite, ...distractions],
      baseCount: 2,
      targetRadius: 5,
      enemyAir: 45,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
    };

    const oracle = exhaustiveOptimize({ ...options, equipment: elite });
    const exact = solveStaticExact(options);

    expect(exact.provenOptimal).toBe(true);
    expect(scorePlan(exact.plan)).toEqual(scorePlan(oracle.results[0]));
    expect(exact.solverStats).toMatchObject({
      backend: 'frontier-dp',
      status: 'optimal',
      groupsRemoved: 140,
    });
  });
});

function expectExactToMatchOracle(options) {
  const oracle = exhaustiveOptimize(options);
  const exact = solveStaticExact(options);
  expect(exact.provenOptimal).toBe(true);
  expect(scorePlan(exact.plan)).toEqual(scorePlan(oracle.results[0]));
  expect(exact.plan.canonicalKey).toBe(oracle.results[0].canonicalKey);
}

function randomMixedOptions(random, caseIndex) {
  const baseCount = random() < 0.35 ? 2 : 1;
  const equipmentCount = baseCount === 2 ? randomInt(random, 5, 7) : randomInt(random, 2, 7);
  const archetypes = Array.from({ length: 4 }, (_, archetypeIndex) =>
    randomArchetype(random, caseIndex * 10 + archetypeIndex));
  const equipment = Array.from({ length: equipmentCount }, (_, itemIndex) => plane(
    `mixed-${caseIndex}-${itemIndex}`,
    archetypes[randomInt(random, 0, archetypes.length - 1)],
  ));
  const lockedBases = Array.from({ length: baseCount }, () => ({ slots: [] }));
  if (random() < 0.25) lockedBases[0].slots[0] = { plane: equipment[0], locked: true };
  if (random() < 0.25) lockedBases[baseCount - 1].slots[3] = { plane: null, locked: true };
  return {
    equipment,
    baseCount,
    targetRadius: randomInt(random, 4, 6),
    enemyAir: randomInt(random, 0, 45),
    targetStates: Array.from(
      { length: baseCount * 2 },
      () => random() < 0.5 ? 'denial' : 'parity',
    ),
    lockedBases,
    maxResults: 1,
  };
}

function randomArchetype(random, namespace) {
  const type = randomInt(random, 0, 4);
  if (type === 0) {
    return {
      masterId: 7000 + namespace,
      role: 'fighter',
      antiAir: randomInt(random, 6, 12),
      radius: randomInt(random, 4, 7),
    };
  }
  if (type === 1 || type === 2) {
    return {
      masterId: 7100 + namespace,
      role: 'attacker',
      torpedo: randomInt(random, 9, 17),
      antiAir: randomInt(random, 0, 3),
      radius: randomInt(random, 3, 7),
    };
  }
  if (type === 3) {
    const masterId = [311, 312, 480, 7200 + namespace][randomInt(random, 0, 3)];
    return {
      masterId,
      equipType: 49,
      role: 'recon',
      antiAir: randomInt(random, 0, 6),
      scout: randomInt(random, 7, 9),
      radius: randomInt(random, 7, 10),
      isAttacker: false,
      isLandAttacker: false,
      isRecon: true,
      isLandRecon: true,
    };
  }
  return {
    masterId: 7300 + namespace,
    equipType: 25,
    role: 'other',
    antiAir: randomInt(random, 0, 8),
    radius: randomInt(random, 4, 8),
    isAttacker: false,
    isLandAttacker: false,
    isAswPatrol: true,
    blocksRangeExtension: true,
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInt(random, minimum, maximum) {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function plane(instanceId, overrides = {}) {
  const role = overrides.role ?? 'attacker';
  return {
    instanceId,
    masterId: 1,
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
