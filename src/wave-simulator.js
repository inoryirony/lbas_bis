'use strict';

const {
  AIR_STATES,
  airStateFor,
  calculateBaseAirPower,
  calculateSlotAirPower,
  defaultSlotSizeForPlane,
  landReconCoefficient,
} = require('./air-power');
const { capabilitiesFor } = require('./aircraft');
const { calculateBaseDamagePower } = require('./damage');
const {
  detailedEnemyValidationError,
  validateAndNormalizeDetailedEnemySlots,
} = require('./enemy-slots');
const { commonRandomNumber } = require('./random');
const { requireSampleCount } = require('./simulation-options');

const PLAYER_STAGE_ONE_CONSTANTS = Object.freeze({
  supremacy: 1,
  superiority: 3,
  parity: 5,
  denial: 7,
  loss: 10,
});
const ENEMY_STAGE_ONE_CONSTANTS = Object.freeze({
  supremacy: 10,
  superiority: 8,
  parity: 6,
  denial: 4,
  loss: 1,
});
const DETAILED_LIMITATIONS = Object.freeze([
  'ENEMY_STAGE2_OMITTED',
  'JET_STAGE2_OMITTED',
  'PLAYER_STAGE2_OMITTED',
  'DAMAGE_LOSS_RESOURCE_OPTIMISTIC',
]);

/**
 * Calculates player Stage 1 losses with the kc-web state constants and one final floor.
 */
function playerStageOneLoss(stateKey, currentSlot, random = Math.random, plane = {}) {
  if (typeof random !== 'function') {
    const suppliedPlane = random || {};
    random = typeof plane === 'function'
      ? /** @type {() => number} */ (plane)
      : Math.random;
    plane = suppliedPlane;
  }
  const constant = stageOneConstant(PLAYER_STAGE_ONE_CONSTANTS, stateKey);
  const slot = nonNegativeFinite(currentSlot, 0);
  const uniform = unitRandom(random());
  const k = Math.floor(uniform * ((1000 * constant / 3) + 1));
  const a = k / 1000;
  const raw = slot * (a + constant / 4) / 10;
  const capabilities = capabilitiesFor(plane || {});
  const isJet = plane?.isJet === true || capabilities.isJet === true;
  const isAswPatrol = plane?.isAswPatrol === true || capabilities.isAswPatrol === true;
  const isAttacker = plane?.isAttacker === true || capabilities.isAttacker === true;
  const modifier = isJet ? 0.6 : isAswPatrol && !isAttacker ? 0.91 : 1;
  return Math.min(slot, Math.floor(raw * modifier));
}

/** Calculates enemy Stage 1 losses from two independent uniform integer draws. */
function enemyStageOneLoss(stateKey, currentSlot, random = Math.random) {
  const constant = stageOneConstant(ENEMY_STAGE_ONE_CONSTANTS, stateKey);
  const slot = nonNegativeFinite(currentSlot, 0);
  const x = Math.floor(unitRandom(random()) * (constant + 1));
  const y = Math.floor(unitRandom(random()) * (constant + 1));
  return Math.min(slot, Math.floor(slot * (0.65 * x + 0.35 * y) / 10));
}

/** Recalculates detailed enemy air power from each surviving aircraft slot. */
function calculateEnemyAirPower(enemy) {
  return normalizeEnemyFleet(enemy).slots.reduce(
    (total, slot) => total + Math.floor(slot.sortieAntiAir * Math.sqrt(slot.currentSlot)),
    0,
  );
}

/**
 * Simulates one exact two-wave sequence per base without mutating plans or enemy fleets.
 */
