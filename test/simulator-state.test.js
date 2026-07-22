import { describe, expect, test } from 'vitest';
import stateModule from '../src/simulator-state.js';

const {
  createEmptySimulatorState,
  setBaseCount,
  setBaseSlot,
  setSlotLock,
  setWaveTarget,
  simulatorToOptimizerInput,
} = stateModule;

describe('simulator state', () => {
  test('creates one base and two waves by default', () => {
    const state = createEmptySimulatorState();

    expect(state.baseCount).toBe(1);
    expect(state.bases).toHaveLength(1);
    expect(state.bases[0].slots).toHaveLength(4);
    expect(state.waves.map((wave) => [wave.baseIndex, wave.waveInBase])).toEqual([[0, 0], [0, 1]]);
    expect(state.enemy.enemyAir).toBe(72);
    expect(state.simulationOptions.sampleCount).toBe(4096);
  });

  test('expands to three bases and six waves without losing first-base slots', () => {
    const ginga = plane('owned-ginga', { masterId: 187, name: '银河', radius: 9 });
    const oneBase = setBaseSlot(createEmptySimulatorState(), 0, 0, { plane: ginga });

    const state = setBaseCount(oneBase, 3);

    expect(state.baseCount).toBe(3);
    expect(state.bases).toHaveLength(3);
    expect(state.bases[0].slots[0].plane).toEqual(ginga);
    expect(state.waves).toHaveLength(6);
    expect(state.waves.map((wave) => wave.baseIndex)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  test('shrinks base count and keeps only matching wave targets', () => {
    const state = setWaveTarget(setBaseCount(createEmptySimulatorState(), 3), 5, 'supremacy');

    const shrunk = setBaseCount(state, 1);

    expect(shrunk.baseCount).toBe(1);
    expect(shrunk.bases).toHaveLength(1);
    expect(shrunk.waves).toHaveLength(2);
    expect(shrunk.waves.map((wave) => wave.targetState)).toEqual(['parity', 'parity']);
  });

  test('exports locked slots and wave targets for optimizer', () => {
    const hayabusa = plane('owned-hayabusa', { masterId: 225, name: '隼64', radius: 7 });
    const state = setWaveTarget(
      setSlotLock(setBaseSlot(createEmptySimulatorState(), 0, 0, { plane: hayabusa }), 0, 0, true),
      1,
      'superiority',
    );

    expect(simulatorToOptimizerInput(state)).toEqual({
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'superiority'],
      lockedBases: [
        {
          slots: [
            { plane: hayabusa, locked: true },
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
          ],
        },
      ],
    });
  });

  test('preserves an explicitly locked empty slot for optimizer input', () => {
    const state = setSlotLock(createEmptySimulatorState(), 0, 1, true);

    expect(state.bases[0].slots[1]).toEqual(expect.objectContaining({
      plane: null,
      locked: true,
    }));
    expect(simulatorToOptimizerInput(state).lockedBases[0].slots[1]).toEqual({
      plane: null,
      locked: true,
    });
  });

  test('preserves custom enemy source metadata in optimizer and CLI scenario input', () => {
    const state = stateModule.normalizeSimulatorState({
      ...createEmptySimulatorState(),
      enemy: {
        dataSource: 'custom',
        mode: 'detailed',
        ships: [{ id: null, custom: true, name: '自定义空母', airPower: 0 }],
        slots: [{
          instanceId: 'custom-slot-0',
          name: '自定义舰战',
          sortieAntiAir: 12,
          currentSlot: 24,
          maxSlot: 24,
          sourceShipIndex: 0,
          overridden: true,
        }],
      },
    });

    const enemy = simulatorToOptimizerInput(state).enemy;
    expect(enemy.dataSource).toBe('custom');
    expect(enemy.ships[0]).toMatchObject({ custom: true, name: '自定义空母' });
    expect(enemy.slots).toEqual([expect.objectContaining({
        name: '自定义舰战',
        currentSlot: 24,
        overridden: true,
      })]);
  });

  test('exports a selected proficiency for a locked plane', () => {
    const owned = plane('owned-fighter', {
      proficiency: 7,
      internalProficiency: 120,
    });
    let state = setBaseSlot(createEmptySimulatorState(), 0, 0, {
      plane: owned,
      proficiency: 0,
    });
    state = setSlotLock(state, 0, 0, true);

    expect(simulatorToOptimizerInput(state).lockedBases[0].slots[0].plane).toEqual({
      ...owned,
      proficiency: 0,
      internalProficiency: undefined,
    });
    expect(owned).toMatchObject({ proficiency: 7, internalProficiency: 120 });
  });

  test('normalizes and exports custom target and equipment multiplier rules', () => {
    const state = stateModule.normalizeSimulatorState({
      ...createEmptySimulatorState(),
      combatContext: {
        targetTags: [' event-e3 ', 'boss', 'event-e3'],
        multiplierRules: [{
          id: ' event-e3-a ',
          label: 'Group A',
          enabled: true,
          targetTags: ['event-e3'],
          equipmentMasterIds: ['301', 301],
          equipmentTypes: [],
          group: ' group-a ',
          multiplier: '1.18',
          source: 'custom',
          overridden: true,
        }],
      },
    });

    expect(state.combatContext).toEqual({
      targetTags: ['event-e3', 'boss'],
      multiplierRules: [{
        id: 'event-e3-a',
        label: 'Group A',
        enabled: true,
        targetTags: ['event-e3'],
        equipmentMasterIds: [301],
        equipmentTypes: [],
        group: 'group-a',
        multiplier: 1.18,
        source: 'custom',
        overridden: true,
      }],
    });
    expect(simulatorToOptimizerInput(state).combatContext).toEqual(state.combatContext);
  });
});

function plane(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: 1,
    name: instanceId,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 7,
    improvement: 0,
    proficiency: 7,
    role: 'attacker',
    isLandBased: true,
    torpedo: 14,
    bombing: 14,
    available: true,
    missing: false,
    ...overrides,
  };
}
