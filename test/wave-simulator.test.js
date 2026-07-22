import { describe, expect, test } from 'vitest';
import waveSimulator from '../src/wave-simulator.js';
import randomModule from '../src/random.js';

const {
  enemyStageOneLoss,
  monteCarloWaveSequence,
  playerStageOneLoss,
  simulateWaveSequence,
} = waveSimulator;
const { commonRandomNumber, createSeededRandom } = randomModule;

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
    expect(result.waves[0].ownSlotsAfter).toEqual(result.waves[0].ownSlotsBefore);
    expect(result.waves[1].ownSlotsAfter[0]).toBeLessThan(result.waves[1].ownSlotsBefore[0]);
    expect(calls.filter(([, side]) => side === 'player')).toHaveLength(1);
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
      [1, 'player', 0, 0],
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

  test('keeps physical slot indices stable when a loadout contains null slots', () => {
    const calls = [];
    simulateWaveSequence({
      bases: [[null, fighter('second-slot')]],
      enemy: enemyFleet('same-node', 18),
      random: (...coordinates) => {
        calls.push(coordinates);
        return 0.5;
      },
    });

    expect(calls.filter(([, side]) => side === 'player').map(([, , slot]) => slot))
      .toEqual([1]);
  });
});

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
