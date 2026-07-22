'use strict';

const {
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  requiredAirForState,
} = require('./air-power');
const { calculateBaseDamagePower } = require('./damage');
const { effectivePlaneForSlot, normalizeSimulatorState } = require('./simulator-state');
const { monteCarloWaveSequence } = require('./wave-simulator');
const { INVALID_SLOT_LIMITATION } = require('./enemy-slots');
const { INVALID_SIMULATION_LIMITATION } = require('./simulation-options');

const STATIC_LIMITATIONS = Object.freeze(['STATIC_ENEMY_AIR']);
const INVALID_SEPARATE_LIMITATION = 'INVALID_SEPARATE_ENEMY_FLEETS';
const ENEMY_STAGE_ONE_DRAW_MAX = Object.freeze({
  supremacy: 10,
  superiority: 8,
  parity: 6,
  denial: 4,
  loss: 1,
});

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
  if (normalized.enemy.mode === 'detailed' && normalized.enemy.valid === false) {
    return invalidSimulatorSummary(
      normalized.enemy.errors,
      INVALID_SLOT_LIMITATION,
      'Detailed enemy slots must be corrected before simulation.',
    );
  }
  if (normalized.simulationOptions.valid === false) {
    return invalidSimulatorSummary(
      normalized.simulationOptions.errors,
      INVALID_SIMULATION_LIMITATION,
      'Simulation options must be corrected before simulation.',
    );
  }
  if (normalized.simulationOptions.dispatchMode === 'separate') {
    return invalidSimulatorSummary([{
      code: INVALID_SEPARATE_LIMITATION,
      path: 'simulationOptions.dispatchMode',
      field: 'dispatchMode',
      value: 'separate',
      message: 'Separate dispatch requires exactly two independent enemy fleets.',
    }], INVALID_SEPARATE_LIMITATION, 'The simulator state contains only one enemy target.');
  }
  const enemyAir = normalized.enemy.enemyAir;
  const bases = normalized.bases.map((base, baseIndex) => {
    const loadout = base.slots.map(effectivePlaneForSlot).filter(Boolean);
    const airPower = calculateBaseAirPower(loadout);
    const radius = calculateEffectiveRadius(loadout);
    const damagePower = calculateBaseDamagePower(loadout, {
      combatContext: state.combatContext,
    });
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
  let expectedEnemyAir = enemyAir;
  const staticWaves = normalized.waves.map((wave, waveIndex) => {
    const base = bases[wave.baseIndex] || bases[0] || emptyBaseSummary();
    const stateForWave = airStateFor(base.airPower, enemyAir, base.loadout.length > 0);
    const expectedEnemyAirBefore = expectedEnemyAir;
    const expectedState = airStateFor(
      base.airPower,
      expectedEnemyAirBefore,
      base.loadout.length > 0,
    );
    expectedEnemyAir = expectedEnemyAirBefore * expectedEnemyAirRatio(expectedState.key);
    return {
      waveIndex,
      baseIndex: wave.baseIndex,
      waveInBase: wave.waveInBase,
      targetState: wave.targetState,
      airPower: base.airPower,
      state: stateForWave,
      fulfilled: stateForWave.rank >= airStateRank(wave.targetState),
      expectedEnemyAirBefore,
      expectedEnemyAirAfter: expectedEnemyAir,
      expectedState,
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
      STATIC_ENEMY_AIR:
        'Static total enemy air estimates expected Stage 1 reduction without exact enemy slots.',
    },
  };

  if (normalized.enemy.mode !== 'detailed') {
    return summary;
  }

  const simulation = monteCarloWaveSequence({
    bases: normalized.bases.map((base) => base.slots.map(effectivePlaneForSlot)),
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

/** Approximates E[sqrt(remaining slot ratio)] from the full discrete Stage 1 distribution. */
function expectedEnemyAirRatio(stateKey) {
  const maximumDraw = ENEMY_STAGE_ONE_DRAW_MAX[stateKey];
  if (!Number.isInteger(maximumDraw)) return 1;
  let total = 0;
  let outcomes = 0;
  for (let x = 0; x <= maximumDraw; x += 1) {
    for (let y = 0; y <= maximumDraw; y += 1) {
      const lossRatio = (0.65 * x + 0.35 * y) / 10;
      total += Math.sqrt(Math.max(0, 1 - lossRatio));
      outcomes += 1;
    }
  }
  return total / outcomes;
}

/** Returns a non-simulated structured result for invalid simulator input. */
function invalidSimulatorSummary(errors, limitation, note) {
  return {
    calculationMode: 'invalid',
    mode: 'invalid',
    errors: [...errors],
    limitations: [limitation],
    limitationNotes: {
      [limitation]: note,
    },
    bases: [],
    waves: [],
    enemyAirLines: null,
    totalAirPower: null,
    statusKey: 'invalid',
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