function simulateWaveSequence(options = {}) {
  const bases = normalizeBases(options.bases || options.loadouts || []);
  const dispatchMode = options.dispatchMode === 'separate' ? 'separate' : 'concentrated';
  const enemies = normalizeEnemyInputs(options, dispatchMode);
  const targetStates = normalizeTargets(options.targetStates, bases.length * 2);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const waves = [];
  const usedSteelByBase = bases.map(() => 0);
  const initialOwnSlots = bases.map((base) => slotsForPlanes(base));

  bases.forEach((base, baseIndex) => {
    let ownAir = calculateBaseAirPower(base);
    for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
      const waveIndex = baseIndex * 2 + waveInBase;
      const enemyIndex = dispatchMode === 'separate' ? waveInBase : 0;
      const enemy = enemies[enemyIndex];
      const enemySlotsBefore = slotsForEnemy(enemy);
      const enemyAirBefore = airPowerForEnemy(enemy);
      const runJet = !enemy.isAirRaidCell &&
        (dispatchMode === 'separate' || waveInBase === 0);
      const jetAssault = runJet
        ? simulateJetAssault(base, waveIndex, random)
        : null;
      if (jetAssault) {
        ownAir = jetAssault.ownAirAfter;
        usedSteelByBase[baseIndex] += jetAssault.usedSteel;
      }

      const ownSlotsBefore = slotsForPlanes(base);
      const ownAirBefore = ownAir;

      const state = airStateFor(
        ownAir,
        enemyAirBefore,
        base.some((plane) => plane?.currentSlot > 0),
      );
      const enemySlotDetails = applyEnemyStageOne(enemy, state.key, waveIndex, random);
      const enemyAirAfter = airPowerForEnemy(enemy);
      const applyPlayerLoss = dispatchMode === 'separate' || waveInBase === 1;
      const ownSlotDetails = applyPlayerLoss
        ? applyPlayerStageOne(base, state.key, waveIndex, random)
        : unchangedOwnSlotDetails(base);
      if (applyPlayerLoss) {
        ownAir = calculateBaseAirPower(base);
      }
      const ownSlotsAfter = slotsForPlanes(base);
      const enemySlotsAfter = slotsForEnemy(enemy);
      const damage = calculateBaseDamagePower(base.filter(Boolean));
      const targetState = targetStates[waveIndex];

      waves.push({
        waveIndex,
        baseIndex,
        waveInBase,
        targetIndex: enemyIndex,
        targetState,
        fulfilled: state.rank >= (AIR_STATES[targetState]?.rank ?? AIR_STATES.parity.rank),
        state,
        airPower: ownAirBefore,
        stateOwnAir: ownAirBefore,
        ownAirBefore,
        ownAirAfter: ownAir,
        enemyAirBefore,
        enemyAirAfter,
        ownSlotsBefore,
        ownSlotsAfter,
        enemySlotsBefore,
        enemySlotsAfter,
        ownSlotDetails,
        enemySlotDetails,
        jetAssault,
        damage,
        ownSlotLoss: sumSlots(ownSlotsBefore) - sumSlots(ownSlotsAfter),
        enemySlotLoss: sumSlots(enemySlotsBefore) - sumSlots(enemySlotsAfter),
      });
    }
  });

  const finalOwnSlots = bases.map((base) => slotsForPlanes(base));
  const totalOwnSlotLoss = initialOwnSlots.reduce(
    (total, slots, index) => total + sumSlots(slots) - sumSlots(finalOwnSlots[index]),
    0,
  );
  const totalUsedSteel = usedSteelByBase.reduce((total, value) => total + value, 0);
  const totalSupplyFuel = totalOwnSlotLoss * 3;
  const totalSupplyBauxite = totalOwnSlotLoss * 5;

  return {
    calculationMode: 'detailed',
    mode: 'detailed',
    dispatchMode,
    waves,
    enemyFleets: enemies.map(cloneEnemyFleet),
    finalBases: bases.map((base) => base.map((plane) => plane ? { ...plane } : null)),
    finalOwnAir: bases.map((base) => calculateBaseAirPower(base)),
    finalEnemyAir: enemies.map((enemy) => airPowerForEnemy(enemy)),
    totalDamage: waves.reduce((total, wave) => total + wave.damage, 0),
    totalOwnSlotLoss,
    totalEnemySlotLoss: waves.reduce((total, wave) => total + wave.enemySlotLoss, 0),
    totalUsedSteel,
    totalSupplyFuel,
    totalSupplyBauxite,
    totalResourceCost: totalUsedSteel + totalSupplyFuel + totalSupplyBauxite,
    allWaveTargetsFulfilled: waves.every((wave) => wave.fulfilled),
    limitations: [...DETAILED_LIMITATIONS],
    limitationNotes: {
      DAMAGE_LOSS_RESOURCE_OPTIMISTIC:
        'Player Stage 2 and jet Stage 2 are omitted, so own losses and resource use may be low and damage may be high.',
    },
  };
}

