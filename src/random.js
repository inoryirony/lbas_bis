'use strict';

const UINT64_MASK = 0xffffffffffffffffn;
const SPLITMIX_INCREMENT = 0x9e3779b97f4a7c15n;
const TWO_POW_53 = 0x20000000000000;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT32_RANGE = 0x100000000;
const TWO_POW_21 = 0x200000;
const FNV_OFFSET_LOW = 0x84222325;
const FNV_OFFSET_HIGH = 0xcbf29ce4;
const FNV_PRIME_LOW = 0x000001b3;
const FNV_PRIME_HIGH = 0x00000100;
const SPLITMIX_INCREMENT_LOW = 0x7f4a7c15;
const SPLITMIX_INCREMENT_HIGH = 0x9e3779b9;
const SPLITMIX_FIRST_LOW = 0x1ce4e5b9;
const SPLITMIX_FIRST_HIGH = 0xbf58476d;
const SPLITMIX_SECOND_LOW = 0x133111eb;
const SPLITMIX_SECOND_HIGH = 0x94d049bb;

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
  const seedText = String(seed);
  const sampleHashLows = source === commonRandomNumber ? new Uint32Array(count) : null;
  const sampleHashHighs = source === commonRandomNumber ? new Uint32Array(count) : null;
  const pair = source === commonRandomNumber ? new Uint32Array(2) : null;
  if (sampleHashLows && sampleHashHighs && pair) {
    fnv1aString64PairInto(
      `${seedText.length}:${seedText}|`,
      FNV_OFFSET_LOW,
      FNV_OFFSET_HIGH,
      pair,
    );
    const seedPrefixLow = pair[0];
    const seedPrefixHigh = pair[1];
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
      const sampleText = String(sampleIndex);
      fnv1aString64PairInto(
        `${sampleText.length}:${sampleText}`,
        seedPrefixLow,
        seedPrefixHigh,
        pair,
      );
      sampleHashLows[sampleIndex] = pair[0];
      sampleHashHighs[sampleIndex] = pair[1];
    }
  }

  /** Materializes one coordinate vector and returns the same vector on every lookup. */
  function valuesFor(wave, side, slot, draw) {
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
      if (source === commonRandomNumber && sampleHashLows && sampleHashHighs && pair) {
        const suffix = `|${[wave, side, slot, draw]
          .map((value) => {
            const text = String(value);
            return `${text.length}:${text}`;
          })
          .join('|')}`;
        for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
          fnv1aString64PairInto(
            suffix,
            sampleHashLows[sampleIndex],
            sampleHashHighs[sampleIndex],
            pair,
          );
          splitMix64PairInto(pair[0], pair[1], pair);
          const incrementedLow = (pair[0] + SPLITMIX_INCREMENT_LOW) >>> 0;
          const carry = incrementedLow < pair[0] ? 1 : 0;
          const incrementedHigh = (pair[1] + SPLITMIX_INCREMENT_HIGH + carry) >>> 0;
          splitMix64PairInto(incrementedLow, incrementedHigh, pair);
          values[sampleIndex] = (pair[1] * TWO_POW_21 + (pair[0] >>> 11)) / TWO_POW_53;
        }
      } else {
        for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
          values[sampleIndex] = source(seed, sampleIndex, wave, side, slot, draw);
        }
      }
      draws.set(draw, values);
    }
    return values;
  }

  /** Returns one precomputed value while retaining the coordinate-addressed API. */
  function fixedSampleRandom(sample, wave, side, slot, draw) {
    return valuesFor(wave, side, slot, draw)[sample];
  }
  fixedSampleRandom.valuesFor = valuesFor;
  return fixedSampleRandom;
}

/** Extends one unsigned 64-bit FNV-1a pair with UTF-16 bytes. */
function fnv1aString64PairInto(value, initialLow, initialHigh, output) {
  let low = initialLow >>> 0;
  let high = initialHigh >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    low = (low ^ (codeUnit & 0xff)) >>> 0;
    let lowProduct = low * FNV_PRIME_LOW;
    high = (
      Math.floor(lowProduct / UINT32_RANGE) +
      Math.imul(high, FNV_PRIME_LOW) +
      Math.imul(low, FNV_PRIME_HIGH)
    ) >>> 0;
    low = lowProduct >>> 0;
    low = (low ^ (codeUnit >>> 8)) >>> 0;
    lowProduct = low * FNV_PRIME_LOW;
    high = (
      Math.floor(lowProduct / UINT32_RANGE) +
      Math.imul(high, FNV_PRIME_LOW) +
      Math.imul(low, FNV_PRIME_HIGH)
    ) >>> 0;
    low = lowProduct >>> 0;
  }
  output[0] = low;
  output[1] = high;
  return output;
}

/** Applies SplitMix64 to one unsigned low/high pair without BigInt arithmetic. */
function splitMix64PairInto(initialLow, initialHigh, output) {
  let low = (initialLow ^ ((initialLow >>> 30) | (initialHigh << 2))) >>> 0;
  let high = (initialHigh ^ (initialHigh >>> 30)) >>> 0;
  multiply64PairInto(
    low,
    high,
    SPLITMIX_FIRST_LOW,
    SPLITMIX_FIRST_HIGH,
    output,
  );
  low = (output[0] ^ ((output[0] >>> 27) | (output[1] << 5))) >>> 0;
  high = (output[1] ^ (output[1] >>> 27)) >>> 0;
  multiply64PairInto(
    low,
    high,
    SPLITMIX_SECOND_LOW,
    SPLITMIX_SECOND_HIGH,
    output,
  );
  output[0] = (output[0] ^ ((output[0] >>> 31) | (output[1] << 1))) >>> 0;
  output[1] = (output[1] ^ (output[1] >>> 31)) >>> 0;
  return output;
}

/** Multiplies two unsigned 64-bit low/high pairs modulo two to the sixty-fourth. */
function multiply64PairInto(leftLow, leftHigh, rightLow, rightHigh, output) {
  const leftLow16 = leftLow & 0xffff;
  const leftHigh16 = leftLow >>> 16;
  const rightLow16 = rightLow & 0xffff;
  const rightHigh16 = rightLow >>> 16;
  const lowProduct = leftLow16 * rightLow16;
  const middleProduct = leftHigh16 * rightLow16 +
    leftLow16 * rightHigh16 +
    Math.floor(lowProduct / 0x10000);
  output[0] = (((middleProduct & 0xffff) << 16) | (lowProduct & 0xffff)) >>> 0;
  output[1] = (
    leftHigh16 * rightHigh16 +
    Math.floor(middleProduct / 0x10000) +
    Math.imul(leftHigh, rightLow) +
    Math.imul(leftLow, rightHigh)
  ) >>> 0;
  return output;
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
  return splitMix64(fnv1aString64(value));
}

/** Extends a raw FNV-1a state with UTF-16 code units without finalizing it. */
function fnv1aString64(value, initialHash = FNV_OFFSET) {
  let hash = initialHash;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
    hash ^= BigInt(codeUnit >>> 8);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash;
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
