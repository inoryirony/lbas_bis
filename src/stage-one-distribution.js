'use strict';

const { airStateFor } = require('./air-power');

const ENEMY_STAGE_ONE_DRAW_MAX = Object.freeze({
  supremacy: 10,
  superiority: 8,
  parity: 6,
  denial: 4,
  loss: 1,
});

/** Calculates one exact enemy Stage 1 loss from its two integer draws. */
function enemyStageOneLossForDraws(stateKey, currentSlot, x, y) {
  const maximumDraw = drawMaximum(stateKey);
  const slot = nonNegativeInteger(currentSlot, 'currentSlot');
  const first = boundedDraw(x, maximumDraw, 'x');
  const second = boundedDraw(y, maximumDraw, 'y');
  return Math.min(slot, Math.floor(slot * (65 * first + 35 * second) / 1000));
}

/** Enumerates the exact remaining-slot PMF for one enemy aircraft slot. */
function enemyStageOneRemainingDistribution(stateKey, currentSlot) {
  const maximumDraw = drawMaximum(stateKey);
  const slot = nonNegativeInteger(currentSlot, 'currentSlot');
  const outcomeCount = (maximumDraw + 1) ** 2;
  const counts = new Map();
  for (let x = 0; x <= maximumDraw; x += 1) {
    for (let y = 0; y <= maximumDraw; y += 1) {
      const loss = enemyStageOneLossForDraws(stateKey, slot, x, y);
      const remaining = slot - loss;
      counts.set(remaining, (counts.get(remaining) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([remaining, outcomes]) => ({
      remaining,
      loss: slot - remaining,
      outcomes,
      probability: outcomes / outcomeCount,
    }));
}

/** Advances a sparse enemy-slot distribution through one exact Stage 1 wave. */
function advanceEnemyStageOneDistribution(states, options = {}) {
  const sortieAntiAir = (options.sortieAntiAir || []).map((value, index) =>
    nonNegativeFinite(value, `sortieAntiAir[${index}]`));
  const ownAir = nonNegativeFinite(options.ownAir, 'ownAir');
  const hasPlane = options.hasPlane !== false;
  const stateBudget = normalizeStateBudget(options.stateBudget);
  const targetRank = Number.isFinite(Number(options.targetRank))
    ? Number(options.targetRank)
    : Number.NEGATIVE_INFINITY;
  const nextStates = new Map();
  const stateProbabilities = {};

  for (const source of states || []) {
    const slots = (source?.slots || []).map((value, index) =>
      nonNegativeInteger(value, `slots[${index}]`));
    if (slots.length !== sortieAntiAir.length) {
      throw new RangeError('Enemy slot and sortieAntiAir lengths must match.');
    }
    const probability = nonNegativeFinite(source?.probability, 'probability');
    const fulfilledProbability = source?.fulfilledProbability == null
      ? probability
      : nonNegativeFinite(source.fulfilledProbability, 'fulfilledProbability');
    const enemyAir = sortieAntiAir.reduce(
      (total, antiAir, index) => total + Math.floor(antiAir * Math.sqrt(slots[index])),
      0,
    );
    const state = airStateFor(ownAir, enemyAir, hasPlane);
    stateProbabilities[state.key] = (stateProbabilities[state.key] || 0) + probability;
    const nextFulfilledProbability = state.rank >= targetRank ? fulfilledProbability : 0;
    const slotOutcomes = slots.map((slot) =>
      enemyStageOneRemainingDistribution(state.key, slot));

    expandSlotOutcomes(slotOutcomes, 0, [], 1, (nextSlots, pathProbability) => {
      const key = nextSlots.join(',');
      if (!nextStates.has(key) && nextStates.size >= stateBudget) {
        throw new RangeError(
          `Exact enemy Stage 1 state budget ${stateBudget} was exhausted; no states were truncated.`,
        );
      }
      const existing = nextStates.get(key) || {
        slots: nextSlots,
        probability: 0,
        fulfilledProbability: 0,
      };
      existing.probability += probability * pathProbability;
      existing.fulfilledProbability += nextFulfilledProbability * pathProbability;
      nextStates.set(key, existing);
    });
  }

  return {
    states: nextStates,
    probabilityMass: sumStateField(nextStates, 'probability'),
    fulfilledProbabilityMass: sumStateField(nextStates, 'fulfilledProbability'),
    stateProbabilities,
  };
}

function expandSlotOutcomes(outcomesBySlot, slotIndex, slots, probability, emit) {
  if (slotIndex === outcomesBySlot.length) {
    emit([...slots], probability);
    return;
  }
  for (const outcome of outcomesBySlot[slotIndex]) {
    slots.push(outcome.remaining);
    expandSlotOutcomes(
      outcomesBySlot,
      slotIndex + 1,
      slots,
      probability * outcome.probability,
      emit,
    );
    slots.pop();
  }
}

function sumStateField(states, field) {
  let total = 0;
  for (const state of states.values()) total += state[field];
  return total;
}

function drawMaximum(stateKey) {
  const maximum = ENEMY_STAGE_ONE_DRAW_MAX[stateKey];
  if (!Number.isInteger(maximum)) {
    throw new RangeError(`Unknown enemy Stage 1 air state: ${stateKey}`);
  }
  return maximum;
}

function boundedDraw(value, maximum, name) {
  const draw = Number(value);
  if (!Number.isInteger(draw) || draw < 0 || draw > maximum) {
    throw new RangeError(`${name} must be an integer from 0 to ${maximum}.`);
  }
  return draw;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new RangeError(`${name} must be a nonnegative integer.`);
  }
  return number;
}

function nonNegativeFinite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number.`);
  }
  return number;
}

function normalizeStateBudget(value) {
  if (value == null || value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RangeError('stateBudget must be a positive integer or Infinity.');
  }
  return number;
}

module.exports = {
  ENEMY_STAGE_ONE_DRAW_MAX,
  advanceEnemyStageOneDistribution,
  enemyStageOneLossForDraws,
  enemyStageOneRemainingDistribution,
};
