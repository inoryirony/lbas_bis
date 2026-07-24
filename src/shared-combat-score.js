'use strict';

const WORD = Object.freeze({
  VERSION: 0,
  LOCK: 1,
  HAS_SCORE: 2,
  SUNK: 3,
  HP_DAMAGE: 4,
  COUNT: 5,
});

/** Allocates the small atomic score cell shared by parallel proof workers. */
function createSharedCombatScoreBuffer(SharedArrayBufferClass = globalThis.SharedArrayBuffer) {
  return SharedArrayBufferClass
    ? new SharedArrayBufferClass(WORD.COUNT * Int32Array.BYTES_PER_ELEMENT)
    : null;
}

/** Publishes a better primary combat score as exact fixed-sample numerators. */
function publishSharedCombatScore(buffer, score, sampleCount) {
  const view = sharedScoreView(buffer);
  if (!view) return false;
  const denominator = positiveSampleCount(sampleCount);
  const sunk = exactNumerator(score?.sunk, denominator);
  const hpDamage = exactNumerator(score?.hpDamage, denominator);
  if (sunk == null || hpDamage == null) return false;
  acquireScoreLock(view);
  try {
    const hasScore = Atomics.load(view, WORD.HAS_SCORE) === 1;
    const currentSunk = Atomics.load(view, WORD.SUNK);
    const currentHpDamage = Atomics.load(view, WORD.HP_DAMAGE);
    if (hasScore && (sunk < currentSunk ||
        (sunk === currentSunk && hpDamage <= currentHpDamage))) return false;
    Atomics.add(view, WORD.VERSION, 1);
    Atomics.store(view, WORD.SUNK, sunk);
    Atomics.store(view, WORD.HP_DAMAGE, hpDamage);
    Atomics.store(view, WORD.HAS_SCORE, 1);
    Atomics.add(view, WORD.VERSION, 1);
    return true;
  } finally {
    Atomics.store(view, WORD.LOCK, 0);
    Atomics.notify(view, WORD.LOCK, 1);
  }
}

/** Reads one consistent shared primary score without blocking a proof worker. */
function readSharedCombatScore(buffer, sampleCount) {
  const view = sharedScoreView(buffer);
  if (!view) return null;
  const denominator = positiveSampleCount(sampleCount);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = Atomics.load(view, WORD.VERSION);
    if (before % 2 !== 0 || Atomics.load(view, WORD.LOCK) !== 0) continue;
    const hasScore = Atomics.load(view, WORD.HAS_SCORE);
    const sunk = Atomics.load(view, WORD.SUNK);
    const hpDamage = Atomics.load(view, WORD.HP_DAMAGE);
    const after = Atomics.load(view, WORD.VERSION);
    if (before !== after || after % 2 !== 0) continue;
    return hasScore === 1 ? {
      sunk: sunk / denominator,
      hpDamage: hpDamage / denominator,
    } : null;
  }
  return null;
}

/** Returns the expected Int32 view or disables sharing for unsupported buffers. */
function sharedScoreView(buffer) {
  if (!buffer || buffer.byteLength !== WORD.COUNT * Int32Array.BYTES_PER_ELEMENT) return null;
  return new Int32Array(buffer);
}

/** Acquires the rare writer lock without involving the worker event loop. */
function acquireScoreLock(view) {
  while (Atomics.compareExchange(view, WORD.LOCK, 0, 1) !== 0) {
    // Incumbents are rare and the critical section is only five atomic operations.
  }
}

/** Converts a representable expected score back to its exact fixed-sample numerator. */
function exactNumerator(value, sampleCount) {
  const numerator = Math.round(Number(value) * sampleCount);
  if (!Number.isSafeInteger(numerator) || numerator < 0 || numerator > 0x7fffffff) {
    return null;
  }
  return numerator;
}

/** Validates the denominator shared by every fixed-sample worker. */
function positiveSampleCount(value) {
  const sampleCount = Math.floor(Number(value));
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    throw new RangeError('Shared combat score requires a positive sample count.');
  }
  return sampleCount;
}

module.exports = {
  createSharedCombatScoreBuffer,
  publishSharedCombatScore,
  readSharedCombatScore,
};
