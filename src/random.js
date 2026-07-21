'use strict';

/** Creates a repeatable sequential pseudo-random number generator. */
function createSeededRandom(seed) {
  let state = hashString(String(seed));
  return function seededRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Returns one common-random-number draw identified only by its simulation coordinates.
 */
function commonRandomNumber(seed, sample, wave, side, slot, draw) {
  const key = [seed, sample, wave, side, slot, draw]
    .map((value) => `${String(value).length}:${String(value)}`)
    .join('|');
  return createSeededRandom(key)();
}

/** Creates a coordinate-addressed common-random-number helper for one seed. */
function createCommonRandom(seed) {
  return (sample, wave, side, slot, draw) =>
    commonRandomNumber(seed, sample, wave, side, slot, draw);
}

/** Hashes text to a stable unsigned 32-bit seed. */
function hashString(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

module.exports = {
  commonRandomNumber,
  createCommonRandom,
  createSeededRandom,
};
