import { describe, expect, test } from 'vitest';
import stateModule from '../src/simulator-state.js';
import importModule from '../src/import-plan.js';

const { createEmptySimulatorState, setBaseSlot, setSlotLock } = stateModule;
const { applyPlanToSimulator } = importModule;

describe('import optimizer plan into simulator', () => {
  test('imports plan loadout into empty simulator slots', () => {
    const plan = {
      bases: [
        { loadout: [plane('a'), plane('b'), plane('c'), plane('d')] },
      ],
    };

    const state = applyPlanToSimulator(createEmptySimulatorState(), plan);

    expect(state.bases[0].slots.map((slot) => slot.plane.instanceId)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('does not overwrite locked slots', () => {
    const locked = plane('locked');
    const original = setSlotLock(setBaseSlot(createEmptySimulatorState(), 0, 1, { plane: locked }), 0, 1, true);
    const plan = {
      bases: [
        { loadout: [plane('a'), plane('b'), plane('c'), plane('d')] },
      ],
    };

    const state = applyPlanToSimulator(original, plan);

    expect(state.bases[0].slots.map((slot) => slot.plane.instanceId)).toEqual(['a', 'locked', 'c', 'd']);
    expect(state.bases[0].slots[1].locked).toBe(true);
  });
});

function plane(instanceId) {
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
  };
}
