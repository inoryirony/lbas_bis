'use strict';

const {
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  requiredAirForState,
} = require('./air-power');
const { calculateBaseDamagePower } = require('./damage');
const { normalizeSimulatorState } = require('./simulator-state');

function calculateEnemyAirLines(enemyAir) {
  return {
    supremacy: requiredAirForState(enemyAir, 'supremacy'),
    superiority: requiredAirForState(enemyAir, 'superiority'),
    parity: requiredAirForState(enemyAir, 'parity'),
    denial: requiredAirForState(enemyAir, 'denial'),
  };
}

function calculateSimulatorSummary(state) {
  const normalized = normalizeSimulatorState(state);
  const enemyAir = normalized.enemy.enemyAir;
  const bases = normalized.bases.map((base, baseIndex) => {
    const loadout = base.slots.map((slot) => slot.plane).filter(Boolean);
    const airPower = calculateBaseAirPower(loadout);
    const radius = calculateEffectiveRadius(loadout);
    const damagePower = calculateBaseDamagePower(loadout);
    const stateForBase = airStateFor(airPower, enemyAir);

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
  const waves = normalized.waves.map((wave, waveIndex) => {
    const base = bases[wave.baseIndex] || bases[0] || emptyBaseSummary();
    const stateForWave = airStateFor(base.airPower, enemyAir);
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

  return {
    bases,
    waves,
    enemyAirLines: calculateEnemyAirLines(enemyAir),
    totalAirPower: bases.reduce((total, base) => total + base.airPower, 0),
    statusKey: weakestStateKey(waves),
  };
}

function emptyBaseSummary() {
  return {
    airPower: 0,
    radius: 0,
    damagePower: 0,
    state: airStateFor(0, 0),
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
