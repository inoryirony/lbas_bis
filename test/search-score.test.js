import { describe, expect, test } from 'vitest';
import scoreModule from '../src/search-score.js';

const { comparePlanScores, scorePlan } = scoreModule;

describe('plan score ordering', () => {
  test('normalizes signed zero and non-finite score fields to finite values', () => {
    const score = scorePlan({
      fulfillment: Number.NaN,
      damage: Number.POSITIVE_INFINITY,
      loss: Number.NEGATIVE_INFINITY,
      resource: -0,
      margin: Number.NaN,
      scarcity: Number.POSITIVE_INFINITY,
      canonicalKey: 'pathological',
    });

    for (const field of ['fulfillment', 'damage', 'loss', 'resource', 'margin', 'scarcity']) {
      expect(Number.isFinite(score[field])).toBe(true);
      expect(Object.is(score[field], -0)).toBe(false);
    }
  });

  test('is antisymmetric and transitive for pathological score inputs', () => {
    const scores = [
      { damage: -0, resource: 0, margin: 0, scarcity: 0, canonicalKey: 'a' },
      { damage: 0, resource: 0, margin: 0, scarcity: 0, canonicalKey: 'b' },
      { damage: Number.NaN, resource: 1, margin: 0, scarcity: 0, canonicalKey: 'c' },
      { damage: Number.POSITIVE_INFINITY, resource: 0, margin: 0, scarcity: 0, canonicalKey: 'd' },
      { damage: 1, resource: Number.NEGATIVE_INFINITY, margin: 0, scarcity: 0, canonicalKey: 'e' },
    ];

    for (const left of scores) {
      for (const right of scores) {
        expect(
          Math.sign(comparePlanScores(left, right)) +
          Math.sign(comparePlanScores(right, left)),
        ).toBe(0);
      }
    }
    const ordered = [...scores].sort((left, right) => -comparePlanScores(left, right));
    for (let left = 0; left < ordered.length; left += 1) {
      for (let middle = left; middle < ordered.length; middle += 1) {
        for (let right = middle; right < ordered.length; right += 1) {
          expect(comparePlanScores(ordered[left], ordered[right])).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
