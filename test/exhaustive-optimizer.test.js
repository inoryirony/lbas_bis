import { describe, expect, test } from 'vitest';
import combatExactModule from '../src/combat-exact-solver.js';
import combatFrontierModule from '../src/combat-frontier-solver.js';
import exhaustiveModule from '../src/exhaustive-optimizer.js';
import optimizer from '../src/optimizer.js';
import scoreModule from '../src/search-score.js';

const { solveCombatExact } = combatExactModule;
const { orderSuffixTransitionsForProof, scalarPlaneCeiling } = combatFrontierModule;
const { exhaustiveOptimize } = exhaustiveModule;
const { optimizeLoadouts, optimisticScoreForPartial, prepareSearch } = optimizer;
const {
  canonicalPlanKey,
  combatScorePlan,
  compareCombatPlanScores,
  comparePlanScores,
  scorePlan,
} = scoreModule;

describe('exhaustive optimizer oracle', () => {
  test('orders complete combat profiles by their strongest suffix before proof', () => {
    const transitions = [
      { key: 'weak-a', combatProfileKey: 'weak', candidates: [{ damage: 10 }] },
      { key: 'strong-b', combatProfileKey: 'strong', candidates: [{ damage: 80 }] },
      { key: 'weak-b', combatProfileKey: 'weak', candidates: [{ damage: 20 }] },
      { key: 'strong-a', combatProfileKey: 'strong', candidates: [{ damage: 100 }] },
    ];

    expect(orderSuffixTransitionsForProof(transitions).map(({ key }) => key)).toEqual([
      'strong-a',
      'strong-b',
      'weak-b',
      'weak-a',
    ]);
  });

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

  test('matches production when explicit equipment tags exclude a stronger candidate', () => {
    const options = {
      equipment: [
        plane('strong-reserved', {
          torpedo: 30,
          role: 'attacker',
          tags: ['reserved-other-operation'],
        }),
        plane('eligible-event', {
          torpedo: 12,
          role: 'attacker',
          tags: ['event-eligible'],
        }),
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
      equipmentTagConstraints: {
        requiredAll: ['event-eligible'],
        excludedAny: ['reserved-other-operation'],
      },
      maxResults: 1,
      nodeBudget: Infinity,
    };

    const production = optimizeLoadouts(options);
    const exhaustive = exhaustiveOptimize(options);

    expect(resultSignatures(production)).toEqual(resultSignatures(exhaustive));
    expect(production.results[0].bases[0].loadout[0].instanceId).toBe('eligible-event');
  });

  test('rejects malformed equipment tag selectors in production and exhaustive search', () => {
    const options = {
      equipment: [plane('candidate')],
      equipmentTagConstraints: {
        requiredAll: ['valid-tag', 7],
      },
    };

    const production = optimizeLoadouts(options);
    const exhaustive = exhaustiveOptimize(options);

    expect(production.search.status).toBe('invalid_input');
    expect(production.messages.join(' ')).toContain('tag selectors');
    expect(exhaustive.search.status).toBe('invalid_input');
    expect(exhaustive.messages.join(' ')).toContain('tag selectors');
  });

  test('can prove the fixed-sample combat optimum when hit rate reverses proxy order', () => {
    const highProxyMiss = plane('high-proxy-miss', {
      masterId: 800,
      torpedo: 20,
      accuracy: 0,
      role: 'attacker',
    });
    const lowerProxyHit = plane('lower-proxy-hit', {
      masterId: 459,
      torpedo: 9,
      bombing: 16,
      accuracy: 1,
      role: 'attacker',
    });
    const result = exhaustiveOptimize({
      equipment: [highProxyMiss, lowerProxyHit],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 0,
      enemy: {
        mode: 'detailed',
        slots: [],
        ships: [{
          id: 'fragile-dd',
          name: 'Fragile DD',
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
      },
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
    });

    expect(result.search).toMatchObject({
      status: 'optimal',
      provenOptimal: true,
      objective: 'combat',
    });
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('lower-proxy-hit');
    expect(result.results[0].simulation).toMatchObject({
      expectedSunkCount: 1,
      expectedHpDamage: 1,
    });
  });

  test('production combat search matches concrete exhaustive rank one on seeded inventories', () => {
    const random = seededRandom(0xc0b447);

    for (let caseIndex = 0; caseIndex < 24; caseIndex += 1) {
      const equipment = Array.from(
        { length: randomInt(random, 2, 5) },
        (_, index) => plane(`combat-${caseIndex}-${index}`, {
          masterId: 700 + randomInt(random, 0, 5),
          radius: 7,
          role: random() < 0.25 ? 'fighter' : 'attacker',
          antiAir: randomInt(random, 0, 12),
          torpedo: randomInt(random, 6, 20),
          bombing: randomInt(random, 6, 18),
          accuracy: randomInt(random, 0, 3),
        }),
      );
      const options = {
        equipment,
        baseCount: 1,
        targetRadius: 7,
        enemy: {
          mode: 'detailed',
          slots: [{
            instanceId: `combat-enemy-slot-${caseIndex}`,
            name: 'Enemy fighter',
            sortieAntiAir: randomInt(random, 3, 12),
            currentSlot: randomInt(random, 1, 18),
            maxSlot: 18,
          }],
          ships: [{
            id: `combat-enemy-${caseIndex}`,
            name: 'Enemy DD',
            hp: randomInt(random, 1, 120),
            armor: randomInt(random, 0, 90),
            evasion: randomInt(random, 0, 80),
            luck: randomInt(random, 0, 60),
            type: 2,
            speed: 10,
            sourceShipIndex: 0,
            fleet: 'main',
            fleetShipIndex: 0,
            isFlagship: true,
          }],
        },
        targetStates: ['denial', 'denial'],
        simulationOptions: {
          sampleCount: caseIndex % 2 === 0 ? 2 : 7,
          seed: `combat-oracle-${caseIndex}`,
        },
        optimizationObjective: 'combat',
        maxResults: 1,
        nodeBudget: Infinity,
        simulationWorkBudget: Infinity,
      };
      const production = optimizeLoadouts(options);
      const exhaustive = exhaustiveOptimize(options);

      expect({
        caseIndex,
        score: combatScorePlan(production.results[0]),
        key: canonicalPlanKey(production.results[0]),
      }).toEqual({
        caseIndex,
        score: combatScorePlan(exhaustive.results[0]),
        key: canonicalPlanKey(exhaustive.results[0]),
      });
      expect(production.search).toMatchObject({
        objective: 'combat',
        provenOptimal: true,
      });
    }
  });

  test('production combat search matches exhaustive allocation across two scarce bases', () => {
    const equipment = [
      plane('scarce-high-hit', {
        masterId: 459,
        torpedo: 9,
        bombing: 16,
        accuracy: 3,
      }),
      plane('scarce-heavy-hit', {
        masterId: 800,
        torpedo: 20,
        accuracy: 2,
      }),
      plane('scarce-low-hit', {
        masterId: 801,
        torpedo: 18,
        accuracy: 0,
      }),
    ];
    const options = {
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: combatFleet('scarce-two-base', 2),
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases: Array.from({ length: 2 }, () => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: {
        sampleCount: 4,
        seed: 'scarce-two-base-combat',
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };

    const production = optimizeLoadouts(options);
    const exhaustive = exhaustiveOptimize(options);

    expect(production.search).toMatchObject({
      backend: 'combat-frontier',
      status: 'optimal',
      provenOptimal: true,
    });
    expect({
      score: combatScorePlan(production.results[0]),
      key: canonicalPlanKey(production.results[0]),
    }).toEqual({
      score: combatScorePlan(exhaustive.results[0]),
      key: canonicalPlanKey(exhaustive.results[0]),
    });
  });

  test('combines disjoint suffix shards into the same proven combat optimum', () => {
    const prefixFighter = plane('shard-prefix-fighter', {
      masterId: 10,
      role: 'fighter',
      antiAir: 12,
    });
    const suffixFighter = plane('shard-suffix-fighter', {
      masterId: 11,
      role: 'fighter',
      antiAir: 12,
    });
    const attackers = [8, 14, 20].map((torpedo, index) => plane(`shard-attacker-${index}`, {
      masterId: 900 + index,
      torpedo,
      accuracy: 5,
    }));
    const options = {
      equipment: [prefixFighter, suffixFighter, ...attackers],
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        ...combatFleet('suffix-shard', 1),
        ships: [{ ...combatFleet('suffix-shard', 1).ships[0], hp: 500 }],
      },
      targetStates: ['none', 'none', 'none', 'none'],
      lockedBases: [{ slots: [
        { plane: prefixFighter, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }, { slots: [
        { plane: suffixFighter, locked: true },
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { sampleCount: 2, fixedRandom: () => 0.1 },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };
    const prepared = prepareSearch(options);
    const unsharded = solveCombatExact(prepared);
    const shards = [0, 1, 2, 3].map((suffixShardIndex) => solveCombatExact(prepared, {
      suffixShardCount: 4,
      suffixShardIndex,
    }));
    const combined = shards.flatMap((shard) => shard.plans)
      .reduce((best, plan) => !best || compareCombatPlanScores(plan, best) > 0 ? plan : best, null);

    expect(shards.every((shard) => shard.provenOptimal === false &&
      shard.solverStats.shardComplete === true)).toBe(true);
    expect(shards.reduce((total, shard) =>
      total + shard.solverStats.suffixTransitionGroupsAssigned, 0))
      .toBe(unsharded.solverStats.suffixTransitionGroups);
    expect(shards.reduce((total, shard) =>
      total + shard.solverStats.prefixCandidates, 0))
      .toBe(unsharded.solverStats.prefixCandidates * 2);
    const shardedSuffixCandidates = shards.reduce((total, shard) =>
      total + shard.solverStats.suffixCandidates, 0);
    expect(shardedSuffixCandidates).toBeGreaterThan(0);
    expect(shardedSuffixCandidates).toBeLessThanOrEqual(
      unsharded.solverStats.suffixCandidates * 2,
    );
    expect(shards.every((shard) =>
      shard.solverStats.suffixCandidates < unsharded.solverStats.suffixCandidates)).toBe(true);
    expect({ score: combatScorePlan(combined), key: canonicalPlanKey(combined) }).toEqual({
      score: combatScorePlan(unsharded.plans[0]),
      key: canonicalPlanKey(unsharded.plans[0]),
    });

    const sampleHeavyPrepared = prepareSearch({
      ...options,
      simulationOptions: { sampleCount: 64, fixedRandom: () => 0.1 },
    });
    const sampleHeavyUnsharded = solveCombatExact(sampleHeavyPrepared);
    const sampleHeavyShards = [0, 1, 2, 3].map((suffixShardIndex) => solveCombatExact(
      sampleHeavyPrepared,
      { suffixShardCount: 4, suffixShardIndex },
    ));
    const sampleHeavyCombined = sampleHeavyShards.flatMap((shard) => shard.plans)
      .reduce((best, plan) => !best || compareCombatPlanScores(plan, best) > 0 ? plan : best, null);

    expect(sampleHeavyShards.every((shard) =>
      shard.solverStats.prefixShardCount === 4 &&
      shard.solverStats.suffixPartitionCount === 1)).toBe(true);
    expect(sampleHeavyShards.reduce((total, shard) =>
      total + shard.solverStats.prefixCandidates, 0))
      .toBe(sampleHeavyUnsharded.solverStats.prefixCandidates);
    expect({
      score: combatScorePlan(sampleHeavyCombined),
      key: canonicalPlanKey(sampleHeavyCombined),
    }).toEqual({
      score: combatScorePlan(sampleHeavyUnsharded.plans[0]),
      key: canonicalPlanKey(sampleHeavyUnsharded.plans[0]),
    });
  });

  test('does not prune an attacker whose combat coordinate ignores a sorted fighter', () => {
    const prefixFighter = plane('bound-prefix-fighter', {
      masterId: 1,
      role: 'fighter',
      antiAir: 12,
    });
    const suffixFighter = plane('bound-suffix-fighter', {
      masterId: 2,
      role: 'fighter',
      antiAir: 12,
    });
    const weakSeed = plane('bound-weak-seed', {
      masterId: 800,
      torpedo: 1,
      accuracy: 5,
    });
    const trueWinner = plane('bound-true-winner', {
      masterId: 801,
      torpedo: 20,
      accuracy: 5,
    });
    const options = {
      equipment: [prefixFighter, suffixFighter, weakSeed, trueWinner],
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        ...combatFleet('fighter-coordinate-bound', 1),
        ships: [{
          ...combatFleet('fighter-coordinate-bound', 1).ships[0],
          hp: 500,
        }],
      },
      targetStates: ['none', 'none', 'none', 'none'],
      lockedBases: [{ slots: [
        { plane: prefixFighter, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }, { slots: [
        { plane: suffixFighter, locked: true },
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 1,
        fixedRandom: (_sample, _wave, side, attackIndex) =>
          side === 'combat-hit' && attackIndex > 0 ? 0.999999 : 0.1,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };

    const production = solveCombatExact(prepareSearch(options), {
      seedLoadouts: [[
        [prefixFighter, null, null, null],
        [suffixFighter, weakSeed, null, null],
      ]],
    });
    const exhaustive = exhaustiveOptimize(options);

    expect(production).toMatchObject({ provenOptimal: true });
    expect({
      score: combatScorePlan(production.plans[0]),
      key: canonicalPlanKey(production.plans[0]),
    }).toEqual({
      score: combatScorePlan(exhaustive.results[0]),
      key: canonicalPlanKey(exhaustive.results[0]),
    });
    expect(exhaustive.results[0].bases[1].loadout.map((item) => item?.instanceId))
      .toContain('bound-true-winner');
  });

  test('aggregates each sample maximum when an attacker can occupy different coordinates', () => {
    const attacker = plane('sample-coordinate-attacker', {
      masterId: 802,
      torpedo: 20,
      accuracy: 5,
    });
    const prepared = prepareSearch({
      equipment: [attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatFleet('sample-coordinate-bound', 1),
        ships: [{
          ...combatFleet('sample-coordinate-bound', 1).ships[0],
          hp: 500,
        }],
      },
      targetStates: ['none', 'none'],
      simulationOptions: {
        sampleCount: 2,
        fixedRandom: (sample, _wave, side, attackIndex) => {
          if (side !== 'combat-hit') return 0;
          return sample === attackIndex ? 0.1 : 0.999999;
        },
      },
      optimizationObjective: 'combat',
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    });

    const ceiling = scalarPlaneCeiling(attacker, prepared, 0, [0, 1]);

    expect(ceiling.totalHits).toBe(
      Array.from(ceiling.hitsByBucket).reduce((total, hits) => total + hits, 0),
    );
    expect(ceiling.totalDamage).toBe(
      Array.from(ceiling.damageByBucket).reduce((total, damage) => total + damage, 0),
    );
  });

  test('two-base combat frontier matches exhaustive rank one on seeded inventories', () => {
    const random = seededRandom(0xf20a71e);

    for (let caseIndex = 0; caseIndex < 24; caseIndex += 1) {
      const equipment = Array.from(
        { length: randomInt(random, 2, 5) },
        (_, index) => plane(`frontier-${caseIndex}-${index}`, {
          masterId: 820 + randomInt(random, 0, 4),
          radius: 7,
          role: random() < 0.3 ? 'fighter' : 'attacker',
          antiAir: randomInt(random, 0, 12),
          torpedo: randomInt(random, 6, 20),
          bombing: randomInt(random, 6, 18),
          accuracy: randomInt(random, 0, 3),
        }),
      );
      const shipCount = randomInt(random, 1, 2);
      const enemy = combatFleet(`frontier-oracle-${caseIndex}`, shipCount);
      enemy.slots = [{
        instanceId: `frontier-oracle-slot-${caseIndex}`,
        name: 'Enemy fighter',
        sortieAntiAir: randomInt(random, 3, 12),
        currentSlot: randomInt(random, 1, 18),
        maxSlot: 18,
      }];
      enemy.ships = enemy.ships.map((ship) => ({
        ...ship,
        hp: randomInt(random, 1, 120),
        armor: randomInt(random, 0, 90),
        evasion: randomInt(random, 0, 80),
        luck: randomInt(random, 0, 60),
      }));
      const options = {
        equipment,
        baseCount: 2,
        targetRadius: 7,
        enemy,
        targetStates: ['none', 'none', 'none', 'none'],
        lockedBases: Array.from({ length: 2 }, () => ({ slots: [
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] })),
        simulationOptions: {
          sampleCount: caseIndex % 2 === 0 ? 2 : 7,
          seed: `frontier-oracle-${caseIndex}`,
        },
        optimizationObjective: 'combat',
        maxResults: 1,
        nodeBudget: Infinity,
        simulationWorkBudget: Infinity,
      };
      const production = optimizeLoadouts(options);
      const exhaustive = exhaustiveOptimize(options);

      expect({
        caseIndex,
        score: combatScorePlan(production.results[0]),
        key: canonicalPlanKey(production.results[0]),
      }).toEqual({
        caseIndex,
        score: combatScorePlan(exhaustive.results[0]),
        key: canonicalPlanKey(exhaustive.results[0]),
      });
      expect(production.search).toMatchObject({
        backend: 'combat-frontier',
        status: 'optimal',
        provenOptimal: true,
      });
    }
  });

  test('two-base combat frontier preserves prefix contact for a loss-state suffix', () => {
    const attacker = plane('contact-frontier-attacker', {
      masterId: 901,
      equipType: 47,
      antiAir: 0,
      torpedo: 14,
      bombing: 14,
    });
    const recon = plane('contact-frontier-recon', {
      masterId: 902,
      equipType: 9,
      role: 'recon',
      antiAir: 100,
      scout: 14,
      accuracy: 3,
      isAttacker: false,
      isLandAttacker: false,
      isRecon: true,
      slotSize: 4,
      currentSlot: 4,
    });
    const enemy = {
      ...combatFleet('contact-frontier', 1),
      slots: [{
        instanceId: 'contact-frontier-enemy-slot',
        name: 'Enemy fighter',
        sortieAntiAir: 10,
        currentSlot: 18,
        maxSlot: 18,
      }],
      ships: [{ ...combatFleet('contact-frontier', 1).ships[0], hp: 1000 }],
    };
    const options = {
      equipment: [attacker, recon],
      baseCount: 2,
      targetRadius: 7,
      enemy,
      targetStates: ['none', 'none', 'none', 'none'],
      lockedBases: Array.from({ length: 2 }, () => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: {
        sampleCount: 1,
        fixedRandom: (_sample, _wave, side) => side === 'combat-hit' ? 0.5 : 0,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };
    const production = optimizeLoadouts(options);
    const exhaustive = exhaustiveOptimize(options);
    expect({
      score: combatScorePlan(production.results[0]),
      key: canonicalPlanKey(production.results[0]),
    }).toEqual({
      score: combatScorePlan(exhaustive.results[0]),
      key: canonicalPlanKey(exhaustive.results[0]),
    });
    expect(production.results[0].bases[0].loadout[0].instanceId).toBe(recon.instanceId);
  });

  test('keeps the land-recon damage bound above exhaustive two-base completions', () => {
    const weak = plane('recon-bound-weak', {
      masterId: 810,
      torpedo: 12,
      bombing: 12,
    });
    const strong = plane('recon-bound-strong', {
      masterId: 811,
      torpedo: 20,
      bombing: 20,
    });
    const skilledRecon = plane('recon-bound-skilled', {
      masterId: 312,
      equipType: 49,
      role: 'recon',
      isAttacker: false,
      isLandAttacker: false,
      isRecon: true,
      isLandRecon: true,
      scout: 9,
      slotSize: 4,
      currentSlot: 4,
    });
    const equipment = [weak, strong, skilledRecon];
    const lockedBases = [weak, strong].map((attacker) => ({ slots: [
      { plane: attacker, locked: true },
      { locked: false },
      { plane: null, locked: true },
      { plane: null, locked: true },
    ] }));
    const options = {
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        ...combatFleet('recon-bound', 1),
        ships: [{
          ...combatFleet('recon-bound', 1).ships[0],
          hp: 750,
        }],
      },
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases,
      simulationOptions: {
        sampleCount: 1,
        fixedRandom: () => 0.5,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };

    const prepared = prepareSearch(options);
    const production = solveCombatExact(prepared, {
      seedLoadouts: [[
        [weak, skilledRecon, null, null],
        [strong, null, null, null],
      ]],
    });
    const exhaustive = exhaustiveOptimize(options);

    expect(production.solverStats.status).toBe('optimal');
    expect(production.provenOptimal).toBe(true);
    expect({
      score: combatScorePlan(production.plans[0]),
      key: canonicalPlanKey(production.plans[0]),
    }).toEqual({
      score: combatScorePlan(exhaustive.results[0]),
      key: canonicalPlanKey(exhaustive.results[0]),
    });
    expect(exhaustive.results[0].bases[1].loadout.map((item) => item?.instanceId))
      .toContain('recon-bound-skilled');
  });

  test('reports combat infeasibility when no plan fulfills every fixed sample', () => {
    const fighter = plane('probabilistic-fighter', {
      role: 'fighter',
      antiAir: 12,
    });
    const attacker = plane('probabilistic-attacker', {
      torpedo: 20,
      accuracy: 3,
    });
    const options = {
      equipment: [fighter, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        ...combatFleet('probabilistic-enemy', 1),
        slots: [{
          instanceId: 'probabilistic-enemy-slot',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      targetStates: ['parity', 'superiority'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: {
        sampleCount: 2,
        fixedRandom: (sample, _wave, side) => side === 'enemy' && sample === 1
          ? 0.999999
          : 0,
      },
      optimizationObjective: 'combat',
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };

    const production = optimizeLoadouts(options);
    const exhaustive = exhaustiveOptimize(options);

    expect(exhaustive.search).toMatchObject({ status: 'infeasible', provenOptimal: true });
    expect(exhaustive.results).toEqual([]);
    expect(production.search).toMatchObject({ status: 'infeasible', provenOptimal: true });
    expect(production.results).toEqual([]);
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

/** Creates a complete fragile fleet for combat-objective oracle fixtures. */
function combatFleet(namespace, shipCount) {
  return {
    mode: 'detailed',
    slots: [],
    ships: Array.from({ length: shipCount }, (_unused, sourceShipIndex) => ({
      id: `${namespace}-${sourceShipIndex}`,
      name: `${namespace}-${sourceShipIndex}`,
      hp: 1,
      armor: 0,
      evasion: 0,
      luck: 0,
      type: 2,
      speed: 10,
      sourceShipIndex,
      fleet: 'main',
      fleetShipIndex: sourceShipIndex,
      isFlagship: sourceShipIndex === 0,
    })),
  };
}
