'use strict';

const { capabilitiesFor } = require('./aircraft');

const CONTACT_MULTIPLIERS = Object.freeze([1, 1.12, 1.17, 1.2]);
const CONTACT_AIR_STATE_KEYS = Object.freeze([
  null,
  'supremacy',
  'superiority',
  'parity',
  'denial',
  'loss',
  'none',
]);
const CONTACT_STATE_DENOMINATORS = Object.freeze({
  supremacy: Object.freeze({ start: 25, select: 14 }),
  superiority: Object.freeze({ start: 40, select: 16 }),
  denial: Object.freeze({ start: 55, select: 18 }),
});

/** Precomputes the immutable contact fields for one base. */
function prepareContactProfile(planes = []) {
  return {
    entries: planes.map((plane, slotIndex) => {
      if (!plane || !hasContactCapability(plane)) return null;
      const scout = Math.max(0, Number(plane.scout) || 0);
      if (scout <= 0) return null;
      return {
        slotIndex,
        scout,
        accuracy: Number(plane.accuracy) || 0,
        contributesToStart: Number(plane.equipType) !== 8,
      };
    }).filter(Boolean),
  };
}

/** Returns the final mutually exclusive contact-tier probabilities for one wave. */
function contactTierProbabilities(profile, slots, airStateKey) {
  const denominators = CONTACT_STATE_DENOMINATORS[airStateKey];
  if (!denominators) return noContactProbabilities();
  const entries = profile?.entries || [];
  let scoutPower = 1;
  const failureByTier = [1, 1, 1];
  for (const entry of entries) {
    const slot = Math.max(0, Number(slots?.[entry.slotIndex]) || 0);
    if (slot <= 0) continue;
    if (entry.contributesToStart) {
      scoutPower += Math.floor(Math.sqrt(slot) * entry.scout);
    }
    const selectionProbability = Math.min(1, entry.scout / denominators.select);
    const tier = entry.accuracy >= 3 ? 2 : entry.accuracy === 2 ? 1 : 0;
    failureByTier[tier] *= 1 - selectionProbability;
  }
  const start = Math.min(1, scoutPower / denominators.start);
  const anyHigh = 1 - failureByTier[2];
  const anyMiddle = 1 - failureByTier[1];
  const anyLow = 1 - failureByTier[0];
  const high = start * anyHigh;
  const middle = start * failureByTier[2] * anyMiddle;
  const low = start * failureByTier[2] * failureByTier[1] * anyLow;
  return {
    start,
    high,
    middle,
    low,
    none: Math.max(0, 1 - high - middle - low),
  };
}

/** Maps one aggregate uniform draw to the highest successful contact tier. */
function contactMultiplierForRoll(probabilities, roll) {
  const value = unitRoll(roll);
  if (value < probabilities.high) return 1.2;
  if (value < probabilities.high + probabilities.middle) return 1.17;
  if (value < probabilities.high + probabilities.middle + probabilities.low) return 1.12;
  return 1;
}

/** Creates one battle-scoped contact continuation state. */
function createContactState(options = {}) {
  return {
    previousAirStateKey: typeof options.previousAirStateKey === 'string'
      ? options.previousAirStateKey
      : null,
    previousSuccessfulMultiplier: normalizeContactMultiplier(
      options.previousSuccessfulMultiplier,
    ),
  };
}

/** Resolves a wave and returns both its multiplier and the next continuation state. */
function resolveContactState(profile, slots, airStateKey, previousState, roll) {
  const state = createContactState(previousState);
  const effectiveAirStateKey = airStateKey === 'parity'
    ? state.previousAirStateKey || 'parity'
    : airStateKey;
  const previousAirStateKey = airStateKey === 'parity'
    ? state.previousAirStateKey
    : airStateKey;
  let multiplier = 1;
  let previousSuccessfulMultiplier = state.previousSuccessfulMultiplier;
  if (effectiveAirStateKey === 'loss') {
    multiplier = previousSuccessfulMultiplier;
  } else if (CONTACT_STATE_DENOMINATORS[effectiveAirStateKey]) {
    multiplier = contactMultiplierForRoll(
      contactTierProbabilities(profile, slots, effectiveAirStateKey),
      roll,
    );
    if (multiplier > 1) previousSuccessfulMultiplier = multiplier;
  }
  const nextState = {
    previousAirStateKey,
    previousSuccessfulMultiplier,
  };
  return {
    effectiveAirStateKey,
    multiplier,
    previousAirStateKey,
    previousSuccessfulMultiplier,
    state: nextState,
  };
}

/** Returns the stable index used by compact contact trajectories. */
function contactMultiplierIndex(multiplier) {
  const normalized = normalizeContactMultiplier(multiplier);
  return CONTACT_MULTIPLIERS.indexOf(normalized);
}

/** Restores one compact contact multiplier index. */
function contactMultiplierAt(index) {
  return CONTACT_MULTIPLIERS[Math.max(0, Math.min(3, Math.floor(Number(index) || 0)))] || 1;
}

/** Encodes one contact continuation as two compact integer fields. */
function encodeContactState(state) {
  const normalized = createContactState(state);
  return [
    Math.max(0, CONTACT_AIR_STATE_KEYS.indexOf(normalized.previousAirStateKey)),
    contactMultiplierIndex(normalized.previousSuccessfulMultiplier),
  ];
}

/** Decodes two compact integer fields into one contact continuation. */
function decodeContactState(values) {
  return createContactState({
    previousAirStateKey: CONTACT_AIR_STATE_KEYS[Number(values?.[0]) || 0] || null,
    previousSuccessfulMultiplier: contactMultiplierAt(values?.[1]),
  });
}

/** Checks explicit or master-derived contact capability. */
function hasContactCapability(plane) {
  return plane?.canContact === true || capabilitiesFor(plane).canContact === true;
}

/** Returns the only exact contact multipliers emitted by the reference state machine. */
function normalizeContactMultiplier(value) {
  const number = Number(value);
  return CONTACT_MULTIPLIERS.includes(number) ? number : 1;
}

/** Creates the canonical distribution for an ineligible air state. */
function noContactProbabilities() {
  return { start: 0, high: 0, middle: 0, low: 0, none: 1 };
}

/** Clamps one deterministic contact coordinate to the half-open unit interval. */
function unitRoll(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, 1 - Number.EPSILON);
}

module.exports = {
  CONTACT_MULTIPLIERS,
  CONTACT_AIR_STATE_KEYS,
  contactMultiplierAt,
  contactMultiplierForRoll,
  contactMultiplierIndex,
  contactTierProbabilities,
  createContactState,
  decodeContactState,
  encodeContactState,
  prepareContactProfile,
  resolveContactState,
};
