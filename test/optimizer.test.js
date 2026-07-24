import { describe, expect, test } from 'vitest';
import combatExactSolverModule from '../src/combat-exact-solver.js';
import combatFrontierSolverModule from '../src/combat-frontier-solver.js';
import optimizer from '../src/optimizer.js';
import scoreModule from '../src/search-score.js';

const { solveCombatExact } = combatExactSolverModule;
const {
  combatTransitionKey,
  maximumCoordinateAssignment,
  possibleAttackCoordinates,
} = combatFrontierSolverModule;
const { buildStaticSeedCandidates, optimizeLoadouts, prepareSearch } = optimizer;
const { compareCombatPlanScores, comparePlansForSort } = scoreModule;

describe('LBAS optimizer MVP', () => {
  test.each([
    { baseCount: 1, backend: 'combat-grouped-exhaustive' },
    { baseCount: 2, backend: 'combat-frontier' },
  ])('matches exhaustive combat ranking for special enemies with $baseCount base(s)', ({
    baseCount,
    backend,
  }) => {
    const equipment = [
      plane('special-oracle-ginga', {
        masterId: 187, equipType: 47, torpedo: 14, bombing: 14, accuracy: 0,
        radius: 7, role: 'attacker',
      }),
      plane('special-oracle-b25', {
        masterId: 459, equipType: 47, torpedo: 10, bombing: 10, accuracy: 3,
        radius: 7, role: 'attacker',
      }),
      plane('special-oracle-patrol', {
        masterId: 900, equipType: 26, bombing: 20, accuracy: 1,
        radius: 7, role: 'attacker',
      }),
    ];
    const enemy = combatEnemy();
    enemy.ships[0] = {
      ...enemy.ships[0],
      id: '1653',
      hp: 1000,
      currentHp: 1000,
    };
    const common = {
      equipment,
      baseCount,
      targetRadius: 7,
      enemy,
      targetStates: Array.from({ length: baseCount * 2 }, () => 'loss'),
      simulationOptions: {
        sampleCount: 8,
        seed: `special-bound-oracle-${baseCount}`,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };
    const production = optimizeLoadouts({
      ...common,
      lockedBases: Array.from({ length: baseCount }, () => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
    });
    const assignments = baseCount === 1
      ? equipment.map((item) => [item])
      : equipment.flatMap((first) => equipment
        .filter((second) => second !== first)
        .map((second) => [first, second]));
    const exhaustive = assignments.flatMap((assignment) => optimizeLoadouts({
      ...common,
      lockedBases: assignment.map((item) => ({ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
    }).results).sort((left, right) => -compareCombatPlanScores(left, right));

    expect(production.search).toMatchObject({ backend, status: 'optimal', provenOptimal: true });
    expect(production.results[0].canonicalKey).toBe(exhaustive[0].canonicalKey);
  });

  test('keeps explicit combat capabilities distinct in the two-base frontier', () => {
    const fixed = plane('explicit-capability-fixed', {
      masterId: 9901,
      radius: 7,
      antiAir: 1,
      role: 'fighter',
    });
    const misses = plane('explicit-capability-misses', {
      masterId: 9902,
      equipType: 0,
      radius: 7,
      torpedo: 30,
      accuracy: -100,
      role: 'attacker',
      isAttacker: false,
      isLandAttacker: false,
      canAttackSurface: true,
    });
    const hits = plane('explicit-capability-hits', {
      masterId: 9903,
      equipType: 0,
      radius: 7,
      torpedo: 20,
      accuracy: 100,
      role: 'attacker',
      isAttacker: false,
      isLandAttacker: false,
      canAttackSurface: true,
    });
    const enemy = combatEnemy();
    delete enemy.ships[0].hp;
    delete enemy.ships[0].currentHp;
    enemy.ships[0] = {
      ...enemy.ships[0],
      maxHp: 100,
      evasion: 1000,
    };

    const result = optimizeLoadouts({
      equipment: [fixed, misses, hits],
      baseCount: 2,
      targetRadius: 7,
      enemy,
      targetStates: ['loss', 'loss', 'loss', 'loss'],
      lockedBases: [
        { slots: [
          { plane: fixed, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
        { slots: [
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
      ],
      simulationOptions: {
        sampleCount: 1,
        fixedRandom: (_sample, _wave, side) => side === 'combat-hit' ? 0.5 : 0,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({
      backend: 'combat-frontier',
      status: 'optimal',
      provenOptimal: true,
    });
    expect(result.results[0].bases[1].loadout[0].instanceId)
      .toBe('explicit-capability-hits');
    expect(result.results[0].simulation.expectedHpDamage).toBeGreaterThan(0);
  });

  test.each([
    ['not finite', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['fractional', 1.5],
    ['negative', -1],
    ['above maximum HP', 101],
    ['outside Int32 storage', 2147483648],
  ])('rejects current HP that is $0', (_label, currentHp) => {
    const enemy = combatEnemy();
    enemy.ships[0] = {
      ...enemy.ships[0],
      hp: undefined,
      maxHp: currentHp === 2147483648 ? currentHp : 100,
      currentHp,
    };

    const prepared = prepareSearch({
      equipment: [plane('invalid-current-hp', { radius: 7 })],
      baseCount: 1,
      targetRadius: 7,
      enemy,
      targetStates: ['loss', 'loss'],
      simulationOptions: { sampleCount: 1, seed: 'invalid-current-hp' },
      optimizationObjective: 'combat',
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(prepared.valid).toBe(false);
    expect(prepared.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_ENEMY_HIT_POINTS' }),
    ]));
  });

  test('matches exhaustive ranking for a pure ASW combat attacker in the suffix base', () => {
    const prefixFighter = plane('asw-prefix-fighter', {
      masterId: 9001,
      equipType: 48,
      radius: 7,
      role: 'fighter',
    });
    const weakToukai = plane('weak-toukai', {
      masterId: 269,
      equipType: 47,
      radius: 7,
      torpedo: 0,
      bombing: 2,
      asw: 3,
      role: 'attacker',
    });
    const strongAswOnly = plane('strong-asw-only', {
      masterId: 603,
      equipType: 25,
      radius: 7,
      torpedo: 0,
      bombing: 0,
      asw: 20,
      role: 'asw',
      isAttacker: false,
      isLandAttacker: false,
      isLbasCombatAttacker: true,
      canAttackSubmarine: true,
    });
    const enemy = combatEnemy();
    enemy.ships[0] = {
      ...enemy.ships[0],
      id: 'asw-oracle-submarine',
      hp: 200,
      currentHp: 200,
      type: 13,
      isSubmarine: true,
    };
    const common = {
      equipment: [prefixFighter, weakToukai, strongAswOnly],
      baseCount: 2,
      targetRadius: 7,
      enemy,
      targetStates: ['loss', 'loss', 'loss', 'loss'],
      simulationOptions: { sampleCount: 1, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };
    const prefixBase = { slots: [
      { plane: prefixFighter, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
    ] };
    const openSuffix = { slots: [
      { locked: false },
      { plane: null, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
    ] };
    const production = optimizeLoadouts({
      ...common,
      lockedBases: [prefixBase, openSuffix],
    });
    const exhaustive = [weakToukai, strongAswOnly].flatMap((item) => optimizeLoadouts({
      ...common,
      lockedBases: [prefixBase, { slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort((left, right) => -compareCombatPlanScores(left, right));
    expect(production.search).toMatchObject({
      backend: 'combat-frontier', status: 'optimal', provenOptimal: true,
    });
    expect(production.results[0].canonicalKey).toBe(exhaustive[0].canonicalKey);
    expect(exhaustive[0].bases[1].loadout[0].instanceId).toBe('strong-asw-only');
  });

  test('does not split a combat transition between equivalent fighter instances', () => {
    const attacker = plane('transition-key-attacker', {
      masterId: 500,
      antiAir: 0,
      torpedo: 16,
      role: 'attacker',
    });
    const fighterBefore = plane('transition-key-fighter-before', {
      masterId: 100,
      antiAir: 12,
      role: 'fighter',
    });
    const fighterAfter = plane('transition-key-fighter-after', {
      masterId: 101,
      antiAir: 12,
      role: 'fighter',
    });

    expect(combatTransitionKey([attacker, fighterBefore], 'before'))
      .toBe(combatTransitionKey([attacker, fighterAfter], 'after'));
  });

  test('splits equal initial air power when fighter slot continuation differs', () => {
    const onePlaneFighter = plane('transition-key-one-plane-fighter', {
      masterId: 101,
      antiAir: 1,
      currentSlot: 1,
      role: 'fighter',
    });
    const twoPlaneFighter = plane('transition-key-two-plane-fighter', {
      masterId: 102,
      antiAir: 1,
      currentSlot: 2,
      role: 'fighter',
    });

    expect(combatTransitionKey([onePlaneFighter], 'one-plane'))
      .not.toBe(combatTransitionKey([twoPlaneFighter], 'two-plane'));
  });

  test('bounds every attack coordinate when an earlier attacker can be shot down', () => {
    const front = plane('coordinate-front', {
      masterId: 1,
      currentSlot: 1,
      slotSize: 1,
      radius: 7,
      torpedo: 1,
      role: 'attacker',
    });
    const rear = plane('coordinate-rear', {
      masterId: 999,
      currentSlot: 18,
      slotSize: 18,
      radius: 7,
      torpedo: 20,
      role: 'attacker',
    });

    expect(possibleAttackCoordinates([front, rear, null, null]))
      .toEqual([[0, 1], [0, 1], null, null]);
  });

  test('does not assign one combat draw coordinate to two attackers in the same sample', () => {
    expect(maximumCoordinateAssignment([
      [10, 1],
      [9, 0],
    ])).toBe(10);
  });

  test('reports real frontier first-wave air-bound evidence for an infeasible search', () => {
    const equipment = [
      plane('frontier-air-bound-attacker-1', {
        masterId: 103,
        torpedo: 18,
        radius: 7,
        role: 'attacker',
      }),
      plane('frontier-air-bound-attacker-2', {
        masterId: 104,
        torpedo: 17,
        radius: 7,
        role: 'attacker',
      }),
    ];
    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: { ...combatEnemy(), slots: detailedEnemy().slots },
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases: Array.from({ length: 2 }, () => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: { seed: 'frontier-first-wave-air-bound', sampleCount: 1 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({
      backend: 'combat-frontier',
      status: 'infeasible',
      provenOptimal: true,
    });
    expect(result.search.solverStats.firstWaveAirBoundsPruned).toBeGreaterThan(0);
  });

  test('proves the combat optimum without pruning a lower-proxy guaranteed hit', () => {
    const incumbents = [];
    const result = optimizeLoadouts({
      equipment: [
        plane('production-high-proxy-miss', {
          masterId: 800,
          radius: 7,
          torpedo: 20,
          accuracy: 0,
          role: 'attacker',
        }),
        plane('production-lower-proxy-hit', {
          masterId: 459,
          radius: 7,
          torpedo: 9,
          bombing: 16,
          accuracy: 1,
          role: 'attacker',
        }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 1,
        fixedRandom: (_sample, _wave, side) => side === 'combat-hit' ? 0.91 : 0,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      onIncumbent: (plan) => incumbents.push(plan),
    });

    expect(result.search).toMatchObject({
      status: 'optimal',
      provenOptimal: true,
      objective: 'combat',
    });
    expect(result.results[0].bases[0].loadout[0].instanceId)
      .toBe('production-lower-proxy-hit');
    expect(result.results[0].simulation).toMatchObject({
      expectedSunkCount: 1,
      expectedHpDamage: 1,
    });
    expect(incumbents.at(-1).bases[0].loadout[0].instanceId)
      .toBe('production-lower-proxy-hit');
  });

  test('preserves a combat incumbent when cancellation interrupts the proof', () => {
    let cancelled = false;
    const result = optimizeLoadouts({
      equipment: [
        plane('combat-cancel-first', {
          masterId: 459,
          radius: 7,
          torpedo: 9,
          bombing: 16,
          accuracy: 3,
          role: 'attacker',
        }),
        plane('combat-cancel-second', {
          masterId: 800,
          radius: 7,
          torpedo: 20,
          accuracy: 0,
          role: 'attacker',
        }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 4, seed: 'combat-cancel' },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      isCancelled: () => cancelled,
      onIncumbent: () => { cancelled = true; },
    });

    expect(result.results).toHaveLength(1);
    expect(result.search).toMatchObject({
      status: 'cancelled',
      provenOptimal: false,
      objective: 'combat',
    });
  });

  test('does not certify grouped combat after cancellation during its final leaf', () => {
    const attacker = plane('grouped-final-cancel-attacker', {
      masterId: 9910,
      radius: 7,
      torpedo: 20,
      accuracy: 100,
      role: 'attacker',
    });
    let cancelled = false;
    const prepared = prepareSearch({
      equipment: [attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { plane: attacker, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 1,
        fixedRandom: (_sample, _wave, side) => {
          if (side === 'combat-hit') cancelled = true;
          return 0;
        },
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      isCancelled: () => cancelled,
    });

    const exact = solveCombatExact(prepared, { seedLoadouts: [] });

    expect(cancelled).toBe(true);
    expect(exact).toMatchObject({
      provenOptimal: false,
      solverStats: { status: 'cancelled', stopReason: 'cancelled' },
    });
    expect(exact.plans).toHaveLength(1);
  });

  test('does not certify a frontier cancelled by its deferred final incumbent', () => {
    const fixed = plane('frontier-final-cancel-fixed', {
      masterId: 9920,
      radius: 7,
      torpedo: 1,
      accuracy: 100,
      role: 'attacker',
    });
    const weak = plane('frontier-final-cancel-weak', {
      masterId: 9921,
      radius: 7,
      torpedo: 1,
      accuracy: 100,
      role: 'attacker',
    });
    const strong = plane('frontier-final-cancel-strong', {
      masterId: 9922,
      radius: 7,
      torpedo: 20,
      accuracy: 100,
      role: 'attacker',
    });
    const enemy = combatEnemy();
    enemy.ships[0] = { ...enemy.ships[0], hp: 500, currentHp: 500 };
    let cancelled = false;
    let incumbents = 0;
    const prepared = prepareSearch({
      equipment: [fixed, weak, strong],
      baseCount: 2,
      targetRadius: 7,
      enemy,
      targetStates: ['loss', 'loss', 'loss', 'loss'],
      lockedBases: [
        { slots: [
          { plane: fixed, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
        { slots: [
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
      ],
      simulationOptions: { sampleCount: 1, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      isCancelled: () => cancelled,
    });

    const exact = solveCombatExact(prepared, {
      seedLoadouts: [
        [[fixed, null, null, null], [weak, null, null, null]],
      ],
      isCancelled: () => cancelled,
      onIncumbent: () => {
        incumbents += 1;
        if (incumbents === 2) cancelled = true;
      },
    });

    expect(incumbents).toBe(2);
    expect(cancelled).toBe(true);
    expect(exact).toMatchObject({
      provenOptimal: false,
      solverStats: { status: 'cancelled', stopReason: 'cancelled' },
    });
    expect(exact.plans[0].bases[1].loadout[0].instanceId)
      .toBe('frontier-final-cancel-strong');
  });

  test('does not certify legacy detailed search cancelled during its final simulation', () => {
    const attacker = plane('legacy-final-cancel-attacker', {
      torpedo: 20,
      radius: 7,
      role: 'attacker',
    });
    let cancelled = false;
    const result = optimizeLoadouts({
      equipment: [attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { plane: attacker, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 1,
        fixedRandom: () => {
          cancelled = true;
          return 0;
        },
      },
      maxResults: 2,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      isCancelled: () => cancelled,
    });

    expect(result.search).toMatchObject({
      status: 'cancelled',
      provenOptimal: false,
    });
    expect(result.results).toHaveLength(1);
  });

  test('prunes combat candidates whose attack-count sink ceiling loses before simulation', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('sink-ceiling-attacker', {
          masterId: 459,
          radius: 7,
          torpedo: 9,
          bombing: 16,
          accuracy: 3,
          role: 'attacker',
        }),
        ...Array.from({ length: 12 }, (_unused, index) => plane(
          `sink-ceiling-fighter-${index}`,
          {
            masterId: 9100 + index,
            radius: 7 + index,
            antiAir: 20 - index,
            role: 'fighter',
          },
        )),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        ships: [0, 1].map((sourceShipIndex) => ({
          ...combatEnemy().ships[0],
          id: `sink-ceiling-enemy-${sourceShipIndex}`,
          sourceShipIndex,
          fleetShipIndex: sourceShipIndex,
          isFlagship: sourceShipIndex === 0,
        })),
      },
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 32,
        fixedRandom: () => 0,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].simulation.expectedSunkCount).toBe(2);
    expect(result.search.simulationSamplesEvaluated).toBe(64);
    expect(result.search.solverStats.staticCombatBoundsPruned).toBe(12);
  });

  test('prunes fixed-sample misses before simulating each combat leaf', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('a-hit-bound-accurate', {
          masterId: 9201,
          radius: 7,
          torpedo: 20,
          accuracy: 1,
          role: 'attacker',
        }),
        ...Array.from({ length: 3 }, (_unused, index) => plane(
          `z-hit-bound-miss-${index}`,
          {
            masterId: 9210 + index,
            radius: 7,
            torpedo: 20,
            accuracy: 0,
            role: 'attacker',
          },
        )),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 8,
        fixedRandom: (_sample, _wave, side) => side === 'combat-hit' ? 0.93 : 0,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('a-hit-bound-accurate');
    expect(result.results[0].simulation.expectedSunkCount).toBe(1);
    expect(result.search.solverStats.fixedSampleSinkBoundsPruned).toBe(3);
    expect(result.search.solverStats.aggregateCombatBoundsPruned).toBe(3);
    expect(result.search.solverStats.fixedSampleCombatBoundSamplesEvaluated).toBe(0);
    expect(result.search.solverStats.combatSamplesEvaluated).toBe(8);
  });

  test('prunes two-base frontier continuations with an aggregate combat ceiling', () => {
    const progress = [];
    const enemy = combatEnemy();
    enemy.ships.push({
      ...enemy.ships[0],
      id: 'frontier-second-fragile-dd',
      sourceShipIndex: 1,
      fleetShipIndex: 1,
      isFlagship: false,
    });
    const result = optimizeLoadouts({
      equipment: [
        plane('frontier-bound-attacker', {
          masterId: 459,
          radius: 7,
          torpedo: 9,
          bombing: 16,
          accuracy: 3,
          role: 'attacker',
        }),
        plane('frontier-bound-fighter-1', {
          masterId: 101,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        plane('frontier-bound-fighter-2', {
          masterId: 102,
          radius: 7,
          antiAir: 11,
          role: 'fighter',
        }),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemy,
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases: Array.from({ length: 2 }, () => ({ slots: [
        { locked: false },
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: {
        sampleCount: 8,
        fixedRandom: (_sample, _wave, side, attackIndex) =>
          side === 'combat-flagship-protection' ||
          (side === 'combat-hit' && attackIndex > 0) ? 0.999 : 0,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(result.search).toMatchObject({
      backend: 'combat-frontier',
      status: 'optimal',
      provenOptimal: true,
    });
    expect(result.search.solverStats.frontierAggregateCombatBoundsPruned)
      .toBeGreaterThan(0);
    expect(result.search.solverStats.frontierAggregateCombatBoundsEvaluated)
      .toBeLessThanOrEqual(
        result.search.solverStats.suffixTransitionGroupsProcessed *
        result.search.solverStats.prefixStates,
      );
    expect(result.search.solverStats.frontierBucketCombatBoundsEvaluated)
      .toBeLessThanOrEqual(
        result.search.solverStats.suffixTransitionGroupsProcessed *
        result.search.solverStats.prefixStates,
      );
    expect(result.search.solverStats.suffixBaseRecordCacheHits)
      .toBeGreaterThanOrEqual(0);
    expect(progress.at(-1)).toMatchObject({
      prefixCandidates: expect.any(Number),
      prefixTransitionGroups: expect.any(Number),
      prefixStates: expect.any(Number),
      prefixAirStates: expect.any(Number),
      minimumSuffixAir: expect.any(Number),
      suffixCandidates: expect.any(Number),
      suffixTransitionGroups: expect.any(Number),
      suffixTransitionGroupsProcessed: expect.any(Number),
      suffixTransitionsEvaluated: expect.any(Number),
      suffixCombatBatches: expect.any(Number),
      suffixCombatStatesBatched: expect.any(Number),
      suffixHpVectorCacheHits: expect.any(Number),
      suffixHpVectorsResolved: expect.any(Number),
      suffixTrajectoryCacheHits: expect.any(Number),
      suffixTrajectoryStatesReused: expect.any(Number),
      frontierAggregateCombatBoundsPruned: expect.any(Number),
      frontierAggregateCombatBoundsEvaluated: expect.any(Number),
      frontierBucketCombatBoundsPruned: expect.any(Number),
      frontierBucketCombatBoundsEvaluated: expect.any(Number),
      inventoryCompatibilityPrunes: expect.any(Number),
      candidatesEvaluated: expect.any(Number),
    });
  });

  test('uses minimum armor reduction in the fixed-sample HP ceiling', () => {
    const strong = plane('armor-bound-strong', {
      masterId: 9220,
      radius: 7,
      torpedo: 30,
      accuracy: 1,
      role: 'attacker',
    });
    const weak = plane('armor-bound-weak', {
      masterId: 9221,
      radius: 7,
      torpedo: 15,
      accuracy: 1,
      role: 'attacker',
    });
    const enemy = combatEnemy();
    enemy.ships[0] = {
      ...enemy.ships[0],
      hp: 1000,
      armor: 100,
    };
    const prepared = prepareSearch({
      equipment: [strong, weak],
      baseCount: 1,
      targetRadius: 7,
      enemy,
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 8, fixedRandom: () => 0.5 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    const exact = solveCombatExact(prepared, {
      seedLoadouts: [[[strong, null, null, null]]],
    });

    expect(exact).toMatchObject({ provenOptimal: true });
    expect(exact.plans[0].bases[0].loadout[0].instanceId).toBe('armor-bound-strong');
    expect(exact.solverStats.fixedSampleSinkBoundsPruned).toBe(1);
    expect(exact.solverStats.combatSamplesEvaluated).toBe(8);
  });

  test('keeps a grouped bound safe when Stage 2 removes an earlier attacker', () => {
    const front = plane('grouped-coordinate-front', {
      masterId: 1,
      radius: 7,
      currentSlot: 1,
      slotSize: 1,
      torpedo: 1,
      accuracy: 0,
      role: 'attacker',
    });
    const weak = plane('grouped-coordinate-weak', {
      masterId: 2,
      radius: 7,
      torpedo: 1,
      accuracy: 100,
      role: 'attacker',
    });
    const strong = plane('grouped-coordinate-strong', {
      masterId: 3,
      radius: 7,
      torpedo: 20,
      accuracy: 100,
      role: 'attacker',
    });
    const enemy = combatEnemy();
    enemy.ships[0] = {
      ...enemy.ships[0],
      hp: 500,
      currentHp: 500,
      evasion: 1000,
    };
    enemy.stage2Defense = {
      modeled: true,
      byAvoidance: { 0: { fixedLosses: [1], rateFactors: [0] } },
    };
    const prepared = prepareSearch({
      equipment: [front, weak, strong],
      baseCount: 1,
      targetRadius: 7,
      enemy,
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { plane: front, locked: true },
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 1,
        fixedRandom: (_sample, _wave, side, attackIndex) => {
          if (side === 'player-stage2-fixed') return 1;
          if (side === 'combat-hit') return attackIndex === 0 ? 0.5 : 0.999999;
          return 0;
        },
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    const exact = solveCombatExact(prepared, {
      seedLoadouts: [[[front, weak, null, null]]],
    });

    expect(exact).toMatchObject({ provenOptimal: true });
    expect(exact.plans[0].bases[0].loadout[1].instanceId)
      .toBe('grouped-coordinate-strong');
  });

  test('screens non-seed fulfillment inside the single numeric combat pass', () => {
    const incumbents = [];
    const result = optimizeLoadouts({
      equipment: [
        plane('air-screen-fulfilled', {
          masterId: 459,
          radius: 7,
          antiAir: 12,
          torpedo: 9,
          bombing: 16,
          accuracy: 3,
          role: 'attacker',
        }),
        plane('air-screen-failed', {
          masterId: 800,
          radius: 7,
          antiAir: 0,
          torpedo: 20,
          accuracy: 2,
          role: 'attacker',
        }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'air-screen-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['none', 'parity'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 32,
        fixedRandom: () => 0,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      onIncumbent: (plan) => incumbents.push(plan),
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(incumbents.length).toBeGreaterThan(0);
    expect(incumbents.every((plan) =>
      plan.allWaveTargetFulfillmentProbability === 1)).toBe(true);
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('air-screen-fulfilled');
    expect(result.search.solverStats.combatSamplesEvaluated).toBe(33);
    expect(result.search.solverStats.airScreenSamplesEvaluated).toBe(32);
  });

  test('never publishes a high-damage combat seed that fails the requested air states', () => {
    const fighter = plane('hard-air-fighter', {
      masterId: 459,
      radius: 7,
      antiAir: 12,
      torpedo: 9,
      bombing: 16,
      accuracy: 3,
      role: 'attacker',
    });
    const attacker = plane('hard-air-attacker', {
      masterId: 800,
      radius: 7,
      antiAir: 0,
      torpedo: 20,
      accuracy: 2,
      role: 'attacker',
    });
    const prepared = prepareSearch({
      equipment: [fighter, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'hard-air-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['none', 'parity'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 8, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });
    const incumbents = [];

    const exact = solveCombatExact(prepared, {
      seedLoadouts: [[[attacker, null, null, null]]],
      onIncumbent: (plan) => incumbents.push(plan),
    });

    expect(exact.provenOptimal).toBe(true);
    expect(incumbents.length).toBeGreaterThan(0);
    expect(incumbents.every((plan) =>
      plan.allWaveTargetFulfillmentProbability === 1)).toBe(true);
    expect(exact.plans[0].bases[0].loadout[0].instanceId).toBe('hard-air-fighter');
  });

  test('publishes a target-fulfilled combat seed before spending exact proof nodes', () => {
    let cancelled = false;
    const result = optimizeLoadouts({
      equipment: [
        plane('combat-seed-fighter-1', {
          masterId: 9201,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        plane('combat-seed-fighter-2', {
          masterId: 9202,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        ...Array.from({ length: 6 }, (_unused, index) => plane(
          `combat-seed-attacker-${index}`,
          {
            masterId: 9210 + index,
            radius: 7,
            torpedo: 20 - index,
            accuracy: 3 - (index % 2),
            role: 'attacker',
          },
        )),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'combat-seed-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { sampleCount: 4, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      isCancelled: () => cancelled,
      onIncumbent: () => { cancelled = true; },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].allWaveTargetFulfillmentProbability).toBe(1);
    expect(result.search).toMatchObject({
      status: 'cancelled',
      provenOptimal: false,
      nodesExplored: 0,
    });
    expect(result.search.solverStats.seedCandidatesEvaluated).toBe(1);
  });

  test('prunes a first-base branch whose relaxed air ceiling cannot keep full fulfillment', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('first-wave-bound-fighter', {
          masterId: 9301,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        plane('first-wave-bound-attacker', {
          masterId: 9302,
          radius: 7,
          antiAir: 0,
          torpedo: 20,
          accuracy: 3,
          role: 'attacker',
        }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'first-wave-bound-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['parity', 'parity'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 32, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.search.solverStats.combatSamplesEvaluated).toBe(32);
    expect(result.search.solverStats.airScreenSamplesEvaluated).toBe(32);
    expect(result.search.solverStats.firstWaveAirBoundsPruned).toBe(1);
  });

  test('does not reuse already-skipped groups in the first-wave air ceiling', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('suffix-air-fighter', {
          masterId: 9351,
          radius: 7,
          antiAir: 30,
          role: 'fighter',
        }),
        ...Array.from({ length: 4 }, (_unused, index) => plane(
          `suffix-air-attacker-${index}`,
          {
            masterId: 9360 + index,
            radius: 7,
            antiAir: 0,
            torpedo: 20 - index,
            accuracy: 3,
            role: 'attacker',
          },
        )),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'suffix-air-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 40,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['parity', 'parity'],
      lockedBases: [{ slots: [
        { locked: false },
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 1, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].allWaveTargetFulfillmentProbability).toBe(1);
    expect(result.search.solverStats.firstWaveSuffixAirBoundsPruned).toBeGreaterThan(0);
  });

  test('prunes a later base against the exact fixed-sample prefix air requirement', () => {
    const firstBaseFighter = plane('prefix-air-first-base', {
      masterId: 9371,
      radius: 7,
      antiAir: 12,
      role: 'fighter',
    });
    const result = optimizeLoadouts({
      equipment: [
        firstBaseFighter,
        plane('prefix-air-second-base-fighter', {
          masterId: 9372,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        plane('prefix-air-second-base-attacker', {
          masterId: 9373,
          radius: 7,
          antiAir: 0,
          torpedo: 20,
          accuracy: 3,
          role: 'attacker',
        }),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'prefix-air-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      lockedBases: [
        { slots: [
          { plane: firstBaseFighter, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
        { slots: [
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
      ],
      simulationOptions: { sampleCount: 4, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].allWaveTargetFulfillmentProbability).toBe(1);
    expect(result.search.solverStats.prefixAirSamplesEvaluated).toBeGreaterThan(0);
    expect(result.search.solverStats.prefixCombatReplays).toBe(0);
    expect(result.search.solverStats.suffixCandidates).toBe(1);
  });

  test('reuses prefix HP combat for exact attacker trajectories across fighter variants', () => {
    const suffixAttacker = plane('prefix-trajectory-suffix-attacker', {
      masterId: 9381,
      radius: 7,
      antiAir: 0,
      torpedo: 20,
      accuracy: 3,
      role: 'attacker',
    });
    const result = optimizeLoadouts({
      equipment: [
        suffixAttacker,
        plane('prefix-trajectory-fighter-a', {
          masterId: 9382,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        plane('prefix-trajectory-fighter-b', {
          masterId: 9383,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['denial', 'denial', 'denial', 'denial'],
      lockedBases: [
        { slots: [
          { locked: false },
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
        { slots: [
          { plane: suffixAttacker, locked: true },
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
      ],
      simulationOptions: { sampleCount: 64, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.search.solverStats.prefixTrajectoryCacheHits).toBeGreaterThan(0);
    expect(result.search.solverStats.prefixCombatReplays)
      .toBeLessThan(result.search.solverStats.prefixTransitionGroups);
    expect(result.search.solverStats.suffixBucketCeilingCacheHits).toBeGreaterThan(0);
    expect(result.search.solverStats.suffixBucketCeilingsComputed)
      .toBeLessThan(result.search.solverStats.suffixTransitionGroupsProcessed);
    expect(result.search.solverStats.suffixFirstHpCacheHits).toBeGreaterThan(0);
    expect(result.search.solverStats.terminalPlanSimulationReuses).toBeGreaterThan(0);
    expect(result.search.solverStats.terminalPlanSimulations).toBeLessThanOrEqual(2);
    expect(result.search.solverStats.terminalPlanSimulationReuses)
      .toBe(result.search.solverStats.candidatesEvaluated -
        result.search.solverStats.terminalPlanSimulations);
  });

  test('skips an under-air partial base while still exploring additions that can fulfill', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('partial-air-fighter', {
          masterId: 9401,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        plane('partial-air-attacker', {
          masterId: 9402,
          radius: 7,
          antiAir: 0,
          torpedo: 20,
          accuracy: 3,
          role: 'attacker',
        }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'partial-air-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['parity', 'parity'],
      lockedBases: [{ slots: [
        { locked: false },
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 32, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].allWaveTargetFulfillmentProbability).toBe(1);
    expect(result.search.solverStats.airScreenSamplesEvaluated).toBe(32);
    expect(result.search.solverStats.firstWavePartialCompletionsPruned).toBeGreaterThan(0);
  });

  test('reaches a mixed-air exact candidate before exhausting an attacker-heavy prefix', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('ordered-air-fighter-1', {
          masterId: 9501,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        plane('ordered-air-fighter-2', {
          masterId: 9502,
          radius: 7,
          antiAir: 12,
          role: 'fighter',
        }),
        ...Array.from({ length: 12 }, (_unused, index) => plane(
          `ordered-air-attacker-${index}`,
          {
            masterId: 9510 + index,
            radius: 7,
            antiAir: 0,
            torpedo: 20 - (index % 5),
            accuracy: 3 - (index % 2),
            role: 'attacker',
          },
        )),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'ordered-air-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 35,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['parity', 'parity'],
      simulationOptions: { sampleCount: 1, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: 20,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({ status: 'budget_exhausted', provenOptimal: false });
    expect(result.search.solverStats.seedCandidatesEvaluated).toBe(1);
    expect(result.search.candidatesEvaluated).toBeGreaterThan(1);
  });

  test('throttles combat proof progress instead of emitting every few milliseconds', () => {
    const prepared = prepareSearch({
      equipment: Array.from({ length: 20 }, (_unused, index) => plane(
        `throttled-combat-progress-${index}`,
        {
          masterId: 9600 + index,
          radius: 7,
          antiAir: 20 - (index % 10),
          torpedo: 20 - (index % 5),
          accuracy: 2,
          role: 'attacker',
        },
      )),
      baseCount: 2,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      simulationOptions: { sampleCount: 1, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: 10000,
      simulationWorkBudget: Infinity,
    });
    const progress = [];

    const result = solveCombatExact(prepared, {
      seedLoadouts: [],
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(result.solverStats.nodesExplored).toBe(10000);
    expect(result.solverStats.fixedCombatBaseContributionCacheHits).toBeGreaterThan(0);
    expect(progress).toHaveLength(2);
    expect(progress.at(-1).nodesExplored).toBe(10000);
  });

  test('emits frontier progress while fixed-sample transitions are still running', () => {
    const prepared = prepareSearch({
      equipment: Array.from({ length: 8 }, (_unused, index) => plane(
        `frontier-progress-${index}`,
        {
          masterId: 9700 + index,
          radius: 7,
          antiAir: 20 - index,
          torpedo: 10 + index,
          bombing: 10 + index,
          accuracy: 1,
          role: 'attacker',
        },
      )),
      baseCount: 2,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases: Array.from({ length: 2 }, () => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: { sampleCount: 8192, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });
    const progress = [];

    const result = solveCombatExact(prepared, {
      seedLoadouts: [],
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(result.solverStats.backend).toBe('combat-frontier');
    expect(progress.slice(0, -1).some((snapshot) =>
      snapshot.simulationSamplesEvaluated >= 65536)).toBe(true);
  }, 15000);

  test('publishes countable suffix work before processing the frontier', () => {
    const prepared = prepareSearch({
      equipment: Array.from({ length: 8 }, (_unused, index) => plane(
        `frontier-suffix-progress-${index}`,
        {
          masterId: 9720 + index,
          radius: 7,
          antiAir: 20 - index,
          torpedo: 10 + index,
          bombing: 10 + index,
          accuracy: 1,
          role: 'attacker',
        },
      )),
      baseCount: 2,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases: Array.from({ length: 2 }, () => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: { sampleCount: 1, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });
    const progress = [];

    const result = solveCombatExact(prepared, {
      seedLoadouts: [],
      suffixShardCount: 4,
      suffixShardIndex: 0,
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(result.solverStats.backend).toBe('combat-frontier');
    expect(progress.some((snapshot) =>
      snapshot.suffixTransitionGroups > 0 &&
      snapshot.suffixTransitionGroupsProcessed === 0 &&
      snapshot.suffixTransitionAssignmentComplete === true &&
      snapshot.suffixEnumerationSharded === true &&
      snapshot.suffixPartitionCount === 2)).toBe(true);
  });

  test('does not count a suffix transition stopped before its evaluation finishes', () => {
    const prepared = prepareSearch({
      equipment: Array.from({ length: 8 }, (_unused, index) => plane(
        `frontier-cancelled-transition-${index}`,
        {
          masterId: 9800 + index,
          radius: 7,
          antiAir: 20 - index,
          torpedo: 10 + index,
          bombing: 10 + index,
          accuracy: 1,
          role: 'attacker',
        },
      )),
      baseCount: 2,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases: Array.from({ length: 2 }, () => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: { sampleCount: 8192, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: 65536,
    });

    const result = solveCombatExact(prepared, {
      seedLoadouts: [],
    });
    const started = result.solverStats.suffixBucketCeilingsComputed +
      result.solverStats.suffixBucketCeilingCacheHits;

    expect(started).toBeGreaterThan(0);
    expect(result.solverStats.status).toBe('budget_exhausted');
    expect(result.solverStats.suffixTransitionGroupsProcessed).toBeLessThan(started);
  }, 15000);

  test('does not enumerate suffixes below every frontier continuation air requirement', () => {
    const firstBaseFighter = plane('frontier-minimum-air-first', {
      masterId: 9750,
      radius: 7,
      antiAir: 12,
      role: 'fighter',
    });
    const secondBaseFighter = plane('frontier-minimum-air-second', {
      masterId: 9751,
      radius: 7,
      antiAir: 12,
      role: 'fighter',
    });
    const result = optimizeLoadouts({
      equipment: [
        firstBaseFighter,
        secondBaseFighter,
        ...Array.from({ length: 12 }, (_unused, index) => plane(
          `frontier-minimum-air-attacker-${index}`,
          {
            masterId: 9760 + index,
            radius: 7,
            antiAir: 0,
            torpedo: 20 - (index % 5),
            accuracy: 3,
            role: 'attacker',
          },
        )),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        ...combatEnemy(),
        slots: [{
          instanceId: 'frontier-minimum-air-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      lockedBases: [
        { slots: [
          { plane: firstBaseFighter, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
        { slots: [
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
      ],
      simulationOptions: { sampleCount: 4, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(result.search).toMatchObject({
      backend: 'combat-frontier',
      status: 'optimal',
      provenOptimal: true,
    });
    expect(result.search.solverStats.suffixCandidates).toBe(1);
  });

  test('cancels bounded seed generation before enumerating its Pareto pool', () => {
    const prepared = prepareSearch({
      equipment: Array.from({ length: 8 }, (_unused, index) => plane(`cancel-seed-${index}`, {
        antiAir: index,
        radius: 7,
        role: 'attacker',
        torpedo: 20 - index,
        isLandBased: true,
      })),
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['loss', 'loss'],
    });
    let checks = 0;

    const candidates = buildStaticSeedCandidates(
      prepared.baseLocks[0],
      prepared,
      0,
      { isCancelled: () => { checks += 1; return true; } },
    );

    expect(candidates).toEqual([]);
    expect(checks).toBe(1);
  });

  test('prepares one shared fixed-sample random table for every detailed candidate', () => {
    const prepared = prepareSearch({
      equipment: [plane('shared-random', { antiAir: 8, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity'],
      simulationOptions: { seed: 'shared-random', sampleCount: 8 },
    });

    expect(prepared.valid).toBe(true);
    expect(prepared.simulationOptions.fixedRandom).toEqual(expect.any(Function));
    expect(prepared.simulationOptions.scoreContext).toEqual(expect.objectContaining({
      baseCache: expect.any(Map),
    }));
  });

  test('keeps capacity-covered detailed groups because fixed-sample coordinates are global', () => {
    const stronger = Array.from({ length: 8 }, (_unused, index) => plane(
      `detailed-dominator-${index}`,
      {
        masterId: 3300 + index,
        torpedo: 20,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      },
    ));
    const ordinaryWeak = plane('detailed-dominated', {
      masterId: 3400,
      torpedo: 5,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    });
    const mislabeledWeak = plane('detailed-dominated-label-mismatch', {
      masterId: 3402,
      torpedo: 5,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const jetWeak = plane('detailed-jet-not-dominated', {
      masterId: 3401,
      torpedo: 5,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
      isJet: true,
    });
    const prepared = prepareSearch({
      equipment: [...stronger, ordinaryWeak, mislabeledWeak, jetWeak],
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['loss', 'loss', 'loss', 'loss'],
      simulationOptions: { seed: 'detailed-dominance', sampleCount: 1 },
    });

    const instanceIds = prepared.groups.flatMap((group) =>
      group.instances.map((item) => item.instanceId));
    expect(instanceIds).toContain(ordinaryWeak.instanceId);
    expect(instanceIds).toContain(mislabeledWeak.instanceId);
    expect(instanceIds).toContain(jetWeak.instanceId);
    expect(prepared.detailedGroupsRemoved).toBe(0);
  });

  test('does not dominance-prune a higher-avoidance plane under modeled Stage 2', () => {
    const rawPower = plane('stage2-dominance-raw-power', {
      masterId: 9930,
      equipType: 47,
      antiAir: 2,
      torpedo: 14,
      radius: 7,
      role: 'attacker',
      shootDownAvoidance: 0,
    });
    const protectedPower = plane('stage2-dominance-protected', {
      masterId: 9931,
      equipType: 47,
      antiAir: 1,
      torpedo: 13,
      radius: 7,
      role: 'attacker',
      shootDownAvoidance: 1,
    });
    const enemy = detailedEnemy();
    enemy.stage2Defense = {
      modeled: true,
      byAvoidance: {
        0: { fixedLosses: [17], rateFactors: [0] },
        1: { fixedLosses: [0], rateFactors: [0] },
      },
    };
    const common = {
      equipment: [rawPower, protectedPower],
      baseCount: 1,
      targetRadius: 7,
      enemy,
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 1, fixedRandom: () => 0.999999 },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };

    const prepared = prepareSearch(common);
    const result = optimizeLoadouts(common);

    expect(prepared.groups.flatMap((group) =>
      group.instances.map((item) => item.instanceId)))
      .toContain('stage2-dominance-protected');
    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].bases[0].loadout[0].instanceId)
      .toBe('stage2-dominance-protected');
  });

  test('does not let a short custom slot dominate a full custom slot', () => {
    const short = Array.from({ length: 4 }, (_unused, index) => plane(
      `short-custom-slot-${index}`,
      {
        masterId: 3600 + index,
        currentSlot: 1,
        torpedo: 15,
        radius: 7,
        role: 'attacker',
      },
    ));
    const full = plane('full-custom-slot', {
      masterId: 9998,
      currentSlot: 18,
      torpedo: 14,
      radius: 7,
      role: 'attacker',
    });
    const prepared = prepareSearch({
      equipment: [...short, full],
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      simulationOptions: { seed: 'custom-slot-dominance', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(full.instanceId);
  });

  test('does not let a short explicit slot size dominate a full explicit slot size', () => {
    const short = Array.from({ length: 4 }, (_unused, index) => plane(
      `short-explicit-slot-${index}`,
      {
        masterId: 3700 + index,
        slotSize: 1,
        torpedo: 15,
        radius: 7,
        role: 'attacker',
      },
    ));
    const full = plane('full-explicit-slot', {
      masterId: 9997,
      slotSize: 18,
      torpedo: 14,
      radius: 7,
      role: 'attacker',
    });
    const prepared = prepareSearch({
      equipment: [...short, full],
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      simulationOptions: { seed: 'explicit-slot-dominance', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(full.instanceId);
  });

  test('keeps an equal-damage fighter despite full-inventory scarcity ordering', () => {
    const stronger = Array.from({ length: 4 }, (_unused, index) => plane(
      `full-inventory-stronger-${index}`,
      { masterId: 3800, antiAir: 12, radius: 7, role: 'fighter' },
    ));
    const weaker = plane('full-inventory-weaker', {
      masterId: 9996,
      antiAir: 5,
      radius: 7,
      role: 'fighter',
    });
    const prepared = prepareSearch({
      equipment: [...stronger, weaker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity'],
      simulationOptions: { seed: 'full-inventory-scarcity', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(weaker.instanceId);
  });

  test('keeps capacity-covered non-attackers during fixed-sample combat optimization', () => {
    const stronger = Array.from({ length: 8 }, (_unused, index) => plane(
      `combat-dominance-stronger-${index}`,
      { masterId: 3850, antiAir: 12, radius: 7, role: 'fighter' },
    ));
    const weaker = plane('combat-dominance-weaker', {
      masterId: 3851,
      antiAir: 5,
      radius: 7,
      role: 'fighter',
    });
    const prepared = prepareSearch({
      equipment: [...stronger, weaker],
      baseCount: 2,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      simulationOptions: { seed: 'combat-non-attacker-dominance', sampleCount: 1 },
      optimizationObjective: 'combat',
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(weaker.instanceId);
  });

  test.each([
    { label: 'combat', optimizationObjective: 'combat', scoreField: 'expectedHpDamage' },
    { label: 'default detailed', optimizationObjective: undefined, scoreField: 'expectedDamage' },
  ])('does not dominance-prune a fighter that changes $label fixed-sample loss coordinates', ({
    optimizationObjective,
    scoreField,
  }) => {
    const stronger = Array.from({ length: 2 }, (_unused, index) => plane(
      `combat-crn-stronger-${index}`,
      { masterId: 100, equipType: 48, antiAir: 6, radius: 7, role: 'fighter' },
    ));
    const weaker = plane('combat-crn-weaker', {
      masterId: 300,
      equipType: 48,
      antiAir: 5,
      radius: 7,
      role: 'fighter',
    });
    const attacker = plane('combat-crn-attacker', {
      masterId: 200,
      equipType: 47,
      torpedo: 30,
      radius: 7,
      role: 'attacker',
    });
    const enemy = combatEnemy();
    enemy.slots = [{
      instanceId: 'combat-crn-enemy-slot',
      name: 'Combat CRN enemy slot',
      sortieAntiAir: 10,
      currentSlot: 18,
      maxSlot: 18,
    }];
    enemy.ships[0] = {
      ...enemy.ships[0],
      hp: 1000,
      currentHp: 1000,
      armor: 0,
    };
    const common = {
      equipment: [...stronger, weaker, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy,
      targetStates: ['denial', 'denial'],
      lockedBases: [{ slots: [
        { locked: false },
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 1, seed: '1' },
      optimizationObjective,
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };

    const prepared = prepareSearch(common);
    const result = optimizeLoadouts(common);

    expect(prepared.groups.flatMap((group) =>
      group.instances.map((item) => item.instanceId)))
      .toContain('combat-crn-weaker');
    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].bases[0].loadout.map((item) => item?.instanceId))
      .toContain('combat-crn-weaker');
    expect(result.results[0].simulation[scoreField]).toBe(518);
  });

  test('does not dominance-prune a pure ASW combat attacker', () => {
    const airOnly = plane('asw-dominance-air-only', {
      masterId: 1,
      equipType: 25,
      radius: 7,
      antiAir: 10,
      bombing: 0,
      asw: 6,
      role: 'asw',
      isAttacker: false,
    });
    const pureAsw = plane('asw-dominance-attacker', {
      masterId: 603,
      equipType: 25,
      radius: 7,
      antiAir: 0,
      bombing: 0,
      asw: 20,
      role: 'asw',
      isAttacker: false,
      isLbasCombatAttacker: true,
      canAttackSubmarine: true,
    });
    const enemy = combatEnemy();
    enemy.ships[0] = {
      ...enemy.ships[0],
      id: 'asw-dominance-submarine',
      hp: 200,
      currentHp: 200,
      type: 13,
      isSubmarine: true,
    };
    const prepared = prepareSearch({
      equipment: [airOnly, pureAsw],
      baseCount: 1,
      targetRadius: 7,
      enemy,
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 1, fixedRandom: () => 0 },
      optimizationObjective: 'combat',
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    expect(prepared.groups.flatMap((group) =>
      group.instances.map((item) => item.instanceId)))
      .toContain('asw-dominance-attacker');
  });

  test('keeps a lower-air land recon whose contact tier can increase combat damage', () => {
    const attackers = Array.from({ length: 3 }, (_unused, index) => plane(
      `contact-dominance-attacker-${index}`,
      {
        masterId: 4200 + index,
        torpedo: 18,
        radius: 7,
        role: 'attacker',
      },
    ));
    const highContactRecon = plane('contact-dominance-high-tier', {
      masterId: 4100,
      antiAir: 4,
      scout: 7,
      accuracy: 3,
      radius: 7,
      role: 'recon',
    });
    const higherAirRecon = plane('contact-dominance-higher-air', {
      masterId: 4000,
      antiAir: 5,
      scout: 1,
      accuracy: 0,
      radius: 7,
      role: 'recon',
    });
    const prepared = prepareSearch({
      equipment: [...attackers, highContactRecon, higherAirRecon],
      baseCount: 1,
      targetRadius: 7,
      enemy: combatEnemy(),
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { plane: attackers[0], locked: true },
        { plane: attackers[1], locked: true },
        { plane: attackers[2], locked: true },
        { locked: false },
      ] }],
      simulationOptions: { seed: 'contact-dominance', sampleCount: 1 },
      optimizationObjective: 'combat',
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(highContactRecon.instanceId);
  });

  test('counts locked equivalent copies when comparing detailed scarcity', () => {
    const lockedWeak = plane('locked-scarcity-weak', {
      masterId: 3900,
      antiAir: 5,
      radius: 7,
      role: 'fighter',
    });
    const freeWeak = plane('free-scarcity-weak', {
      masterId: 3900,
      antiAir: 5,
      radius: 7,
      role: 'fighter',
    });
    const freeStrong = plane('free-scarcity-strong', {
      masterId: 1000,
      antiAir: 12,
      radius: 7,
      role: 'fighter',
    });
    const prepared = prepareSearch({
      equipment: [lockedWeak, freeWeak, freeStrong],
      baseCount: 2,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases: [
        { slots: [
          { plane: lockedWeak, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
        { slots: [
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
      ],
      simulationOptions: { seed: 'locked-inventory-scarcity', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(freeWeak.instanceId);
  });

  test('finds a valid base plan without reusing the same equipment instance', () => {
    const equipment = [
      plane('f1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter' }),
      plane('f2', { antiAir: 10, intercept: 3, radius: 7, role: 'fighter' }),
      plane('f3', { antiAir: 9, intercept: 0, radius: 7, role: 'fighter' }),
      plane('f4', { antiAir: 8, intercept: 0, radius: 7, role: 'fighter' }),
      plane('a1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14 }),
      plane('a2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14 }),
      plane('a3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12 }),
      plane('a4', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12 }),
    ];

    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 3,
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].fulfilled).toBe(true);
    expect(result.results[0].bases).toHaveLength(2);

    const usedIds = result.results[0].bases.flatMap((base) =>
      base.loadout.filter(Boolean).map((item) => item.instanceId),
    );
    expect(new Set(usedIds).size).toBe(usedIds.length);
  });

  test('returns an actionable reason when no plane can reach the requested radius', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('f1', { antiAir: 10, radius: 4, role: 'fighter' }),
        plane('f2', { antiAir: 9, radius: 4, role: 'fighter' }),
        plane('a1', { antiAir: 3, radius: 5, role: 'attacker' }),
        plane('a2', { antiAir: 3, radius: 5, role: 'attacker' }),
      ],
      baseCount: 1,
      targetRadius: 9,
      enemyAir: 36,
      targetStates: ['parity'],
      maxResults: 3,
    });

    expect(result.results).toHaveLength(0);
    expect(result.messages).toContain('No candidate loadout can reach radius 9.');
  });

  test('prefers land-based aircraft over carrier aircraft after the target state is satisfied', () => {
    const equipment = [
      plane('carrier-fighter-1', { antiAir: 15, radius: 7, role: 'fighter', isLandBased: false }),
      plane('carrier-fighter-2', { antiAir: 14, radius: 7, role: 'fighter', isLandBased: false }),
      plane('carrier-fighter-3', { antiAir: 13, radius: 7, role: 'fighter', isLandBased: false }),
      plane('carrier-fighter-4', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: false }),
      plane('land-fighter', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
      plane('land-attacker-1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14, isLandBased: true }),
      plane('land-attacker-2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14, isLandBased: true }),
      plane('land-attacker-3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12, isLandBased: true }),
    ];

    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    const selectedIds = result.results[0].bases[0].loadout.map((item) => item.instanceId);
    expect(selectedIds).toContain('land-fighter');
    expect(selectedIds).toContain('land-attacker-1');
    expect(selectedIds).not.toEqual([
      'carrier-fighter-1',
      'carrier-fighter-2',
      'carrier-fighter-3',
      'carrier-fighter-4',
    ]);
  });

  test('maximizes land-based attackers after satisfying the target air state', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('land-fighter-1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('land-fighter-2', { antiAir: 10, intercept: 4, radius: 7, role: 'fighter', isLandBased: true }),
        plane('land-fighter-3', { antiAir: 9, intercept: 3, radius: 7, role: 'fighter', isLandBased: true }),
        plane('land-attacker-1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14, isLandBased: true }),
        plane('land-attacker-2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14, isLandBased: true }),
        plane('land-attacker-3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12, isLandBased: true }),
        plane('land-attacker-4', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 10, bombing: 12, isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results[0].bases[0].landAttackerCount).toBe(3);
    expect(result.results[0].bases[0].damagePower).toBeGreaterThan(0);
    expect(result.results[0].bases[0].attackPowerProxy)
      .toBe(result.results[0].bases[0].damagePower);
    expect(result.results[0].attackPowerProxy).toBe(result.results[0].totalDamagePower);
  });

  test('keeps long-range land attackers in the candidate pool for radius-seven targets', () => {
    const shortRangeFighters = Array.from({ length: 60 }, (_, index) =>
      plane(`short-fighter-${index}`, {
        antiAir: 12,
        intercept: 4,
        radius: 3,
        role: 'fighter',
        isLandBased: true,
      }),
    );
    const gingaSquadron = Array.from({ length: 4 }, (_, index) =>
      plane(`ginga-${index}`, {
        antiAir: 3,
        radius: 9,
        role: 'attacker',
        torpedo: 14,
        bombing: 14,
        proficiency: 7,
        isLandBased: true,
      }),
    );

    const result = optimizeLoadouts({
      equipment: [...shortRangeFighters, ...gingaSquadron],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].bases[0].loadout.map((item) => item.instanceId)).toEqual([
      'ginga-0',
      'ginga-1',
      'ginga-2',
      'ginga-3',
    ]);
  });

  test('keeps short-range combat planes that can be extended by land recon', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter-1', { antiAir: 12, radius: 4, role: 'fighter', proficiency: 7, isLandBased: true }),
        plane('fighter-2', { antiAir: 12, radius: 4, role: 'fighter', proficiency: 7, isLandBased: true }),
        plane('fighter-3', { antiAir: 12, radius: 4, role: 'fighter', proficiency: 7, isLandBased: true }),
        plane('recon', { masterId: 311, antiAir: 3, radius: 8, role: 'recon', isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 6,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].bases[0].radius).toBe(6);
  });

  test('includes theoretical missing equipment in valid plans', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('owned-fighter', { masterId: 225, antiAir: 11, intercept: 5, radius: 7, role: 'fighter', proficiency: 7, isLandBased: true }),
        plane('missing-attacker-1', {
          masterId: 187,
          antiAir: 3,
          radius: 9,
          role: 'attacker',
          torpedo: 14,
          bombing: 14,
          proficiency: 7,
          isLandBased: true,
          available: false,
          missing: true,
        }),
        plane('missing-attacker-2', {
          masterId: 187,
          antiAir: 3,
          radius: 9,
          role: 'attacker',
          torpedo: 14,
          bombing: 14,
          proficiency: 7,
          isLandBased: true,
          available: false,
          missing: true,
        }),
        plane('missing-attacker-3', {
          masterId: 187,
          antiAir: 3,
          radius: 9,
          role: 'attacker',
          torpedo: 14,
          bombing: 14,
          proficiency: 7,
          isLandBased: true,
          available: false,
          missing: true,
        }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].missingEquipment).toEqual([
      { masterId: 187, name: 'missing-attacker-1', count: 3 },
    ]);
    expect(result.results[0].bases[0].minimumProficiency).toBeGreaterThanOrEqual(0);
  });

  test('treats each base as two waves and records six waves for three bases', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('f1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f2', { antiAir: 10, intercept: 3, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f3', { antiAir: 9, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f4', { antiAir: 8, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f5', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f6', { antiAir: 10, intercept: 3, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f7', { antiAir: 9, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f8', { antiAir: 8, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f9', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f10', { antiAir: 10, intercept: 3, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f11', { antiAir: 9, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f12', { antiAir: 8, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
      ],
      baseCount: 3,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity', 'parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
      nodeBudget: 1000,
    });

    expect(result.results[0].bases).toHaveLength(3);
    expect(result.results[0].waves).toHaveLength(6);
    expect(result.results[0].waves.map((wave) => wave.baseIndex)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  test('keeps locked equipment in the requested base and fills remaining slots', () => {
    const lockedAttacker = plane('locked-ginga', {
      antiAir: 3,
      radius: 9,
      role: 'attacker',
      torpedo: 14,
      bombing: 14,
      isLandBased: true,
    });
    const result = optimizeLoadouts({
      equipment: [
        lockedAttacker,
        plane('fighter-1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('attacker-1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14, isLandBased: true }),
        plane('attacker-2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14, isLandBased: true }),
        plane('attacker-3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12, isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      lockedBases: [
        {
          slots: [
            { plane: lockedAttacker, locked: true },
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
          ],
        },
      ],
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('locked-ginga');
    expect(result.results[0].bases[0].loadout).toHaveLength(4);
  });

  test('does not reuse a locked equipment instance in another base', () => {
    const lockedFighter = plane('locked-fighter', {
      antiAir: 11,
      intercept: 5,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const equipment = [
      lockedFighter,
      ...Array.from({ length: 11 }, (_, index) =>
        plane(`plane-${index}`, {
          antiAir: index < 3 ? 10 : 3,
          radius: index < 3 ? 7 : 9,
          role: index < 3 ? 'fighter' : 'attacker',
          torpedo: index < 3 ? 0 : 14,
          bombing: index < 3 ? 0 : 14,
          isLandBased: true,
        }),
      ),
    ];

    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      lockedBases: [
        {
          slots: [
            { plane: lockedFighter, locked: true },
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
          ],
        },
        {
          slots: [
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
          ],
        },
      ],
      maxResults: 1,
    });

    const usedIds = result.results[0].bases.flatMap((base) =>
      base.loadout.map((item) => item.instanceId),
    );
    expect(usedIds.filter((id) => id === 'locked-fighter')).toHaveLength(1);
  });

  test('allows a three-plane optimum and preserves the fourth slot as null', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: true }),
        plane('attacker-1', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 14, isLandBased: true }),
        plane('attacker-2', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 13, isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 60,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.search.status).toBe('optimal');
    expect(Number.isFinite(result.search.budget)).toBe(true);
    expect(result.results[0].bases[0].loadout.filter(Boolean)).toHaveLength(3);
    expect(result.results[0].bases[0].loadout[3]).toBeNull();
  });

  test('allows a zero-plane base when the static target and radius permit it', () => {
    const result = optimizeLoadouts({
      equipment: [],
      baseCount: 1,
      targetRadius: 0,
      enemyAir: 0,
      targetStates: ['none', 'none'],
      maxResults: 1,
    });

    expect(result.search.status).toBe('optimal');
    expect(result.results[0].bases[0].loadout).toEqual([null, null, null, null]);
  });

  test('keeps a locked empty slot empty while filling other slots', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: true }),
        plane('attacker-1', { radius: 8, role: 'attacker', torpedo: 14, isLandBased: true }),
        plane('attacker-2', { radius: 8, role: 'attacker', torpedo: 13, isLandBased: true }),
        plane('attacker-3', { radius: 8, role: 'attacker', torpedo: 12, isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity'],
      lockedBases: [{ slots: [
        { plane: null, locked: false },
        { plane: null, locked: true },
        { plane: null, locked: false },
        { plane: null, locked: false },
      ] }],
      maxResults: 1,
    });

    expect(result.results[0].bases[0].loadout[1]).toBeNull();
    expect(result.results[0].bases[0].loadout.filter(Boolean)).toHaveLength(3);
  });

  test('treats a directly null legacy slot constraint as open', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 0,
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [null] }],
      maxResults: 1,
    });

    expect(result.search.status).toBe('optimal');
    expect(result.results[0].bases[0].loadout[0]?.instanceId).toBe('fighter');
  });

  test('globally reserves an item locked in a later base', () => {
    const reserved = plane('reserved-later', {
      antiAir: 14,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const result = optimizeLoadouts({
      equipment: [
        reserved,
        plane('fighter-2', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: true }),
        ...Array.from({ length: 6 }, (_, index) => plane(`attacker-${index}`, {
          antiAir: 2,
          radius: 8,
          role: 'attacker',
          torpedo: 14 - index,
          isLandBased: true,
        })),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      lockedBases: [
        { slots: [] },
        { slots: [{ plane: reserved, locked: true }] },
      ],
      maxResults: 1,
    });

    const usedIds = result.results[0].bases.flatMap((base) =>
      base.loadout.filter(Boolean).map((item) => item.instanceId),
    );
    expect(usedIds.filter((id) => id === reserved.instanceId)).toHaveLength(1);
    expect(result.results[0].bases[1].loadout[0].instanceId).toBe(reserved.instanceId);
  });

  test.each([
    ['duplicate', [
      { slots: [{ plane: plane('locked', { radius: 7 }), locked: true }] },
      { slots: [{ plane: plane('locked', { radius: 7 }), locked: true }] },
    ]],
    ['missing', [
      { slots: [{ plane: plane('not-in-inventory', { radius: 7 }), locked: true }] },
    ]],
  ])('returns invalid_input for %s locked instance IDs', (_label, lockedBases) => {
    const result = optimizeLoadouts({
      equipment: [plane('locked', { antiAir: 12, radius: 7, role: 'fighter' })],
      baseCount: lockedBases.length,
      targetRadius: 7,
      enemyAir: 0,
      targetStates: ['supremacy'],
      lockedBases,
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      mode: 'branch-and-bound',
      status: 'invalid_input',
      provenOptimal: false,
    }));
  });

  test('reports budget exhaustion without claiming infeasibility', () => {
    const result = optimizeLoadouts({
      equipment: Array.from({ length: 5 }, (_, index) => plane(`fighter-${index}`, {
        antiAir: 8 + index,
        radius: 7,
        role: 'fighter',
      })),
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity'],
      nodeBudget: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      provenOptimal: false,
      budget: 1,
      optimalityScope: 'model_exact',
    }));
  });

  test('does not claim optimality when a detailed search exhausts its budget', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter', { antiAir: 12, radius: 7, role: 'fighter' }),
        plane('attacker', { antiAir: 2, radius: 7, role: 'attacker', torpedo: 14 }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['superiority', 'superiority'],
      simulationOptions: { seed: 'budget', sampleCount: 8 },
      nodeBudget: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      provenOptimal: false,
    }));
    expect(result.messages.join(' ')).not.toMatch(/infeasible/i);
  });

  test.each([0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 10001])(
    'returns invalid_input for detailed sampleCount %s',
    (sampleCount) => {
      const result = optimizeLoadouts({
        equipment: [plane('fighter', { antiAir: 12, radius: 7, role: 'fighter' })],
        baseCount: 1,
        targetRadius: 7,
        enemy: detailedEnemy(),
        simulationOptions: { sampleCount },
      });

      expect(result.search).toEqual(expect.objectContaining({
        status: 'invalid_input',
        provenOptimal: false,
      }));
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_SAMPLE_COUNT' }),
      ]));
    },
  );

  test.each([1, 3])('returns invalid_input for %s separate enemy fleets', (fleetCount) => {
    const enemyFleets = Array.from({ length: fleetCount }, () => detailedEnemy());
    const result = optimizeLoadouts({
      equipment: [plane('fighter', { antiAir: 12, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemyFleets,
      simulationOptions: { dispatchMode: 'separate', sampleCount: 2 },
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'invalid_input',
      provenOptimal: false,
    }));
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_SEPARATE_ENEMY_FLEETS' }),
    ]));
  });

  test('accounts for detailed simulation samples and skips a leaf atomically when short', () => {
    const options = lockedDetailedOptions(4);
    const short = optimizeLoadouts({ ...options, simulationWorkBudget: 3 });
    const exact = optimizeLoadouts({ ...options, simulationWorkBudget: 4 });

    expect(short.results).toEqual([]);
    expect(short.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      provenOptimal: false,
      simulationSamplesEvaluated: 0,
      simulationBudget: 3,
    }));
    expect(exact.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
      simulationSamplesEvaluated: 4,
      simulationBudget: 4,
      optimalityScope: 'fixed_sample',
      evaluationSampleCount: 4,
    }));
  });

  test('completes the unique detailed terminal at exact node budget and exhausts at one less', () => {
    const options = { ...lockedDetailedOptions(2), simulationWorkBudget: 2 };
    const exact = optimizeLoadouts({ ...options, nodeBudget: 2 });
    const short = optimizeLoadouts({ ...options, nodeBudget: 1 });

    expect(exact.search).toEqual(expect.objectContaining({
      status: 'optimal',
      nodesExplored: 2,
      provenOptimal: true,
      simulationSamplesEvaluated: 2,
    }));
    expect(short.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      nodesExplored: 1,
      provenOptimal: false,
      simulationSamplesEvaluated: 0,
    }));
  });

  test('does not spend detailed node budget walking zero-count equipment groups', () => {
    const equipment = Array.from({ length: 80 }, (_unused, index) => plane(
      `sparse-detailed-${index}`,
      {
        masterId: 3000 + index,
        torpedo: 10,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      },
    ));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'sparse-detailed-groups', sampleCount: 1 },
      nodeBudget: 100,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.search.nodesExplored).toBeLessThanOrEqual(100);
  });

  test('does not cap default detailed simulation work before proving optimality', () => {
    const result = optimizeLoadouts({
      equipment: distinctFighters(8),
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      simulationOptions: { seed: 'uncapped-default', sampleCount: 8 },
      maxResults: 1,
    });

    expect(result.search.simulationBudget).toBe(Infinity);
    expect(result.search.status).toBe('optimal');
    expect(result.search.provenOptimal).toBe(true);
  });

  test('prunes detailed branches whose maximum damage cannot beat a perfect incumbent', () => {
    const equipment = [30, 20, 10, 5].map((torpedo, index) => plane(`damage-${index}`, {
      masterId: 2000 + index,
      torpedo,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    }));
    const sampleCount = 8;
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'detailed-damage-bound', sampleCount },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
      candidatesEvaluated: 1,
    }));
    expect(result.search.solverStats).toEqual(expect.objectContaining({
      candidatesByBase: [1],
      seedCandidatesEvaluated: 4,
    }));
    expect(result.search.simulationSamplesEvaluated)
      .toBe(result.search.solverStats.seedCandidatesEvaluated * sampleCount);
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('damage-0');
  });

  test('passes the incumbent into detailed simulation for fixed-sample pruning', () => {
    const equipment = [
      plane('close-damage-high-air', {
        masterId: 2100,
        torpedo: 14,
        antiAir: 12,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      }),
      plane('close-damage-low-air', {
        masterId: 2101,
        torpedo: 14,
        antiAir: 0,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      }),
    ];
    const sampleCount = 32;
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'detailed-simulation-bound', sampleCount },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search.status).toBe('optimal');
    expect(result.search.provenOptimal).toBe(true);
    const proofSamples = result.search.simulationSamplesEvaluated -
      result.search.solverStats.seedCandidatesEvaluated * sampleCount;
    expect(proofSamples).toBeGreaterThan(0);
    expect(proofSamples).toBeLessThan(sampleCount);
    expect(result.search.numericScoreEvaluations).toBeGreaterThan(0);
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('close-damage-high-air');
  });

  test('counts seed screening while skipping proof simulation when minimum-loss damage cannot win', () => {
    const equipment = [
      plane('minimum-loss-bound-jet', {
        masterId: 2150,
        torpedo: 14,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
        isJet: true,
        isEscortItem: true,
      }),
      plane('minimum-loss-bound-normal', {
        masterId: 2151,
        torpedo: 10,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      }),
    ];
    const sampleCount = 128;
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'minimum-loss-bound', sampleCount },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
      simulationSamplesEvaluated: 2 * sampleCount,
      numericScoreEvaluations: 2,
      candidatesEvaluated: 1,
    }));
    expect(result.results[0].bases[0].loadout[0].instanceId)
      .toBe('minimum-loss-bound-jet');
  });

  test('reuses per-base detailed damage bounds across global combinations', () => {
    const equipment = Array.from({ length: 6 }, (_unused, index) => plane(
      `cached-damage-bound-${index}`,
      {
        masterId: 2170 + index,
        torpedo: 20 - index,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      },
    ));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss', 'loss', 'loss'],
      lockedBases: [0, 1].map(() => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: { seed: 'cached-damage-bound', sampleCount: 8 },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.search.damageUpperBoundEvaluations).toBe(
      result.search.solverStats.candidatesByBase.reduce((total, count) => total + count, 0),
    );
  });

  test('does not grant a free land-recon modifier to detailed damage bounds', () => {
    const equipment = Array.from({ length: 16 }, (_unused, index) => plane(`plain-${index}`, {
      masterId: 2200 + index,
      torpedo: 30 - index / 10,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    }));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      simulationOptions: { seed: 0, sampleCount: 1 },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.search.damageUpperBoundEvaluations).toBeLessThan(equipment.length);
    expect(result.search.candidatesEvaluated).toBeLessThan(equipment.length);
    expect(result.results[0].bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .toEqual(['plain-0', 'plain-1', 'plain-2', 'plain-3']);
  });

  test('proves a different static optimum when a target equipment bonus applies', () => {
    const strong = plane('strong-unbonused', {
      masterId: 300,
      torpedo: 18,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    });
    const weak = plane('weak-bonused', {
      masterId: 301,
      torpedo: 10,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    });
    const result = optimizeLoadouts({
      equipment: [strong, weak],
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
      combatContext: bonusContext(301, 3),
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('weak-bonused');
  });

  test('returns invalid_input for invalid detailed enemy slots', () => {
    const result = optimizeLoadouts({
      equipment: [plane('fighter', { antiAir: 12, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        mode: 'detailed',
        slots: [{
          instanceId: 'enemy-1',
          name: 'Invalid enemy',
          sortieAntiAir: 10,
          currentSlot: 19,
          maxSlot: 18,
        }],
      },
      simulationOptions: { seed: 'invalid', sampleCount: 8 },
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'invalid_input',
      provenOptimal: false,
    }));
    expect(result.messages.join(' ')).toMatch(/currentSlot.*maxSlot/i);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'DETAILED_ENEMY_CURRENT_SLOT_EXCEEDS_MAX',
        slotIndex: 0,
      }),
    ]));
  });

  test('keeps target-feasible detailed plans instead of zero-fulfillment distractions', () => {
    const fighterPlane = plane('fighter', {
      antiAir: 20,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const attackerPlane = plane('attacker', {
      antiAir: 0,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });
    const options = {
      equipment: [fighterPlane, attackerPlane],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['superiority', 'superiority'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'ranking', sampleCount: 32 },
      nodeBudget: Infinity,
      maxResults: 3,
    };

    const result = optimizeLoadouts(options);
    const reversed = optimizeLoadouts({ ...options, equipment: [...options.equipment].reverse() });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('fighter');
    expect(result.results[0].calculationMode).toBe('detailed');
    expect(result.results[0].simulation.allWaveTargetFulfillmentProbability).toBeGreaterThan(0);
    expect(result.results).toHaveLength(1);
    expect(reversed.results.map((plan) => plan.score))
      .toEqual(result.results.map((plan) => plan.score));
  });

  test('reports detailed target infeasibility after every plan has zero fulfillment', () => {
    const attacker = plane('zero-air-attacker', {
      antiAir: 0,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });

    const result = optimizeLoadouts({
      equipment: [attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['superiority', 'superiority'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'zero-fulfillment', sampleCount: 16 },
      nodeBudget: Infinity,
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'infeasible',
      provenOptimal: true,
    }));
  });

  test('does not retain a later zero-fulfillment plan after finding a feasible plan', () => {
    const fighter = plane('supremacy-fighter', {
      antiAir: 30,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const attacker = plane('parity-attacker', {
      antiAir: 10,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });

    const result = optimizeLoadouts({
      equipment: [fighter, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'supremacy'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'late-zero-fulfillment', sampleCount: 16 },
      nodeBudget: Infinity,
      maxResults: 2,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].allWaveTargetFulfillmentProbability).toBeGreaterThan(0);
  });

  test('matches an explicit detailed exhaustive ranking with four equipment choices', () => {
    const equipment = distinctFighters(4);
    const common = {
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      simulationOptions: { seed: 'four-way', sampleCount: 8 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 5,
    };
    const production = optimizeLoadouts({
      ...common,
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    });
    const exhaustive = [null, ...equipment].flatMap((item) => optimizeLoadouts({
      ...common,
      maxResults: 1,
      lockedBases: [{ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort(comparePlansForSort);

    expect(production.search.status).toBe('optimal');
    expect(production.results.map((plan) => plan.canonicalKey))
      .toEqual(exhaustive.map((plan) => plan.canonicalKey));
  });

  test('proves detailed rank one through a reusable base frontier', () => {
    const equipment = distinctFighters(4);
    const common = {
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity'],
      simulationOptions: { seed: 'rank-one-frontier', sampleCount: 8 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
    };
    const production = optimizeLoadouts({
      ...common,
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    });
    const exhaustive = equipment.flatMap((item) => optimizeLoadouts({
      ...common,
      lockedBases: [{ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort(comparePlansForSort);

    expect(production.search).toMatchObject({
      status: 'optimal',
      provenOptimal: true,
      backend: 'detailed-frontier',
    });
    expect(production.results[0].canonicalKey).toBe(exhaustive[0].canonicalKey);
  });

  test('prunes detailed suffixes that cannot share scarce inventory with a viable prefix', () => {
    const scarceAttackers = Array.from({ length: 4 }, (_unused, index) => plane(
      `scarce-detailed-${index}`,
      {
        masterId: 3900,
        antiAir: 16,
        radius: 7,
        role: 'attacker',
        torpedo: 24,
        isLandBased: true,
      },
    ));
    const result = optimizeLoadouts({
      equipment: scarceAttackers,
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['superiority', 'superiority', 'loss', 'loss'],
      simulationOptions: { seed: 'scarce-detailed-inventory-bound', sampleCount: 4 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toMatchObject({
      status: 'optimal',
      provenOptimal: true,
      backend: 'detailed-frontier',
    });
    expect(result.search.solverStats.inventoryCompatibilityPrunes).toBeGreaterThan(0);
    expect(result.search.solverStats.suffixCandidatesEvaluated)
      .toBeLessThan(result.search.solverStats.suffixCandidatesTotal);
    expect(result.search.solverStats.peakRetainedSuffixCandidates).toBeLessThanOrEqual(1);
  });

  test('stops infeasible jet suffixes on a strict fixed-sample incumbent bound', () => {
    const fighters = Array.from({ length: 8 }, (_unused, index) => plane(
      `jet-bound-fighter-${index}`,
      { masterId: 3950, antiAir: 16, radius: 7, role: 'fighter', isLandBased: true },
    ));
    const jets = Array.from({ length: 4 }, (_unused, index) => plane(
      `jet-bound-attacker-${index}`,
      {
        masterId: 3951,
        antiAir: 16,
        radius: 7,
        role: 'attacker',
        torpedo: 40,
        isJet: true,
        isLandBased: true,
      },
    ));
    const result = optimizeLoadouts({
      equipment: [...fighters, ...jets],
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        ...detailedEnemy(),
        stage2Defense: {
          modeled: true,
          byAvoidance: { 0: { fixedLosses: [17], rateFactors: [0] } },
        },
      },
      targetStates: ['superiority', 'superiority', 'superiority', 'superiority'],
      simulationOptions: { seed: 'pj', sampleCount: 32 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.search.solverStats.prefixSimulationBoundPrunes).toBeGreaterThan(0);
    expect(result.search.solverStats.suffixSimulationBoundPrunes).toBeGreaterThan(0);
  });

  test('reports countable progress while proving a two-base detailed optimum', () => {
    const progress = [];
    const result = optimizeLoadouts({
      equipment: distinctFighters(8),
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'countable-progress', sampleCount: 4 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(result.search.provenOptimal).toBe(true);
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'building_prefix_trajectories',
        completedWork: expect.any(Number),
        totalWork: expect.any(Number),
      }),
      expect.objectContaining({
        phase: 'evaluating_suffix_trajectories',
        completedWork: expect.any(Number),
        totalWork: expect.any(Number),
      }),
    ]));
    expect(progress.filter((snapshot) => snapshot.totalWork != null).every((snapshot) =>
      snapshot.completedWork <= snapshot.totalWork)).toBe(true);
    const suffixProgress = progress.filter((snapshot) =>
      snapshot.phase === 'evaluating_suffix_trajectories');
    expect(suffixProgress.some((snapshot) => snapshot.totalWork == null)).toBe(true);
    expect(suffixProgress.at(-1)).toMatchObject({
      completedWork: result.search.solverStats.suffixCandidatesTotal,
      totalWork: result.search.solverStats.suffixCandidatesTotal,
    });
    expect(result.search.solverStats.prefixTrajectorySimulations)
      .toBeLessThan(result.search.solverStats.prefixCandidatesEvaluated);
    expect(result.search.solverStats.prefixTrajectorySimulations)
      .toBeLessThan(result.search.solverStats.prefixStateSignatureProbes);
    expect(result.search.solverStats.trajectoryKeySerializations)
      .toBeLessThan(result.search.solverStats.prefixCandidatesEvaluated);
    expect(result.search.solverStats.suffixTrajectorySimulations)
      .toBeLessThan(result.search.solverStats.suffixCandidatesEvaluated);
  });

  test('reports seed work before publishing the first detailed incumbent', () => {
    const events = [];
    const result = optimizeLoadouts({
      equipment: distinctFighters(8),
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'seed-progress', sampleCount: 4 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
      onProgress: (snapshot) => events.push({ type: 'progress', ...snapshot }),
      onIncumbent: () => events.push({ type: 'incumbent' }),
    });

    const firstIncumbent = events.findIndex((event) => event.type === 'incumbent');
    expect(result.search.provenOptimal).toBe(true);
    expect(firstIncumbent).toBeGreaterThan(0);
    expect(events.slice(0, firstIncumbent)).toContainEqual(expect.objectContaining({
      type: 'progress',
      phase: 'finding_feasible',
      nodesExplored: expect.any(Number),
    }));
    expect(events.slice(0, firstIncumbent).some((event) => event.nodesExplored > 0)).toBe(true);
  });

  test('publishes a large-inventory incumbent within the bounded heuristic seed budget', () => {
    let cancelled = false;
    let randomCalls = 0;
    let firstIncumbentRandomCalls = null;
    /** @type {{ totalNodesExplored: number } | null} */
    let firstIncumbentProgress = null;
    const equipment = Array.from({ length: 64 }, (_, index) => plane(`seed-tradeoff-${index}`, {
      masterId: 3000 + index,
      antiAir: index + 1,
      torpedo: 64 - index,
      bombing: 64 - index,
      radius: 7,
      isLandBased: true,
      role: 'attacker',
    }));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: {
        seed: 'prompt-large-seed',
        sampleCount: 4,
        fixedRandom: () => {
          randomCalls += 1;
          return 0.5;
        },
      },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
      isCancelled: () => cancelled,
      onIncumbent: (_plan, progress) => {
        if (firstIncumbentProgress) return;
        firstIncumbentProgress = progress;
        firstIncumbentRandomCalls = randomCalls;
        cancelled = true;
      },
    });

    expect(firstIncumbentProgress).not.toBeNull();
    if (!firstIncumbentProgress) throw new Error('Expected a feasible incumbent.');
    expect(firstIncumbentProgress.totalNodesExplored).toBeLessThanOrEqual(20000);
    expect(firstIncumbentRandomCalls).toBeLessThanOrEqual(2000);
    expect(result.search).toMatchObject({ status: 'cancelled', provenOptimal: false });
    expect(result.results).toHaveLength(1);
  }, 30000);

  test('does not prune a second-wave target made feasible by first-wave enemy losses', () => {
    const fighter = plane('fighter', {
      antiAir: 20,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const attacker = plane('attacker', {
      antiAir: 10,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });
    const common = {
      equipment: [fighter, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'superiority'],
      simulationOptions: { seed: 's48', sampleCount: 1 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 2,
    };
    const production = optimizeLoadouts({
      ...common,
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    });
    const exhaustive = [fighter, attacker].flatMap((item) => optimizeLoadouts({
      ...common,
      maxResults: 1,
      lockedBases: [{ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort(comparePlansForSort);

    expect(exhaustive[0].bases[0].loadout[0].instanceId).toBe('attacker');
    expect(production.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(production.results.map((plan) => plan.canonicalKey))
      .toEqual(exhaustive.map((plan) => plan.canonicalKey));
  });

  test('honors a finite budget before enumerating 45 distinct groups', () => {
    const result = optimizeLoadouts({
      equipment: distinctFighters(45),
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity'],
      nodeBudget: 1,
      maxResults: 1,
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      provenOptimal: false,
      budget: 1,
    }));
  }, 2000);

  test('streams a complete 45-group search without retaining every candidate', () => {
    const result = optimizeLoadouts({
      equipment: distinctFighters(45),
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity'],
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
  }, 20000);

  test('does not exhaust a budget that ends exactly on the only leaf', () => {
    const fighter = plane('only-locked', { antiAir: 12, radius: 7, role: 'fighter' });
    const result = optimizeLoadouts({
      equipment: [fighter],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 0,
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [
        { plane: fighter, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      nodeBudget: 2,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      nodesExplored: 2,
      provenOptimal: true,
    }));
  });

  test('reports infeasible only after exhausting the search', () => {
    const result = optimizeLoadouts({
      equipment: [plane('short', { antiAir: 20, radius: 2, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 9,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      nodeBudget: Infinity,
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'infeasible',
      provenOptimal: true,
    }));
  });

  test('reports target-air infeasibility when radius is reachable', () => {
    const result = optimizeLoadouts({
      equipment: [plane('reachable-but-weak', { antiAir: 0, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 999,
      targetStates: ['supremacy', 'supremacy'],
      nodeBudget: Infinity,
    });

    expect(result.search.status).toBe('infeasible');
    expect(result.messages).toEqual(['No loadout can satisfy the target air state.']);
  });

  test('does not mislabel global range competition as target-air failure', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('short-1', { radius: 4, role: 'fighter' }),
        plane('short-2', { radius: 4, role: 'fighter' }),
        plane('only-recon', { radius: 8, role: 'recon', equipType: 49 }),
      ],
      baseCount: 2,
      targetRadius: 6,
      enemyAir: 0,
      targetStates: ['none', 'none', 'none', 'none'],
      nodeBudget: Infinity,
    });

    expect(result.search.status).toBe('infeasible');
    expect(result.messages).toEqual([
      'No loadout can satisfy all range, air, inventory, and lock constraints.',
    ]);
  });

  test('clears exact internal proficiency while finding the minimum visible level', () => {
    const result = optimizeLoadouts({
      equipment: [plane('max-trained-fighter', {
        antiAir: 4,
        radius: 7,
        role: 'fighter',
        proficiency: 7,
        internalProficiency: 120,
      })],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 50,
      targetStates: ['parity', 'parity'],
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.results[0].bases[0].minimumProficiency).toBe(7);
  });

  test('does not truncate the only feasible target-air combination after 72 distractions', () => {
    const distractions = Array.from({ length: 73 }, (_, index) => plane(`damage-${index}`, {
      antiAir: 1,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    }));
    const fighter = plane('only-fighter', {
      antiAir: 8,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });

    const result = optimizeLoadouts({
      equipment: [...distractions, fighter],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 63,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
      nodeBudget: Infinity,
    });

    expect(result.search.status).toBe('optimal');
    expect(result.results[0].bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .toContain('only-fighter');
  }, 20000);

  test('proves an obvious one-base damage optimum without enumerating every distraction', () => {
    const best = [20, 19, 18, 17].map((torpedo, index) => plane(`best-${index}`, {
      masterId: 2000 + index,
      antiAir: 8,
      radius: 7,
      role: 'attacker',
      torpedo,
      isLandBased: true,
    }));
    const distractions = Array.from({ length: 80 }, (_, index) => plane(`weak-${index}`, {
      masterId: 3000 + index,
      antiAir: 8,
      radius: 7,
      role: 'attacker',
      torpedo: 1 + (index % 5),
      isLandBased: true,
    }));

    const result = optimizeLoadouts({
      equipment: [...distractions, ...best],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 10,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
      nodeBudget: 2000,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.results[0].bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .toEqual(expect.arrayContaining(best.map((item) => item.instanceId)));
  });

  test('proves a two-base scarce-air allocation without walking every zero group', () => {
    const fighters = Array.from({ length: 24 }, (_, index) => plane(`allocation-fighter-${index}`, {
      masterId: 4000 + index,
      antiAir: 10 + (index % 3),
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    }));
    const attackers = Array.from({ length: 24 }, (_, index) => plane(`allocation-attacker-${index}`, {
      masterId: 5000 + index,
      antiAir: 4,
      radius: 7,
      role: 'attacker',
      torpedo: 30 - index,
      isLandBased: true,
    }));

    const result = optimizeLoadouts({
      equipment: [...attackers, ...fighters],
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 180,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
      nodeBudget: Infinity,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
      backend: 'frontier-dp',
    }));
    expect(result.search.solverStats.groupsRemoved).toBeGreaterThan(0);
    expect(result.results[0].bases).toHaveLength(2);
    expect(result.results[0].bases.every((base) => base.fulfilled)).toBe(true);
  });

  test('finds a multi-base seed without spending exact proof nodes', () => {
    const equipment = [
      plane('seed-fighter-1', { antiAir: 14, radius: 7, role: 'fighter' }),
      plane('seed-fighter-2', { antiAir: 13, radius: 7, role: 'fighter' }),
      ...Array.from({ length: 6 }, (_, index) => plane(`seed-attacker-${index}`, {
        antiAir: 4,
        radius: 7,
        role: 'attacker',
        torpedo: 20 - index,
        isLandBased: true,
      })),
    ];
    let cancel = false;

    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 120,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
      nodeBudget: Infinity,
      isCancelled: () => cancel,
      onIncumbent: () => {
        cancel = true;
      },
    });

    expect(result.results[0].fulfilled).toBe(true);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'cancelled',
      provenOptimal: false,
    }));
    expect(result.search.nodesExplored).toBeGreaterThan(0);
  });

  test('detailed frontier keeps a candidate that reaches a stricter second wave after losses', () => {
    const fighter = plane('frontier-second-wave-fighter', {
      antiAir: 20,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const attacker = plane('frontier-second-wave-attacker', {
      antiAir: 10,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });
    const common = {
      equipment: [fighter, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'superiority'],
      simulationOptions: { seed: 's48', sampleCount: 1 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
    };
    const production = optimizeLoadouts({
      ...common,
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    });
    const exhaustive = [fighter, attacker].flatMap((item) => optimizeLoadouts({
      ...common,
      nodeBudget: 100,
      lockedBases: [{ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort(comparePlansForSort);

    expect(production.search).toMatchObject({
      backend: 'detailed-frontier',
      status: 'optimal',
      provenOptimal: true,
    });
    expect(production.results[0].canonicalKey).toBe(exhaustive[0].canonicalKey);
    expect(production.results[0].bases[0].loadout[0].instanceId)
      .toBe('frontier-second-wave-attacker');
  });

  test('emits a detailed multi-base seed before spending exact proof nodes', () => {
    const equipment = [
      plane('detailed-seed-fighter-1', { antiAir: 14, radius: 7, role: 'fighter' }),
      plane('detailed-seed-fighter-2', { antiAir: 13, radius: 7, role: 'fighter' }),
      ...Array.from({ length: 6 }, (_unused, index) => plane(
        `detailed-seed-attacker-${index}`,
        {
          antiAir: 4,
          radius: 7,
          role: 'attacker',
          torpedo: 20 - index,
          isLandBased: true,
        },
      )),
    ];
    let cancel = false;

    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'detailed-seed', sampleCount: 2 },
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      isCancelled: () => cancel,
      onIncumbent: () => {
        cancel = true;
      },
    });

    expect(result.results[0].allWaveTargetFulfillmentProbability).toBeGreaterThan(0);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'cancelled',
      provenOptimal: false,
      nodesExplored: 0,
    }));
  });

  test('derives later-base air constraints from fixed-sample remaining enemy air', () => {
    const equipment = [
      plane('dynamic-air-fighter-1', { antiAir: 14, radius: 7, role: 'fighter' }),
      plane('dynamic-air-fighter-2', { antiAir: 13, radius: 7, role: 'fighter' }),
      ...Array.from({ length: 6 }, (_unused, index) => plane(
        `dynamic-air-attacker-${index}`,
        {
          antiAir: 4,
          radius: 7,
          role: 'attacker',
          torpedo: 20 - index,
          isLandBased: true,
        },
      )),
    ];
    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'dynamic-air-bound', sampleCount: 8 },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.search.dynamicAirBoundEvaluations).toBeGreaterThan(0);
    expect(result.search.prefixDamageBoundEvaluations).toBeGreaterThan(0);
    expect(result.results[0].allWaveTargetFulfillmentProbability).toBe(1);
    expect(result.results[0].bases.some((base) => base.fighterCount > 0)).toBe(true);
  });

});

/** Creates one complete fragile enemy for combat-objective optimizer tests. */
function combatEnemy() {
  return {
    mode: 'detailed',
    slots: [],
    ships: [{
      id: 'production-fragile-dd',
      name: 'Production fragile DD',
      hp: 1,
      armor: 0,
      evasion: 0,
      luck: 0,
      type: 2,
      speed: 10,
      sourceShipIndex: 0,
      fleet: 'main',
      fleetShipIndex: 0,
      isFlagship: true,
    }],
  };
}

/** Creates a legacy optimizer fixture with explicit aircraft capabilities. */
function plane(instanceId, overrides = {}) {
  const role = overrides.role ?? 'attacker';
  const equipType = role === 'fighter' ? 48 : role === 'recon' ? 49 : 47;
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
    equipType,
    isPlane: true,
    isFighter: role === 'fighter',
    isAttacker: role === 'attacker',
    isLandAttacker: role === 'attacker',
    isRecon: role === 'recon',
    isLandRecon: role === 'recon',
    scout: role === 'recon' ? 8 : 0,
    role,
    torpedo: 0,
    bombing: 0,
    isLandBased: false,
    ...overrides,
  };
}

function bonusContext(masterId, multiplier) {
  return {
    targetTags: ['event-test'],
    multiplierRules: [{
      id: `bonus-${masterId}`,
      enabled: true,
      targetTags: ['event-test'],
      equipmentMasterIds: [masterId],
      equipmentTypes: [],
      group: `bonus-${masterId}`,
      multiplier,
    }],
  };
}

/** Creates formula-distinct fighter groups for streaming search probes. */
function distinctFighters(count) {
  return Array.from({ length: count }, (_, index) => plane(`distinct-${index}`, {
    masterId: 1000 + index,
    antiAir: 8 + (index % 5),
    radius: 7,
    role: 'fighter',
  }));
}

/** Creates a detailed enemy fleet for optimizer simulation tests. */
function detailedEnemy() {
  return {
    mode: 'detailed',
    slots: [{
      instanceId: 'enemy-fighter',
      name: 'Enemy fighter',
      sortieAntiAir: 10,
      currentSlot: 18,
      maxSlot: 18,
    }],
  };
}

/** Creates a unique all-locked detailed plan for exact budget tests. */
function lockedDetailedOptions(sampleCount) {
  const fighter = plane('locked-detailed', {
    antiAir: 12,
    radius: 7,
    role: 'fighter',
  });
  return {
    equipment: [fighter],
    baseCount: 1,
    targetRadius: 7,
    enemy: detailedEnemy(),
    lockedBases: [{ slots: [
      { plane: fighter, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
    ] }],
    simulationOptions: { seed: 'exact-budget', sampleCount },
    nodeBudget: Infinity,
    maxResults: 1,
  };
}