/** Runs coordinate-addressed common-random-number samples and aggregates every wave. */
function monteCarloWaveSequence(options = {}) {
  const sampleCount = requireSampleCount(
    options.sampleCount ?? options.simulationOptions?.sampleCount,
  );
  const seed = options.seed ?? options.simulationOptions?.seed ?? 0;
  const incumbentScore = options.incumbentScore;
  const maximumDamagePerSample = normalizeBases(options.bases || options.loadouts || [])
    .reduce((total, base) => total + 2 * calculateBaseDamagePower(base.filter(Boolean)), 0);
  let accumulator = null;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const result = simulateWaveSequence({
      ...options,
      random: (wave, side, slot, draw) =>
        commonRandomNumber(seed, sample, wave, side, slot, draw),
    });
    accumulator = accumulator || createSimulationAccumulator(result);
    addSimulationSample(accumulator, result);
    const samplesEvaluated = sample + 1;
    const optimisticScore = optimisticFixedSampleScore(
      accumulator,
      samplesEvaluated,
      sampleCount,
      maximumDamagePerSample,
    );
    if (cannotBeatDetailedIncumbent(optimisticScore, incumbentScore)) {
      return {
        calculationMode: 'detailed',
        mode: 'detailed',
        seed,
        sampleCount,
        samplesEvaluated,
        prunedBySimulationBound: true,
        optimisticScore,
      };
    }
  }

  const first = accumulator.template;
  return {
    calculationMode: 'detailed',
    mode: 'detailed',
    dispatchMode: first.dispatchMode,
    seed,
    sampleCount,
    samplesEvaluated: sampleCount,
    waves: accumulator.waves.map((wave) => finalizeWaveAccumulator(wave, sampleCount)),
    allWaveTargetFulfillmentProbability: accumulator.allWaveTargetsFulfilled / sampleCount,
    expectedDamage: accumulator.totalDamage / sampleCount,
    expectedOwnSlotLoss: accumulator.totalOwnSlotLoss / sampleCount,
    expectedEnemySlotLoss: accumulator.totalEnemySlotLoss / sampleCount,
    expectedUsedSteel: accumulator.totalUsedSteel / sampleCount,
    expectedSupplyFuel: accumulator.totalSupplyFuel / sampleCount,
    expectedSupplyBauxite: accumulator.totalSupplyBauxite / sampleCount,
    expectedResourceCost: accumulator.totalResourceCost / sampleCount,
    expectedFinalOwnSlots: divideNested(accumulator.finalOwnSlots, sampleCount),
    expectedFinalOwnAir: divideNested(accumulator.finalOwnAir, sampleCount),
    expectedFinalEnemySlots: divideNested(accumulator.finalEnemySlots, sampleCount),
    expectedFinalEnemyAir: divideNested(accumulator.finalEnemyAir, sampleCount),
    limitations: [...DETAILED_LIMITATIONS],
    limitationNotes: first.limitationNotes,
  };
}

/** Returns the best fulfillment and damage averages still reachable by this sample prefix. */
function optimisticFixedSampleScore(
  accumulator,
  samplesEvaluated,
  sampleCount,
  maximumDamagePerSample,
) {
  const remainingSamples = sampleCount - samplesEvaluated;
  return {
    fulfillment: (
      accumulator.allWaveTargetsFulfilled + remainingSamples
    ) / sampleCount,
    damage: (
      accumulator.totalDamage + remainingSamples * maximumDamagePerSample
    ) / sampleCount,
  };
}

/** Prunes only on strict fixed-sample lexicographic bounds, never statistical confidence. */
function cannotBeatDetailedIncumbent(optimisticScore, incumbentScore) {
  if (!incumbentScore) return false;
  const incumbentFulfillment = Number(incumbentScore.fulfillment);
  const incumbentDamage = Number(incumbentScore.damage);
  if (!Number.isFinite(incumbentFulfillment) || !Number.isFinite(incumbentDamage)) return false;
  if (optimisticScore.fulfillment !== incumbentFulfillment) {
    return optimisticScore.fulfillment < incumbentFulfillment;
  }
  return optimisticScore.damage < incumbentDamage;
}

/** Applies one ordinary player Stage 1 draw to each current base slot. */
function applyPlayerStageOne(base, stateKey, waveIndex, random) {
  if (stateKey === 'none') return unchangedOwnSlotDetails(base);
  return base.map((plane, slotIndex) => {
    if (!plane) return { slotIndex, before: 0, loss: 0, after: 0 };
    const before = plane.currentSlot;
    const loss = playerStageOneLoss(
      stateKey,
      before,
      () => random(waveIndex, 'player', slotIndex, 0),
      plane,
    );
    plane.currentSlot = Math.max(0, before - loss);
    return { slotIndex, before, loss, after: plane.currentSlot };
  });
}

