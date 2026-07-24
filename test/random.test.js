import { describe, expect, test } from 'vitest';
import randomModule from '../src/random.js';

const {
  commonRandomNumber,
  coordinateKey64,
  createFixedSampleRandom,
  createSeededRandom,
} = randomModule;

describe('counter-based random helpers', () => {
  test('creates 96k unique stable 64-bit coordinate keys', () => {
    const sides = ['player', 'enemy-x', 'enemy-y', 'jet-player'];
    const keys = [];
    for (let sample = 0; sample < 1000; sample += 1) {
      for (let wave = 0; wave < 6; wave += 1) {
        for (const side of sides) {
          for (let slot = 0; slot < 4; slot += 1) {
            keys.push(coordinateKey64('wide-key', sample, wave, side, slot, 0));
          }
        }
      }
    }

    expect(keys).toHaveLength(96000);
    expect(keys.every((key) => typeof key === 'bigint' && key >= 0n && key <= 0xffffffffffffffffn))
      .toBe(true);
    expect(new Set(keys.map(String)).size).toBe(keys.length);
    expect(keys[54321]).toBe(coordinateKey64(
      'wide-key',
      Math.floor(54321 / 96),
      Math.floor((54321 % 96) / 16),
      sides[Math.floor((54321 % 16) / 4)],
      54321 % 4,
      0,
    ));
  });

  test('returns deterministic uniforms in the half-open unit interval', () => {
    const first = createSeededRandom('wide-state');
    const second = createSeededRandom('wide-state');
    const values = Array.from({ length: 4096 }, () => first());

    expect(values).toEqual(Array.from({ length: 4096 }, () => second()));
    expect(values.every((value) => Number.isFinite(value) && value >= 0 && value < 1)).toBe(true);
    expect(commonRandomNumber('wide-state', 1, 2, 'enemy', 3, 4))
      .toBe(commonRandomNumber('wide-state', 1, 2, 'enemy', 3, 4));
  });

  test('precomputes each fixed-sample coordinate once for reuse across candidates', () => {
    const sampleCount = 50;
    let generated = 0;
    const fixedRandom = createFixedSampleRandom('shared-search', sampleCount, (...coordinates) => {
      generated += 1;
      return commonRandomNumber(...coordinates);
    });

    const firstPass = Array.from({ length: sampleCount }, (_, sample) =>
      fixedRandom(sample, 2, 'enemy', 'slot-15', 1));
    const secondPass = Array.from({ length: sampleCount }, (_, sample) =>
      fixedRandom(sample, 2, 'enemy', 'slot-15', 1));

    expect(firstPass).toEqual(Array.from({ length: sampleCount }, (_, sample) =>
      commonRandomNumber('shared-search', sample, 2, 'enemy', 'slot-15', 1)));
    expect(secondPass).toEqual(firstPass);
    expect(generated).toBe(sampleCount);
  });

  test('keeps the default fixed table bit-identical to coordinate random draws', () => {
    const sampleCount = 64;
    const seed = '固定样本-seed';
    const fixedRandom = createFixedSampleRandom(seed, sampleCount);
    const coordinates = [
      [0, 'enemy', 'slot-15', 1],
      [3, 'combat-hit', 2, 0],
      [5, 'player', 129763, 0],
    ];

    for (const [wave, side, slot, draw] of coordinates) {
      expect(Array.from({ length: sampleCount }, (_, sample) =>
        fixedRandom(sample, wave, side, slot, draw)))
        .toEqual(Array.from({ length: sampleCount }, (_, sample) =>
          commonRandomNumber(seed, sample, wave, side, slot, draw)));
    }
  });

  test('exposes one stable vector per non-sample coordinate', () => {
    const sampleCount = 32;
    const fixedRandom = createFixedSampleRandom('fixed-vector', sampleCount);
    const first = fixedRandom.valuesFor(1, 'player', 2, 0);
    const second = fixedRandom.valuesFor(1, 'player', 2, 0);

    expect(second).toBe(first);
    expect(first).toBeInstanceOf(Float64Array);
    expect(Array.from(first)).toEqual(Array.from({ length: sampleCount }, (_, sample) =>
      fixedRandom(sample, 1, 'player', 2, 0)));
  });
});
