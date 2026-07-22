import { describe, expect, test } from 'vitest';
import waveSimulator from '../src/wave-simulator.js';
import randomModule from '../src/random.js';
import damageModule from '../src/damage.js';
import aircraftModule from '../src/aircraft.js';

const {
  enemyStageOneLoss,
  createDetailedDamageBoundContext,
  createDetailedScoreContext,
  evaluateDetailedPlanScore,
  maximumDetailedExpectedDamage,
  monteCarloWaveSequence,
  playerStageOneLoss,
  simulateWaveSequence,
} = waveSimulator;
const { commonRandomNumber, createFixedSampleRandom, createSeededRandom } = randomModule;
const { calculateBaseDamagePower } = damageModule;
const { aircraftEquivalenceKey } = aircraftModule;

describe('wave simulator', () => {
  test('provides repeatable sequential and coordinate-addressed random draws', () => {
    const first = createSeededRandom('seed');
    const second = createSeededRandom('seed');
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
    expect(commonRandomNumber('seed', 1, 2, 'enemy', 3, 4))
      .toBe(commonRandomNumber('seed', 1, 2, 'enemy', 3, 4));
    expect(commonRandomNumber('seed', 1, 2, 'enemy', 3, 4))
      .not.toBe(commonRandomNumber('seed', 1, 2, 'enemy', 3, 5));
  });

  test('uses explicit state constants and exact player Stage 1 random boundaries', () => {
    expect(playerStageOneLoss('supremacy', 18, () => 0)).toBe(0);
    expect(playerStageOneLoss('loss', 18, () => 0.999999)).toBe(10);
    expect(playerStageOneLoss('loss', 18, () => 0.999999, { isJet: true })).toBe(6);
    expect(playerStageOneLoss('loss', 18, () => 0.999999, {
      isJet: true,
      isAswPatrol: true,
      isAttacker: false,
    })).toBe(6);
    expect(playerStageOneLoss('loss', 18, () => 0.999999, {
      isAswPatrol: true,
      isAttacker: false,
    })).toBe(9);
    expect(() => playerStageOneLoss('none', 18, () => 0)).toThrow(/NONE/i);
  });

  test('draws two independent enemy Stage 1 integers at their boundaries', () => {
    expect(enemyStageOneLoss('supremacy', 18, sequenceRandom([0, 0]))).toBe(0);
    expect(enemyStageOneLoss('supremacy', 18, sequenceRandom([0.999999, 0.999999]))).toBe(18);
    expect(enemyStageOneLoss('loss', 18, sequenceRandom([0.999999, 0.999999]))).toBe(1);
    expect(() => enemyStageOneLoss('none', 18, () => 0)).toThrow(/NONE/i);
  });

  test('carries first-wave enemy losses into concentrated second-wave air power', () => {
    const calls = [];
    const result = simulateWaveSequence({
      bases: [[fighter('fighter', { currentSlot: 18 })]],
      enemy: enemyFleet('same-node', 18),
      targetStates: ['parity', 'parity'],
      random: (...coordinates) => {
        calls.push(coordinates);
        return 0.999999;
      },
    });

    expect(result.waves).toHaveLength(2);
    expect(result.waves[0].enemyAirAfter).toBeLessThan(result.waves[0].enemyAirBefore);
    expect(result.waves[1].enemyAirBefore).toBe(result.waves[0].enemyAirAfter);
    expect(result.waves[0].ownSlotsAfter[0]).toBeLessThan(result.waves[0].ownSlotsBefore[0]);
    expect(result.waves[1].ownSlotsBefore).toEqual(result.waves[0].ownSlotsBefore);
    expect(result.waves[1].ownSlotsAfter[0]).toBeLessThan(result.waves[1].ownSlotsBefore[0]);
    expect(calls.filter(([, side]) => side === 'player')).toHaveLength(2);
  });

  test('requires independent fleets for separate dispatch and carries only own losses', () => {
    expect(() => simulateWaveSequence({
      bases: [[fighter('fighter')]],
      enemy: enemyFleet('one', 18),
      dispatchMode: 'separate',
    })).toThrow(RangeError);
    expect(() => simulateWaveSequence({
      bases: [[fighter('fighter')]],
      enemyFleets: [
        enemyFleet('one', 18),
        enemyFleet('two', 18),
        enemyFleet('three', 18),
      ],
      dispatchMode: 'separate',
    })).toThrow(/exactly two independent/i);

    const result = simulateWaveSequence({
      bases: [[fighter('fighter')]],
      enemyFleets: [enemyFleet('target-a', 18), enemyFleet('target-b', 18)],
      dispatchMode: 'separate',
      random: () => 0.999999,
    });

    expect(result.waves[1].enemyAirBefore).toBe(result.waves[0].enemyAirBefore);
    expect(result.waves[1].ownSlotsBefore).toEqual(result.waves[0].ownSlotsAfter);
    expect(result.waves[1].ownSlotsAfter[0]).toBeLessThan(result.waves[1].ownSlotsBefore[0]);
  });

  test('records jet assault as an independent Stage 1 phase', () => {
    const result = simulateWaveSequence({
      bases: [[fighter('jet', {
        currentSlot: 100,
        slotSize: 100,
        isJet: true,
        cost: 10,
      })]],
      enemy: enemyFleet('same-node', 18),
      random: () => 0.999999,
    });

    expect(result.waves[0].jetAssault).toEqual(expect.objectContaining({
      phase: 'jetAssault',
      usedSteel: 200,
    }));
    expect(result.waves[0].jetAssault.ownSlotsAfter[0])
      .toBeLessThan(result.waves[0].jetAssault.ownSlotsBefore[0]);
    expect(result.waves[1].jetAssault).toBeNull();
  });

  test('applies enemy Stage 2 to non-fighter jets during jet assault', () => {
    const defense = {
      modeled: true,
      byAvoidance: {
        0: { fixedLosses: [2], rateFactors: [0] },
      },
    };
    const jetBomber = fighter('jet-bomber', {
      equipType: 57,
      currentSlot: 18,
      slotSize: 18,
      isJet: true,
      isFighter: false,
      isAttacker: true,
      bombing: 12,
      cost: 10,
    });
    const common = {
      bases: [[jetBomber]],
      enemy: { mode: 'detailed', slots: [], stage2Defense: defense },
      targetStates: ['supremacy', 'supremacy'],
      sampleCount: 1,
    };
    const random = (_wave, side) => side.startsWith('jet-stage2') ? 0.999999 : 0;
    const result = simulateWaveSequence({ ...common, random });

    expect(result.waves[0].jetAssault).toMatchObject({
      stage2Modeled: true,
      slotDetails: [{
        stageOneLoss: 0,
        stageTwoLoss: 2,
        loss: 2,
        after: 16,
      }],
    });
    expect(result.limitations).not.toContain('JET_STAGE2_OMITTED');

    const fixedRandom = (_sample, wave, side) => random(wave, side);
    expect(evaluateDetailedPlanScore({ ...common, fixedRandom }).expectedDamage)
      .toBe(monteCarloWaveSequence({ ...common, fixedRandom }).expectedDamage);
  });

  test.each(['concentrated', 'separate'])(
    'does not run jet assault or consume steel at an air-raid cell in %s mode',
    (dispatchMode) => {
      const calls = [];
      const airRaid = { ...enemyFleet('air-raid', 18), isAirRaidCell: true };
      const result = simulateWaveSequence({
        bases: [[fighter('jet', {
          currentSlot: 100,
          slotSize: 100,
          isJet: true,
          cost: 10,
        })]],
        ...(dispatchMode === 'separate'
          ? {
            enemyFleets: [
              airRaid,
              { ...enemyFleet('air-raid-2', 18), isAirRaidCell: true },
            ],
          }
          : { enemy: airRaid }),
        dispatchMode,
        random: (...coordinates) => {
          calls.push(coordinates);
          return 0.999999;
        },
      });

      expect(result.waves.every((wave) => wave.jetAssault === null)).toBe(true);
      expect(result.totalUsedSteel).toBe(0);
      expect(calls.some(([, side]) => side === 'jet-player')).toBe(false);
    },
  );

  test('runs jet assault once for each ordinary separate target', () => {
    const result = simulateWaveSequence({
      bases: [[fighter('jet', {
        currentSlot: 100,
        slotSize: 100,
        isJet: true,
        cost: 10,
      })]],
      enemyFleets: [enemyFleet('target-a', 18), enemyFleet('target-b', 18)],
      dispatchMode: 'separate',
      random: () => 0.999999,
    });

    expect(result.waves.map((wave) => wave.jetAssault?.phase))
      .toEqual(['jetAssault', 'jetAssault']);
    expect(result.totalUsedSteel).toBeGreaterThan(0);
  });

  test('uses only the second-wave parity constant after denial reduces enemy air', () => {
    const calls = [];
    const basePlane = fighter('denial-to-parity', { antiAir: 6, currentSlot: 18 });
    const result = simulateWaveSequence({
      bases: [[basePlane]],
      enemy: enemyFleet('same-node', 18),
      random: (...coordinates) => {
        calls.push(coordinates);
        return 0.999999;
      },
    });

    expect(result.waves.map((wave) => wave.state.key)).toEqual(['denial', 'parity']);
    expect(calls.filter(([, side]) => side === 'player')).toEqual([
      [0, 'player', expect.any(Number), 0],
      [1, 'player', expect.any(Number), 0],
    ]);
    expect(result.waves[1].ownSlotLoss)
      .toBe(playerStageOneLoss('parity', 18, () => 0.999999, basePlane));
    expect(result.waves[1].ownSlotLoss)
      .not.toBe(playerStageOneLoss('denial', 18, () => 0.999999, basePlane));
  });

  test('reproduces complete Monte Carlo output for the same seed and options', () => {
    const options = {
      bases: [[fighter('fighter')]],
      enemy: enemyFleet('same-node', 18),
      targetStates: ['parity', 'parity'],
      seed: 'repeatable',
      sampleCount: 32,
    };

    const result = monteCarloWaveSequence(options);
    expect(result).toEqual(monteCarloWaveSequence(options));
    expect(result.expectedFinalOwnAir).toHaveLength(1);
    expect(result.expectedFinalEnemyAir).toHaveLength(1);
    expect(monteCarloWaveSequence({ ...options, seed: 'different' }))
      .not.toEqual(result);
  });

  test('uses a supplied fixed-sample random table without changing simulation semantics', () => {
    const options = {
      bases: [[fighter('fixed-table-fighter')]],
      enemy: enemyFleet('fixed-table-enemy', 18),
      targetStates: ['parity', 'parity'],
      seed: 'fixed-table',
      sampleCount: 32,
    };
    const fixedRandom = createFixedSampleRandom(options.seed, options.sampleCount);

    expect(monteCarloWaveSequence({ ...options, fixedRandom }))
      .toEqual(monteCarloWaveSequence(options));

    const zeroRandomResult = monteCarloWaveSequence({
      ...options,
      fixedRandom: () => 0,
    });
    const exactZeroRandom = simulateWaveSequence({ ...options, random: () => 0 });
    expect(zeroRandomResult.expectedDamage).toBe(exactZeroRandom.totalDamage);
    expect(zeroRandomResult.expectedEnemySlotLoss).toBe(exactZeroRandom.totalEnemySlotLoss);
    expect(zeroRandomResult.expectedOwnSlotLoss).toBe(exactZeroRandom.totalOwnSlotLoss);
  });

  test('applies the same equipment multiplier to both detailed waves', () => {
    const attacker = fighter('bonus-attacker', {
      masterId: 301,
      antiAir: 0,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 14,
      bombing: 14,
    });
    const result = simulateWaveSequence({
      bases: [[attacker]],
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
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
      random: () => 0,
    });

    expect(result.waves.map((wave) => wave.damage)).toEqual([223, 223]);
    expect(result.totalDamage).toBe(446);
  });

  test('applies enemy Stage 2 and lets weak shootdown avoidance preserve more attackers', () => {
    const defense = {
      modeled: true,
      byAvoidance: {
        0: { fixedLosses: [7], rateFactors: [0.2] },
        1: { fixedLosses: [4], rateFactors: [0.12] },
      },
    };
    const common = {
      enemy: { mode: 'detailed', slots: [], stage2Defense: defense },
      targetStates: ['supremacy', 'supremacy'],
      random: (_wave, side) => side === 'player' ? 0 : 0.999999,
    };
    const ordinary = simulateWaveSequence({
      ...common,
      bases: [[fighter('ordinary-galaxy', {
        equipType: 47,
        isFighter: false,
        isAttacker: true,
        isLandAttacker: true,
        torpedo: 14,
        shootDownAvoidance: 0,
      })]],
    });
    const resistant = simulateWaveSequence({
      ...common,
      bases: [[fighter('egusa-galaxy', {
        equipType: 47,
        isFighter: false,
        isAttacker: true,
        isLandAttacker: true,
        torpedo: 15,
        accuracy: 3,
        shootDownAvoidance: 1,
      })]],
    });

    expect(ordinary.waves[0].ownSlotDetails[0].stageTwoLoss).toBe(10);
    expect(resistant.waves[0].ownSlotDetails[0].stageTwoLoss).toBe(6);
    expect(resistant.totalDamage).toBeGreaterThan(ordinary.totalDamage);
    expect(resistant.limitations).not.toContain('PLAYER_STAGE2_OMITTED');

    const fixedRandom = (_sample, _wave, side) => side === 'player' ? 0 : 0.999999;
    const scoreOptions = {
      ...common,
      random: undefined,
      fixedRandom,
      sampleCount: 1,
      bases: [[fighter('egusa-score', {
        equipType: 47,
        isFighter: false,
        isAttacker: true,
        isLandAttacker: true,
        torpedo: 14,
        shootDownAvoidance: 1,
      })]],
    };
    expect(evaluateDetailedPlanScore(scoreOptions).expectedDamage)
      .toBe(monteCarloWaveSequence(scoreOptions).expectedDamage);
  });

  test('stops a fixed-sample candidate once its optimistic score cannot beat the incumbent', () => {
    const result = monteCarloWaveSequence({
      bases: [[fighter('zero-damage')]],
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      seed: 'simulation-bound',
      sampleCount: 32,
      incumbentScore: {
        fulfillment: 1,
        damage: 1,
      },
    });

    expect(result).toEqual(expect.objectContaining({
      prunedBySimulationBound: true,
      samplesEvaluated: 1,
    }));
  });

  test.each(['concentrated', 'separate'])(
    'matches the full Monte Carlo score in %s dispatch mode',
    (dispatchMode) => {
      const firstEnemy = enemyFleet('score-enemy-a', 18);
      const secondEnemy = enemyFleet('score-enemy-b', 12);
      const options = {
        bases: [[fighter('score-fighter')], [fighter('score-attacker', {
          equipType: 47,
          isFighter: false,
          isAttacker: true,
          isLandAttacker: true,
          torpedo: 14,
        })]],
        ...(dispatchMode === 'separate'
          ? { enemyFleets: [firstEnemy, secondEnemy] }
          : { enemy: firstEnemy }),
        dispatchMode,
        targetStates: ['parity', 'parity', 'denial', 'denial'],
        seed: `numeric-score-${dispatchMode}`,
        sampleCount: 64,
      };
      const full = monteCarloWaveSequence(options);
      const score = evaluateDetailedPlanScore(options);

      expect(score).toEqual(expect.objectContaining({
        samplesEvaluated: full.samplesEvaluated,
        allWaveTargetFulfillmentProbability: full.allWaveTargetFulfillmentProbability,
        expectedDamage: full.expectedDamage,
      }));
    },
  );

  test('uses the same fixed-sample stopping boundary as the full simulator', () => {
    const options = {
      bases: [[fighter('numeric-prune')]],
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      seed: 'numeric-prune',
      sampleCount: 32,
      incumbentScore: { fulfillment: 1, damage: Number.MAX_SAFE_INTEGER },
    };

    expect(evaluateDetailedPlanScore(options)).toEqual(expect.objectContaining({
      prunedBySimulationBound: true,
      samplesEvaluated: monteCarloWaveSequence(options).samplesEvaluated,
    }));
  });

  test('keeps fixed-sample player losses stable when equipment slots are permuted', () => {
    const stronger = fighter('permutation-stronger', {
      antiAir: 3,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 18,
    });
    const weaker = fighter('permutation-weaker', {
      antiAir: 3,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 8,
    });
    const common = {
      enemy: enemyFleet('permutation-enemy', 18),
      targetStates: ['loss', 'loss'],
      sampleCount: 32,
      seed: 'player-slot-permutation',
    };
    const forward = { ...common, bases: [[stronger, weaker]] };
    const reversed = { ...common, bases: [[weaker, stronger]] };

    expect(monteCarloWaveSequence(forward).expectedDamage)
      .toBe(monteCarloWaveSequence(reversed).expectedDamage);
    expect(evaluateDetailedPlanScore(forward).expectedDamage)
      .toBe(evaluateDetailedPlanScore(reversed).expectedDamage);
  });

  test('returns the exact maximum remaining enemy air across fixed samples', () => {
    const sampleCount = 16;
    const seed = 'maximum-final-enemy-air';
    const fixedRandom = createFixedSampleRandom(seed, sampleCount);
    const options = {
      bases: [[fighter('enemy-air-prefix')]],
      enemy: enemyFleet('enemy-air-prefix-target', 18),
      targetStates: ['parity', 'parity'],
      sampleCount,
      seed,
      fixedRandom,
    };
    const expected = Math.max(...Array.from({ length: sampleCount }, (_unused, sample) =>
      simulateWaveSequence({
        ...options,
        random: (wave, side, slot, draw) => fixedRandom(sample, wave, side, slot, draw),
      }).finalEnemyAir[0]));

    expect(evaluateDetailedPlanScore(options).maximumFinalEnemyAir).toEqual([expected]);
  });

  test.each([0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 10001])(
    'rejects invalid direct Monte Carlo sampleCount %s',
    (sampleCount) => {
      expect(() => monteCarloWaveSequence({
        bases: [[fighter('fighter')]],
        enemy: enemyFleet('same-node', 18),
        sampleCount,
      })).toThrow(RangeError);
    },
  );

  test('keeps player loss coordinates stable when a loadout contains null slots', () => {
    const playerCoordinate = (base) => {
      const calls = [];
      simulateWaveSequence({
        bases: [base],
        enemy: enemyFleet('same-node', 18),
        random: (...coordinates) => {
          calls.push(coordinates);
          return 0.5;
        },
      });
      return calls.find(([, side]) => side === 'player')?.[2];
    };

    expect(playerCoordinate([null, fighter('second-slot')]))
      .toBe(playerCoordinate([fighter('second-slot')]));
  });

  test('bounds detailed damage by assuming minimum possible player losses', () => {
    const attacker = fighter('attacker', {
      antiAir: 3,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 14,
    });
    const options = {
      bases: [[attacker]],
      enemy: enemyFleet('damage-bound-enemy', 18),
      targetStates: ['loss', 'loss'],
      sampleCount: 128,
      seed: 'damage-upper-bound',
    };

    const actual = monteCarloWaveSequence(options);
    const upper = maximumDetailedExpectedDamage(options);

    expect(upper).toBeGreaterThanOrEqual(actual.expectedDamage);
    expect(upper).toBeGreaterThan(0);
  });

  test('keeps the detailed damage bound above fractional-slot simulations', () => {
    const attacker = fighter('fractional-slot-attacker', {
      antiAir: 3,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 14,
      currentSlot: 17.9,
      slotSize: 17.9,
    });
    const options = {
      bases: [[attacker]],
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      sampleCount: 1,
      seed: '0',
    };

    const actual = monteCarloWaveSequence(options);
    const upper = maximumDetailedExpectedDamage(options);

    expect(upper).toBeGreaterThanOrEqual(actual.expectedDamage);
  });

  test.each(['concentrated', 'separate'])(
    'matches the explicit best-state damage bound in %s dispatch',
    (dispatchMode) => {
      const attacker = fighter(`upper-${dispatchMode}`, {
        antiAir: 3,
        equipType: 47,
        isFighter: false,
        isAttacker: true,
        isLandAttacker: true,
        torpedo: 14,
      });
      const recon = fighter(`recon-${dispatchMode}`, {
        antiAir: 1,
        equipType: 49,
        isFighter: false,
        isRecon: true,
        isLandRecon: true,
        scout: 9,
        currentSlot: 4,
        slotSize: 4,
      });
      const loadout = [attacker, recon];
      const sampleCount = 32;
      const fixedRandom = createFixedSampleRandom(`upper-${dispatchMode}`, sampleCount);
      const expected = explicitMaximumDetailedDamage(loadout, {
        dispatchMode,
        fixedRandom,
        sampleCount,
      });
      const damageBoundContext = createDetailedDamageBoundContext({
        dispatchMode,
        fixedRandom,
        sampleCount,
      });

      expect(maximumDetailedExpectedDamage({
        bases: [loadout],
        damageBoundContext,
        dispatchMode,
        sampleCount,
        fixedRandom,
      })).toBe(expected);
    },
  );

  test('reuses fixed-sample damage contributions across equivalent candidates', () => {
    const loadout = [fighter('cached-upper', {
      antiAir: 3,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 14,
    })];
    const sourceRandom = createFixedSampleRandom('cached-upper', 16);
    let randomDraws = 0;
    const fixedRandom = (...coordinates) => {
      randomDraws += 1;
      return sourceRandom(...coordinates);
    };
    const damageBoundContext = createDetailedDamageBoundContext({
      fixedRandom,
      sampleCount: 16,
    });

    const first = maximumDetailedExpectedDamage({ bases: [loadout], damageBoundContext });
    const firstDraws = randomDraws;
    const second = maximumDetailedExpectedDamage({
      bases: [loadout.map((plane) => ({ ...plane }))],
      damageBoundContext,
    });

    expect(firstDraws).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(randomDraws).toBe(firstDraws);
  });

  test('continues from captured enemy slots without changing the full two-base score', () => {
    const firstBase = [fighter('prefix-attacker', {
      antiAir: 7,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 13,
    })];
    const secondBase = [fighter('suffix-attacker', {
      antiAir: 8,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 14,
    })];
    const common = {
      enemy: {
        mode: 'detailed',
        slots: [{ instanceId: 'continued-enemy', sortieAntiAir: 9, currentSlot: 18 }],
      },
      targetStates: ['denial', 'denial', 'denial', 'denial'],
      sampleCount: 24,
      seed: 'continued-score',
    };

    const full = evaluateDetailedPlanScore({ ...common, bases: [firstBase, secondBase] });
    const prefix = evaluateDetailedPlanScore({
      ...common,
      bases: [firstBase],
      captureFinalEnemySlots: true,
    });
    const suffix = evaluateDetailedPlanScore({
      ...common,
      bases: [secondBase],
      baseIndexOffset: 1,
      initialEnemySlotsBySample: prefix.finalEnemySlotsBySample,
    });

    expect(prefix.finalEnemySlotsBySample).toHaveLength(common.sampleCount);
    expect(suffix.allWaveTargetFulfillmentProbability).toBe(1);
    expect(prefix.totalDamageAcrossSamples + suffix.totalDamageAcrossSamples)
      .toBe(full.totalDamageAcrossSamples);
  });

  test('matches uncached scoring after concentrated trajectory and contribution cache hits', () => {
    const common = {
      enemy: enemyFleet('cache-enemy', 24),
      targetStates: ['denial', 'denial'],
      sampleCount: 32,
      seed: 'cache-equivalence',
    };
    const loadout = [fighter('cache-plane', {
      antiAir: 8,
      equipType: 47,
      isFighter: false,
      isAttacker: true,
      isLandAttacker: true,
      torpedo: 14,
    })];
    const scoreContext = createDetailedScoreContext({ ...common, baseCount: 1 });
    evaluateDetailedPlanScore({
      ...common,
      bases: [loadout],
      captureFinalEnemySlots: true,
      scoreContext,
    });
    const cached = evaluateDetailedPlanScore({
      ...common,
      bases: [loadout.map((plane) => ({ ...plane, instanceId: 'cache-copy' }))],
      captureFinalEnemySlots: true,
      scoreContext,
    });
    const uncached = evaluateDetailedPlanScore({
      ...common,
      bases: [loadout],
      captureFinalEnemySlots: true,
      disableConcentratedSegmentReuse: true,
    });

    expect(cached).toMatchObject({
      enemyTrajectorySimulations: 0,
      damageContributionSimulations: 0,
      allWaveTargetFulfillmentProbability: uncached.allWaveTargetFulfillmentProbability,
      totalDamageAcrossSamples: uncached.totalDamageAcrossSamples,
      finalEnemySlotsBySample: uncached.finalEnemySlotsBySample,
    });
  });

  test('reuses concentrated trajectories and exact damage contributions with enemy Stage 2', () => {
    const stage2Defense = {
      modeled: true,
      byAvoidance: {
        0: { fixedLosses: [6], rateFactors: [0.2] },
        1: { fixedLosses: [3], rateFactors: [0.12] },
      },
    };
    const common = {
      enemy: {
        ...enemyFleet('stage2-cache-enemy', 24),
        stage2Defense,
      },
      targetStates: ['denial', 'denial'],
      sampleCount: 32,
      seed: 'stage2-cache-equivalence',
    };
    const loadout = [
      fighter('stage2-cache-ordinary', {
        antiAir: 7,
        equipType: 47,
        isFighter: false,
        isAttacker: true,
        isLandAttacker: true,
        torpedo: 14,
        shootDownAvoidance: 0,
      }),
      fighter('stage2-cache-avoidance', {
        antiAir: 8,
        equipType: 47,
        isFighter: false,
        isAttacker: true,
        isLandAttacker: true,
        torpedo: 13,
        shootDownAvoidance: 1,
      }),
    ];
    const scoreContext = createDetailedScoreContext({ ...common, baseCount: 1 });
    const first = evaluateDetailedPlanScore({
      ...common,
      bases: [loadout],
      captureFinalEnemySlots: true,
      scoreContext,
    });
    const cached = evaluateDetailedPlanScore({
      ...common,
      bases: [loadout.map((plane) => ({ ...plane }))],
      captureFinalEnemySlots: true,
      scoreContext,
    });
    const uncached = evaluateDetailedPlanScore({
      ...common,
      bases: [loadout],
      captureFinalEnemySlots: true,
      disableConcentratedSegmentReuse: true,
    });

    expect(first).toMatchObject({
      enemyTrajectorySimulations: 1,
      damageContributionSimulations: 2,
    });
    expect(cached).toMatchObject({
      enemyTrajectorySimulations: 0,
      damageContributionSimulations: 0,
      allWaveTargetFulfillmentProbability: uncached.allWaveTargetFulfillmentProbability,
      totalDamageAcrossSamples: uncached.totalDamageAcrossSamples,
      finalEnemySlotsBySample: uncached.finalEnemySlotsBySample,
    });
  });

  test('does not reuse continuation trajectories across base offsets', () => {
    const sampleCount = 24;
    const initialEnemySlotsBySample = Array.from({ length: sampleCount }, () => [[18]]);
    const common = {
      enemy: enemyFleet('offset-enemy', 18),
      targetStates: Array(6).fill('denial'),
      sampleCount,
      seed: 'offset-cache',
    };
    const loadout = [fighter('offset-plane', { antiAir: 7 })];
    const scoreContext = createDetailedScoreContext({ ...common, baseCount: 3 });
    evaluateDetailedPlanScore({
      ...common,
      bases: [loadout],
      baseIndexOffset: 1,
      initialEnemySlotsBySample,
      scoreContext,
    });
    const offsetTwo = evaluateDetailedPlanScore({
      ...common,
      bases: [loadout],
      baseIndexOffset: 2,
      initialEnemySlotsBySample,
      scoreContext,
    });
    const uncachedOffsetTwo = evaluateDetailedPlanScore({
      ...common,
      bases: [loadout],
      baseIndexOffset: 2,
      initialEnemySlotsBySample,
      disableConcentratedSegmentReuse: true,
    });

    expect(offsetTwo.enemyTrajectorySimulations).toBe(1);
    expect(offsetTwo.totalDamageAcrossSamples).toBe(uncachedOffsetTwo.totalDamageAcrossSamples);
    expect(offsetTwo.allWaveTargetFulfillmentProbability)
      .toBe(uncachedOffsetTwo.allWaveTargetFulfillmentProbability);
  });
});