/** Applies two independent enemy Stage 1 draws to each detailed enemy slot. */
function applyEnemyStageOne(enemy, stateKey, waveIndex, random) {
  if (stateKey === 'none') {
    return enemy.slots.map((slot, slotIndex) => ({
      slotIndex,
      instanceId: slot.instanceId,
      before: slot.currentSlot,
      loss: 0,
      after: slot.currentSlot,
    }));
  }
  return enemy.slots.map((slot, slotIndex) => {
    const before = slot.currentSlot;
    let draw = 0;
    const loss = enemyStageOneLoss(
      stateKey,
      before,
      () => random(waveIndex, 'enemy', slot.instanceId ?? slotIndex, draw++),
    );
    slot.currentSlot = Math.max(0, before - loss);
    return { slotIndex, instanceId: slot.instanceId, before, loss, after: slot.currentSlot };
  });
}

/** Runs the kc-web jet Stage 1 and steel-cost phase while intentionally omitting Stage 2. */
function simulateJetAssault(base, waveIndex, random) {
  if (!base.some((plane) => hasCapability(plane, 'isJet'))) return null;
  const ownSlotsBefore = slotsForPlanes(base);
  let usedSteel = 0;
  const slotDetails = base.map((plane, slotIndex) => {
    if (!plane) return { slotIndex, before: 0, loss: 0, after: 0 };
    const before = plane.currentSlot;
    if (!hasCapability(plane, 'isJet') || plane.isEscortItem) {
      return { slotIndex, before, loss: 0, after: before };
    }
    usedSteel += Math.round(
      before * nonNegativeFinite(plane.cost, 0) * 0.2 *
      (hasCapability(plane, 'isHeavyJet') ? 1.2 : 1),
    );
    const loss = playerStageOneLoss(
      'supremacy',
      before,
      () => random(waveIndex, 'jet-player', slotIndex, 0),
      { ...plane, isJet: true },
    );
    plane.currentSlot = Math.max(0, before - loss);
    return { slotIndex, before, loss, after: plane.currentSlot };
  });
  const rawAir = base.reduce((total, plane) => {
    if (!plane || hasCapability(plane, 'isRecon')) return total;
    return total + calculateSlotAirPower(plane);
  }, 0);
  return {
    phase: 'jetAssault',
    ownAirBefore: calculateBaseAirPower(base.map((plane, index) => plane ? {
      ...plane,
      currentSlot: ownSlotsBefore[index],
    } : null)),
    ownAirAfter: Math.floor(rawAir * landReconCoefficient(base.filter(Boolean))),
    ownSlotsBefore,
    ownSlotsAfter: slotsForPlanes(base),
    slotDetails,
    usedSteel,
    stage2Modeled: false,
  };
}

/** Creates scalar and nested-array accumulators from the first sample shape. */
function createSimulationAccumulator(template) {
  return {
    template,
    waves: template.waves.map(createWaveAccumulator),
    allWaveTargetsFulfilled: 0,
    totalDamage: 0,
    totalOwnSlotLoss: 0,
    totalEnemySlotLoss: 0,
    totalUsedSteel: 0,
    totalSupplyFuel: 0,
    totalSupplyBauxite: 0,
    totalResourceCost: 0,
    finalOwnSlots: zeroNested(template.finalBases.map((base) => slotsForPlanes(base))),
    finalOwnAir: zeroNested(template.finalOwnAir),
    finalEnemySlots: zeroNested(template.enemyFleets.map((enemy) => slotsForEnemy(enemy))),
    finalEnemyAir: zeroNested(template.finalEnemyAir),
  };
}

/** Adds one simulation result without retaining the sample object. */
function addSimulationSample(accumulator, sample) {
  accumulator.allWaveTargetsFulfilled += sample.allWaveTargetsFulfilled ? 1 : 0;
  accumulator.totalDamage += sample.totalDamage;
  accumulator.totalOwnSlotLoss += sample.totalOwnSlotLoss;
  accumulator.totalEnemySlotLoss += sample.totalEnemySlotLoss;
  accumulator.totalUsedSteel += sample.totalUsedSteel;
  accumulator.totalSupplyFuel += sample.totalSupplyFuel;
  accumulator.totalSupplyBauxite += sample.totalSupplyBauxite;
  accumulator.totalResourceCost += sample.totalResourceCost;
  addNested(accumulator.finalOwnSlots, sample.finalBases.map((base) => slotsForPlanes(base)));
  addNested(accumulator.finalOwnAir, sample.finalOwnAir);
  addNested(accumulator.finalEnemySlots, sample.enemyFleets.map((enemy) => slotsForEnemy(enemy)));
  addNested(accumulator.finalEnemyAir, sample.finalEnemyAir);
  sample.waves.forEach((wave, index) => addWaveSample(accumulator.waves[index], wave));
}

