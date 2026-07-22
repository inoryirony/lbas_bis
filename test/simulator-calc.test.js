import { describe, expect, test } from 'vitest';
import stateModule from '../src/simulator-state.js';
import calcModule from '../src/simulator-calc.js';

const {
  addDetailedEnemySlot,
  createEmptySimulatorState,
  normalizeDetailedEnemySlots,
  normalizeSimulatorState,
  removeDetailedEnemySlot,
  setBaseSlot,
  setDetailedEnemySlot,
  setWaveTarget,
} = stateModule;
const { calculateEnemyAirLines, calculateSimulatorSummary } = calcModule;

describe('simulator calculations', () => {
  test('calculates reference-style necessary air lines for enemy air 72', () => {
    expect(calculateEnemyAirLines(72)).toEqual({
      supremacy: 216,
      superiority: 108,
      parity: 49,
      denial: 25,
    });
  });

  test('summarizes base air power, radius, damage, and two waves', () => {
    let state = createEmptySimulatorState();
    state = setBaseSlot(state, 0, 0, { plane: plane('ginga-1') });
    state = setBaseSlot(state, 0, 1, { plane: plane('ginga-2') });
    state = setBaseSlot(state, 0, 2, { plane: plane('ginga-3') });
    state = setBaseSlot(state, 0, 3, { plane: plane('ginga-4') });
    state = setWaveTarget(state, 0, 'parity');
    state = setWaveTarget(state, 1, 'parity');

    const summary = calculateSimulatorSummary(state);

    expect(summary.bases).toHaveLength(1);
    expect(summary.bases[0].radius).toBe(9);
    expect(summary.bases[0].airPower).toBeGreaterThan(0);
    expect(summary.bases[0].damagePower).toBeGreaterThan(0);
    expect(summary.waves).toHaveLength(2);
    expect(summary.waves[0]).toEqual(expect.objectContaining({
      waveIndex: 0,
      baseIndex: 0,
      targetState: 'parity',
      expectedEnemyAirBefore: 72,
      expectedEnemyAirAfter: expect.any(Number),
    }));
    expect(summary.waves[0].expectedEnemyAirAfter).toBeLessThan(72);
    expect(summary.waves[1].expectedEnemyAirBefore)
      .toBeCloseTo(summary.waves[0].expectedEnemyAirAfter, 8);
    expect(summary.waves[1].expectedEnemyAirAfter)
      .toBeLessThan(summary.waves[1].expectedEnemyAirBefore);
    expect(summary.calculationMode).toBe('static');
    expect(summary.mode).toBe('static');
    expect(summary.limitations).toContain('STATIC_ENEMY_AIR');
  });

  test('uses a slot proficiency override without mutating the owned plane', () => {
    const owned = plane('max-rank-fighter', {
      antiAir: 12,
      equipType: 6,
      proficiency: 7,
      internalProficiency: 120,
      isFighter: true,
      isAttacker: false,
      role: 'fighter',
    });
    const normal = setBaseSlot(createEmptySimulatorState(), 0, 0, { plane: owned });
    const lost = setBaseSlot(normal, 0, 0, { proficiency: 0 });

    expect(calculateSimulatorSummary(lost).bases[0].airPower)
      .toBeLessThan(calculateSimulatorSummary(normal).bases[0].airPower);
    expect(owned).toMatchObject({ proficiency: 7, internalProficiency: 120 });
  });

  test('normalizes and edits detailed enemy slots immutably', () => {
    const source = [{
      instanceId: 'enemy-1',
      name: 'Enemy fighter',
      sortieAntiAir: 10,
      currentSlot: 18,
      maxSlot: 18,
    }];
    const normalized = normalizeDetailedEnemySlots(source);
    expect(normalized).toEqual([{
      instanceId: 'enemy-1',
      name: 'Enemy fighter',
      sortieAntiAir: 10,
      currentSlot: 18,
      maxSlot: 18,
    }]);
    expect(source[0].currentSlot).toBe(18);

    let state = createEmptySimulatorState();
    state = addDetailedEnemySlot(state, {
      instanceId: 'enemy-1',
      name: 'Enemy fighter',
      sortieAntiAir: 10,
      currentSlot: 18,
      maxSlot: 18,
    });
    const added = state;
    state = setDetailedEnemySlot(state, 0, { currentSlot: 12 });
    expect(added.enemy.slots[0].currentSlot).toBe(18);
    expect(state.enemy.slots[0].currentSlot).toBe(12);
    expect(removeDetailedEnemySlot(state, 0).enemy.slots).toEqual([]);
  });

  test('estimates two denial waves near the reference 0.8 enemy-air ratio', () => {
    let state = createEmptySimulatorState();
    state = {
      ...state,
      enemy: { ...state.enemy, enemyAir: 300 },
    };
    state = setBaseSlot(state, 0, 0, { plane: plane('denial-fighter', {
      antiAir: 24,
      equipType: 48,
      proficiency: 0,
      isFighter: true,
      isAttacker: false,
      role: 'fighter',
    }) });

    const summary = calculateSimulatorSummary(state);

    expect(summary.waves.map((wave) => wave.expectedState.key)).toEqual(['denial', 'denial']);
    expect(summary.waves[1].expectedEnemyAirAfter / 300).toBeCloseTo(0.797, 2);
  });

  test('delegates detailed enemies to Monte Carlo without mutating slots', () => {
    let state = /** @type {any} */ (createEmptySimulatorState());
    state = setBaseSlot(state, 0, 0, { plane: plane('fighter', {
      antiAir: 12,
      isFighter: true,
      isAttacker: false,
      role: 'fighter',
    }) });
    state = {
      ...state,
      enemy: {
        mode: 'detailed',
        isAirRaidCell: true,
        slots: [{
          instanceId: 'enemy-1',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
      simulationOptions: { seed: 'summary', sampleCount: 16 },
    };
    const snapshot = structuredClone(state);

    const normalized = normalizeSimulatorState(state);
    const summary = calculateSimulatorSummary(normalized);

    expect(normalized.enemy.isAirRaidCell).toBe(true);
    expect(state).toEqual(snapshot);
    expect(summary.calculationMode).toBe('detailed');
    expect(summary.simulation.sampleCount).toBe(16);
    expect(summary.simulation.waves).toHaveLength(2);
    expect(summary.waves[0]).toEqual(expect.objectContaining({
      expectedEnemyAirBefore: expect.any(Number),
      expectedEnemyAirAfter: expect.any(Number),
    }));
    expect(summary.limitations).toEqual(expect.arrayContaining([
      'ENEMY_STAGE2_OMITTED',
      'JET_STAGE2_OMITTED',
    ]));
  });

  test('returns a structured invalid summary without running Monte Carlo for bad slots', () => {
    const initial = createEmptySimulatorState();
    const state = {
      ...initial,
      enemy: {
        mode: 'detailed',
        isAirRaidCell: false,
        slots: [{
          instanceId: 'enemy-1',
          name: 'Invalid enemy',
          sortieAntiAir: Number.POSITIVE_INFINITY,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
    };

    const normalized = normalizeSimulatorState(state);
    const summary = calculateSimulatorSummary(normalized);

    expect(summary).toEqual(expect.objectContaining({
      calculationMode: 'invalid',
      mode: 'invalid',
      limitations: expect.arrayContaining(['INVALID_DETAILED_ENEMY_SLOTS']),
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'sortieAntiAir', slotIndex: 0 }),
      ]),
    }));
    expect(summary.simulation).toBeUndefined();
  });

  test.each([0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 10001])(
    'returns structured invalid for sampleCount %s without running Monte Carlo',
    (sampleCount) => {
      const summary = calculateSimulatorSummary(detailedState({ sampleCount }));

      expect(summary).toEqual(expect.objectContaining({
        calculationMode: 'invalid',
        mode: 'invalid',
        errors: expect.arrayContaining([
          expect.objectContaining({ code: 'INVALID_SAMPLE_COUNT' }),
        ]),
      }));
      expect(summary.simulation).toBeUndefined();
    },
  );

  test('returns structured invalid when the single-enemy state requests separate dispatch', () => {
    const summary = calculateSimulatorSummary(detailedState({ dispatchMode: 'separate' }));

    expect(summary).toEqual(expect.objectContaining({
      calculationMode: 'invalid',
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_SEPARATE_ENEMY_FLEETS' }),
      ]),
    }));
    expect(summary.simulation).toBeUndefined();
  });

  test('reports NONE for an empty base but supremacy for a real zero-air-power plane', () => {
    const initial = createEmptySimulatorState();
    const zeroEnemyState = {
      ...initial,
      enemy: { ...initial.enemy, enemyAir: 0 },
    };

    const emptySummary = calculateSimulatorSummary(zeroEnemyState);
    expect(emptySummary.bases[0].state.key).toBe('none');
    expect(emptySummary.waves.every((wave) => wave.state.key === 'none')).toBe(true);
    expect(emptySummary.statusKey).toBe('none');

    const occupiedState = setBaseSlot(zeroEnemyState, 0, 0, {
      plane: plane('zero-air-power', { antiAir: 0, proficiency: 0 }),
    });
    const occupiedSummary = calculateSimulatorSummary(occupiedState);
    expect(occupiedSummary.bases[0].airPower).toBe(0);
    expect(occupiedSummary.bases[0].state.key).toBe('supremacy');
    expect(occupiedSummary.statusKey).toBe('supremacy');
  });
});

/** Creates one valid detailed simulator state with overridable simulation controls. */
function detailedState(simulationOptions = {}) {
  const initial = createEmptySimulatorState();
  return {
    ...initial,
    enemy: {
      mode: 'detailed',
      slots: [{
        instanceId: 'enemy-1',
        name: 'Enemy fighter',
        sortieAntiAir: 10,
        currentSlot: 18,
        maxSlot: 18,
      }],
    },
    simulationOptions: {
      ...initial.simulationOptions,
      ...simulationOptions,
    },
  };
}

/** Creates an explicit Ginga capability fixture for simulator calculations. */
function plane(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: 187,
    name: '银河',
    antiAir: 3,
    intercept: 0,
    antiBomber: 0,
    radius: 9,
    improvement: 0,
    proficiency: 7,
    equipType: 47,
    isPlane: true,
    isAttacker: true,
    isLandAttacker: true,
    role: 'attacker',
    isLandBased: true,
    torpedo: 14,
    bombing: 14,
    available: true,
    missing: false,
    ...overrides,
  };
}