function explicitMaximumDetailedDamage(loadout, options) {
  const coordinates = Array(loadout.length).fill(null);
  loadout
    .map((plane, slotIndex) => ({
      slotIndex,
      key: aircraftEquivalenceKey(plane),
    }))
    .sort((left, right) => left.key.localeCompare(right.key) || left.slotIndex - right.slotIndex)
    .forEach((entry, coordinate) => {
      coordinates[entry.slotIndex] = coordinate;
    });
  let total = 0;
  for (let sample = 0; sample < options.sampleCount; sample += 1) {
    let current = loadout.map((plane) => ({ ...plane }));
    for (let waveIndex = 0; waveIndex < 2; waveIndex += 1) {
      const sortie = options.dispatchMode === 'concentrated'
        ? loadout.map((plane) => ({ ...plane }))
        : current;
      sortie.forEach((plane, slotIndex) => {
        plane.currentSlot -= playerStageOneLoss(
          'supremacy',
          plane.currentSlot,
          () => options.fixedRandom(sample, waveIndex, 'player', coordinates[slotIndex], 0),
          plane,
        );
      });
      if (options.dispatchMode === 'separate') current = sortie;
      total += calculateBaseDamagePower(sortie);
    }
  }
  return total / options.sampleCount;
}

/** Returns deterministic values in call order for formula boundary tests. */
function sequenceRandom(values) {
  let index = 0;
  return () => values[index++];
}

/** Creates one detailed enemy aircraft slot. */
function enemyFleet(instanceId, currentSlot) {
  return {
    mode: 'detailed',
    slots: [{
      instanceId,
      name: instanceId,
      sortieAntiAir: 10,
      currentSlot,
      maxSlot: currentSlot,
    }],
  };
}

/** Creates a simple LBAS fighter fixture. */
function fighter(instanceId, overrides = {}) {
  return {
    instanceId,
    name: instanceId,
    antiAir: 12,
    intercept: 0,
    internalProficiency: 0,
    equipType: 48,
    isPlane: true,
    isFighter: true,
    radius: 7,
    slotSize: 18,
    currentSlot: 18,
    ...overrides,
  };
}