/** Creates one online wave accumulator. */
function createWaveAccumulator(template) {
  return {
    template,
    stateCounts: Object.fromEntries(Object.keys(AIR_STATES).map((key) => [key, 0])),
    fulfilled: 0,
    enemyAirBefore: 0,
    enemyAirAfter: 0,
    ownAirBefore: 0,
    ownAirAfter: 0,
    enemySlotsBefore: zeroNested(template.enemySlotsBefore),
    enemySlotsAfter: zeroNested(template.enemySlotsAfter),
    ownSlotsBefore: zeroNested(template.ownSlotsBefore),
    ownSlotsAfter: zeroNested(template.ownSlotsAfter),
    damage: 0,
    ownSlotLoss: 0,
    enemySlotLoss: 0,
  };
}

/** Adds one exact wave result to its online accumulator. */
function addWaveSample(accumulator, wave) {
  accumulator.stateCounts[wave.state.key] += 1;
  accumulator.fulfilled += wave.fulfilled ? 1 : 0;
  accumulator.enemyAirBefore += wave.enemyAirBefore;
  accumulator.enemyAirAfter += wave.enemyAirAfter;
  accumulator.ownAirBefore += wave.ownAirBefore;
  accumulator.ownAirAfter += wave.ownAirAfter;
  addNested(accumulator.enemySlotsBefore, wave.enemySlotsBefore);
  addNested(accumulator.enemySlotsAfter, wave.enemySlotsAfter);
  addNested(accumulator.ownSlotsBefore, wave.ownSlotsBefore);
  addNested(accumulator.ownSlotsAfter, wave.ownSlotsAfter);
  accumulator.damage += wave.damage;
  accumulator.ownSlotLoss += wave.ownSlotLoss;
  accumulator.enemySlotLoss += wave.enemySlotLoss;
}

/** Finalizes one wave accumulator to the public Monte Carlo summary shape. */
function finalizeWaveAccumulator(accumulator, sampleCount) {
  const template = accumulator.template;
  return {
    waveIndex: template.waveIndex,
    baseIndex: template.baseIndex,
    waveInBase: template.waveInBase,
    targetIndex: template.targetIndex,
    targetState: template.targetState,
    stateProbabilities: Object.fromEntries(
      Object.entries(accumulator.stateCounts)
        .map(([key, count]) => [key, count / sampleCount]),
    ),
    targetFulfillmentProbability: accumulator.fulfilled / sampleCount,
    expectedEnemyAirBefore: accumulator.enemyAirBefore / sampleCount,
    expectedEnemyAirAfter: accumulator.enemyAirAfter / sampleCount,
    expectedOwnAirBefore: accumulator.ownAirBefore / sampleCount,
    expectedOwnAirAfter: accumulator.ownAirAfter / sampleCount,
    expectedEnemySlotsBefore: divideNested(accumulator.enemySlotsBefore, sampleCount),
    expectedEnemySlotsAfter: divideNested(accumulator.enemySlotsAfter, sampleCount),
    expectedOwnSlotsBefore: divideNested(accumulator.ownSlotsBefore, sampleCount),
    expectedOwnSlotsAfter: divideNested(accumulator.ownSlotsAfter, sampleCount),
    expectedDamage: accumulator.damage / sampleCount,
    expectedOwnSlotLoss: accumulator.ownSlotLoss / sampleCount,
    expectedEnemySlotLoss: accumulator.enemySlotLoss / sampleCount,
  };
}

/** Converts base summaries, loadouts, or simulator slots to cloned current-slot planes. */
function normalizeBases(bases) {
  return (bases || []).map((base) => {
    const source = Array.isArray(base)
      ? base
      : base?.loadout || base?.slots?.map((slot) =>
        slot && Object.prototype.hasOwnProperty.call(slot, 'plane') ? slot.plane : slot) || [];
    return source.map((plane) => plane ? {
      ...plane,
      currentSlot: currentSlotForPlane(plane),
    } : null);
  });
}

