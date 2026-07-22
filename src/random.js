'use strict';

const UINT64_MASK = 0xffffffffffffffffn;
const SPLITMIX_INCREMENT = 0x9e3779b97f4a7c15n;
const TWO_POW_53 = 0x20000000000000;

/** Creates a repeatable SplitMix64 generator with a full 64-bit state. */
function createSeededRandom(seed) {
  let state = hashString64(String(seed));
  return function seededRandom() {
    state = (state + SPLITMIX_INCREMENT) & UINT64_MASK;
    return uint64ToUnitFloat(splitMix64(state));
  };
}

/** Returns one CRN draw identified only by its complete simulation coordinates. */
function commonRandomNumber(seed, sample, wave, side, slot, draw) {
  const key = coordinateKey64(seed, sample, wave, side, slot, draw);
  return uint64ToUnitFloat(splitMix64((key + SPLITMIX_INCREMENT) & UINT64_MASK));
}

/** Creates a coordinate-addressed common-random-number helper for one seed. */
function createCommonRandom(seed) {
  return (sample, wave, side, slot, draw) =>
    commonRandomNumber(seed, sample, wave, side, slot, draw);
}

/** Precomputes each non-sample coordinate across a fixed Monte Carlo sample set. */
function createFixedSampleRandom(seed, sampleCount, source = commonRandomNumber) {
  const count = Math.max(1, Math.floor(Number(sampleCount) || 0));
  const waves = new Map();

  return function fixedSampleRandom(sample, wave, side, slot, draw) {
    let sides = waves.get(wave);
    if (!sides) {
      sides = new Map();
      waves.set(wave, sides);
    }
    let slots = sides.get(side);
    if (!slots) {
      slots = new Map();
      sides.set(side, slots);
    }
    let draws = slots.get(slot);
    if (!draws) {
      draws = new Map();
      slots.set(slot, draws);
    }
    let values = draws.get(draw);
    if (!values) {
      values = new Float64Array(count);
      for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
        values[sampleIndex] = source(seed, sampleIndex, wave, side, slot, draw);
      }
      draws.set(draw, values);
    }
    return values[sample];
  };
}

/** Hashes a length-delimited coordinate tuple to a stable unsigned 64-bit key. */
function coordinateKey64(seed, sample, wave, side, slot, draw) {
  const serialized = [seed, sample, wave, side, slot, draw]
    .map((value) => {
      const text = String(value);
      return `${text.length}:${text}`;
    })
    .join('|');
  return hashString64(serialized);
}

/** Hashes UTF-16 text with FNV-1a and a SplitMix64 finalizer. */
function hashString64(value) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = (hash * 0x100000001b3n) & UINT64_MASK;
    hash ^= BigInt(codeUnit >>> 8);
    hash = (hash * 0x100000001b3n) & UINT64_MASK;
  }
  return splitMix64(hash);
}

/** Applies the SplitMix64 avalanche permutation to one unsigned integer. */
function splitMix64(value) {
  let mixed = BigInt(value) & UINT64_MASK;
  mixed = ((mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n) & UINT64_MASK;
  mixed = ((mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn) & UINT64_MASK;
  return (mixed ^ (mixed >> 31n)) & UINT64_MASK;
}

/** Converts the high 53 random bits to a deterministic uniform in [0, 1). */
function uint64ToUnitFloat(value) {
  return Number((BigInt(value) & UINT64_MASK) >> 11n) / TWO_POW_53;
}

module.exports = {
  commonRandomNumber,
  coordinateKey64,
  createCommonRandom,
  createFixedSampleRandom,
  createSeededRandom,
  hashString64,
  splitMix64,
  uint64ToUnitFloat,
};
