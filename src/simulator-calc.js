'use strict';

const {
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  requiredAirForState,
} = require('./air-power');
const { calculateBaseDamagePower } = require('./damage');
const { normalizeSimulatorState } = require('./simulator-state');
const { monteCarloWaveSequence } = require('./wave-simulator');

const STATIC_LIMITATIONS = Object.freeze(['STATIC_ENEMY_AIR']);

function calculateEnemyAirLines(enemyAir) {
  return {
    supremacy: requiredAirForState(enemyAir, 'supremacy'),
    superiority: requiredAirForState(enemyAir, 'superiority'),
    parity: requiredAirForState(enemyAir, 'parity'),
    denial: requiredAirForState(enemyAir, 'denial'),
  };
}

/**
 * Returns either a legacy static summary or a detailed Monte Carlo summary.
 * @param {Record<string, any>} state Simulator state.
 * @returns {Record<string, any>} Static or detailed calculation summary.
 */
function calculateSimulatorSummary(state) {
  const normalized = normalizeSimulatorState(state);
  const enemyAir = normalized.enemy.enemyAir;
  const bases = normalized.bases.map((base, baseIndex) => {
    const loadout = base.slots.map((slot) => slot.plane).filter(Boolean);
    const airPower = calculateBaseAirPower(loadout);
    const radius = calculateEffectiveRadius(loadout);
    const damagePower = calculateBaseDamagePower(loadout);
    const stateForBase = airStateFor(airPower, enemyAir, loadout.length > 0);

    return {
      baseIndex,
      name: base.name,
      airPower,
      radius,
      damagePower,
      state: stateForBase,
      loadout,
    };
  });
  const staticWaves = normalized.waves.map((wave, waveIndex) => {
    const base = bases[wave.baseIndex] || bases[0] || emptyBaseSummary();
    const stateForWave = airStateFor(base.airPower, enemyAir, base.loadout.length > 0);
    return {
      waveIndex,
      baseIndex: wave.baseIndex,
      waveInBase: wave.waveInBase,
      targetState: wave.targetState,
      airPower: base.airPower,
      state: stateForWave,
      fulfilled: stateForWave.rank >= airStateRank(wave.targetState),
    };
  });

  const summary = {
    bases,
    waves: staticWaves,
    enemyAirLines: calculateEnemyAirLines(enemyAir),
    totalAirPower: bases.reduce((total, base) => total + base.airPower, 0),
    statusKey: weakestStateKey(staticWaves),
    calculationMode: 'static',
    mode: 'static',
    limitations: [...STATIC_LIMITATIONS],
    limitationNotes: {
      STATIC_ENEMY_AIR: 'Static total enemy air does not model aircraft-slot losses between waves.',
    },
  };

  if (normalized.enemy.mode !== 'detailed') {
    return summary;
  }

  const simulation = monteCarloWaveSequence({
    bases: normalized.bases.map((base) => base.slots.map((slot) => slot.plane)),
    enemy: normalized.enemy,
    targetStates: normalized.waves.map((wave) => wave.targetState),
    ...normalized.simulationOptions,
  });
  return {
    ...summary,
    waves: simulation.waves,
    simulation,
    calculationMode: 'detailed',
    mode: 'detailed',
    limitations: simulation.limitations,
    limitationNotes: simulation.limitationNotes,
    statusKey: weakestExpectedStateKey(simulation.waves),
  };
}

/** Returns the weakest most-probable detailed wave state for legacy status displays. */
function weakestExpectedStateKey(waves) {
  if (!waves.length) return 'loss';
  return waves.reduce((weakest, wave) => {
    const stateKey = Object.entries(wave.stateProbabilities)
      .sort((left, right) => right[1] - left[1] || AIR_STATE_ORDER[left[0]] - AIR_STATE_ORDER[right[0]])[0][0];
    return AIR_STATE_ORDER[stateKey] < AIR_STATE_ORDER[weakest] ? stateKey : weakest;
  }, 'supremacy');
}

const AIR_STATE_ORDER = Object.freeze({
  none: -1,
  loss: 0,
  denial: 1,
  parity: 2,
  superiority: 3,
  supremacy: 4,
});

function emptyBaseSummary() {
  return {
    airPower: 0,
    radius: 0,
    damagePower: 0,
    state: airStateFor(0, 0, false),
    loadout: [],
  };
}

function airStateRank(stateKey) {
  return airStateFor(requiredAirForState(100, stateKey), 100).rank;
}

function weakestStateKey(waves) {
  if (!waves.length) {
    return 'loss';
  }
  return waves.reduce((weakest, wave) =>
    wave.state.rank < weakest.rank ? wave.state : weakest,
  waves[0].state).key;
}

module.exports = {
  calculateEnemyAirLines,
  calculateSimulatorSummary,
};
