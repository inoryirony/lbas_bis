import { describe, expect, test } from 'vitest';
import distributionModule from '../src/stage-one-distribution.js';

const {
  advanceEnemyStageOneDistribution,
  enemyStageOneLossForDraws,
  enemyStageOneRemainingDistribution,
} = distributionModule;

describe('exact enemy Stage 1 distribution', () => {
  test('enumerates the hand-calculated loss-state PMF for a ten-plane slot', () => {
    expect(enemyStageOneRemainingDistribution('loss', 10)).toEqual([
      { remaining: 9, loss: 1, outcomes: 1, probability: 0.25 },
      { remaining: 10, loss: 0, outcomes: 3, probability: 0.75 },
    ]);
    expect(enemyStageOneLossForDraws('loss', 10, 1, 1)).toBe(1);
  });

  test.each(['supremacy', 'superiority', 'parity', 'denial', 'loss'])(
    'preserves total probability for %s',
    (stateKey) => {
      const distribution = enemyStageOneRemainingDistribution(stateKey, 96);
      expect(distribution.reduce((total, outcome) => total + outcome.probability, 0))
        .toBeCloseTo(1, 14);
      expect(distribution.every((outcome) =>
        Number.isInteger(outcome.remaining) && outcome.remaining >= 0 && outcome.remaining <= 96))
        .toBe(true);
    },
  );

  test('merges equal two-slot paths into one sparse state', () => {
    const result = advanceEnemyStageOneDistribution(
      [{ slots: [10, 10], probability: 1, fulfilledProbability: 1 }],
      {
        sortieAntiAir: [1, 1],
        ownAir: 0,
        hasPlane: true,
        targetRank: 0,
      },
    );

    expect([...result.states.values()]).toEqual([
      { slots: [9, 9], probability: 0.0625, fulfilledProbability: 0.0625 },
      { slots: [9, 10], probability: 0.1875, fulfilledProbability: 0.1875 },
      { slots: [10, 9], probability: 0.1875, fulfilledProbability: 0.1875 },
      { slots: [10, 10], probability: 0.5625, fulfilledProbability: 0.5625 },
    ]);
    expect(result.probabilityMass).toBe(1);
    expect(result.fulfilledProbabilityMass).toBe(1);
    expect(result.stateProbabilities).toEqual({ loss: 1 });
  });

  test('keeps physical probability while zeroing failed target history', () => {
    const result = advanceEnemyStageOneDistribution(
      [{ slots: [10], probability: 1, fulfilledProbability: 1 }],
      {
        sortieAntiAir: [1],
        ownAir: 0,
        hasPlane: true,
        targetRank: 1,
      },
    );

    expect(result.probabilityMass).toBe(1);
    expect(result.fulfilledProbabilityMass).toBe(0);
  });

  test('fails explicitly instead of truncating an exact state distribution', () => {
    expect(() => advanceEnemyStageOneDistribution(
      [{ slots: [10, 10], probability: 1, fulfilledProbability: 1 }],
      {
        sortieAntiAir: [1, 1],
        ownAir: 0,
        hasPlane: true,
        targetRank: 0,
        stateBudget: 3,
      },
    )).toThrow(/state budget/i);
  });
});