/** Normalizes one or two enemy inputs and enforces real separate targets. */
function normalizeEnemyInputs(options, dispatchMode) {
  const source = options.enemyFleets || options.targets || (options.enemy ? [options.enemy] : []);
  if (dispatchMode === 'separate') {
    if (!Array.isArray(source) || source.length !== 2 || source[0] === source[1]) {
      throw new RangeError(
        'Separate dispatch requires exactly two independent enemy fleets or targets.',
      );
    }
    return source.map(normalizeEnemyFleet);
  }
  if (!source.length) {
    throw new Error('Detailed wave simulation requires an enemy fleet.');
  }
  return [normalizeEnemyFleet(source[0])];
}

/** Safely normalizes the required detailed enemy slot fields. */
function normalizeEnemyFleet(enemy = {}) {
  const slots = enemy.slots ?? enemy.enemySlots ?? [];
  const validation = validateAndNormalizeDetailedEnemySlots(slots);
  if (!validation.valid) throw detailedEnemyValidationError(validation.errors);
  return {
    ...enemy,
    mode: 'detailed',
    isAirRaidCell: enemy.isAirRaidCell === true,
    slots: validation.slots,
  };
}

/** Returns a detached enemy fleet copy. */
function cloneEnemyFleet(enemy) {
  return { ...enemy, slots: enemy.slots.map((slot) => ({ ...slot })) };
}

/** Returns normal base air power from current slots. */
function currentSlotForPlane(plane) {
  const value = plane.currentSlot ?? plane.slotSize ?? defaultSlotSizeForPlane(plane);
  return nonNegativeFinite(value, 0);
}

/** Returns an unchanged detail record for waves that defer player losses. */
function unchangedOwnSlotDetails(base) {
  return base.map((plane, slotIndex) => ({
    slotIndex,
    before: plane?.currentSlot || 0,
    loss: 0,
    after: plane?.currentSlot || 0,
  }));
}

/** Returns the current slots for a normalized player base. */
function slotsForPlanes(base) {
  return base.map((plane) => plane?.currentSlot || 0);
}

/** Returns the current slots for a normalized enemy fleet. */
function slotsForEnemy(enemy) {
  return enemy.slots.map((slot) => slot.currentSlot);
}

/** Calculates enemy air without renormalizing its mutable simulation copy. */
function airPowerForEnemy(enemy) {
  return enemy.slots.reduce(
    (total, slot) => total + Math.floor(slot.sortieAntiAir * Math.sqrt(slot.currentSlot)),
    0,
  );
}

/** Normalizes requested wave targets while retaining legacy parity defaults. */
function normalizeTargets(targetStates, count) {
  const source = Array.isArray(targetStates) ? targetStates : [];
  const fallback = AIR_STATES[source[0]] ? source[0] : 'parity';
  return Array.from({ length: count }, (_, index) =>
    AIR_STATES[source[index]] ? source[index] : fallback);
}

/** Reads a state-keyed Stage 1 constant and rejects NONE explicitly. */
function stageOneConstant(map, stateKey) {
  if (stateKey === 'none') throw new Error('NONE must not be passed to Stage 1 formulas.');
  const constant = map[stateKey];
  if (constant == null) throw new Error(`Unknown air state: ${stateKey}`);
  return constant;
}

/** Checks explicit and derived aircraft capabilities. */
function hasCapability(plane, capability) {
  return Boolean(plane) &&
    (plane[capability] === true || capabilitiesFor(plane)[capability] === true);
}

/** Clamps arbitrary RNG output to the half-open unit interval. */
function unitRandom(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, 1 - Number.EPSILON);
}

/** Converts numeric input to a finite nonnegative value. */
function nonNegativeFinite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/** Sums one slot vector. */
function sumSlots(slots) {
  return slots.reduce((total, slot) => total + slot, 0);
}

/** Creates a zero-filled numeric structure with the same nested array shape. */
function zeroNested(values) {
  return values.map((value) => Array.isArray(value) ? zeroNested(value) : 0);
}

/** Adds one nested numeric structure into another in place. */
function addNested(total, values) {
  values.forEach((value, index) => {
    if (Array.isArray(value)) addNested(total[index], value);
    else total[index] += value;
  });
}

/** Divides a nested numeric accumulator without mutating it. */
function divideNested(total, divisor) {
  return total.map((value) => Array.isArray(value)
    ? divideNested(value, divisor)
    : value / divisor);
}

module.exports = {
  DETAILED_LIMITATIONS,
  calculateEnemyAirPower,
  enemyStageOneLoss,
  monteCarloWaveSequence,
  normalizeEnemyFleet,
  playerStageOneLoss,
  simulateWaveSequence,
};
