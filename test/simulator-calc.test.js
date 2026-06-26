import { describe, expect, test } from 'vitest';
import stateModule from '../src/simulator-state.js';
import calcModule from '../src/simulator-calc.js';

const { createEmptySimulatorState, setBaseSlot, setWaveTarget } = stateModule;
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
    }));
  });
});

function plane(instanceId) {
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
    role: 'attacker',
    isLandBased: true,
    torpedo: 14,
    bombing: 14,
    available: true,
    missing: false,
  };
}
