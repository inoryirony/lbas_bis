import { describe, expect, test } from 'vitest';
import randomModule from '../src/random.js';

const {
  commonRandomNumber,
  coordinateKey64,
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
});
