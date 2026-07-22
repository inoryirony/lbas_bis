import { describe, expect, test } from 'vitest';
import statisticsModule from '../src/statistics.js';

const { wilsonScoreInterval } = statisticsModule;

describe('simulation statistics', () => {
  test.each([
    [0, 100, 0, 0.0369935],
    [50, 100, 0.4038315, 0.5961685],
    [100, 100, 0.9630065, 1],
  ])('calculates the 95%% Wilson interval for %i/%i', (successes, trials, lower, upper) => {
    expect(wilsonScoreInterval(successes, trials)).toEqual(expect.objectContaining({
      confidenceLevel: 0.95,
      successes,
      trials,
    }));
    expect(wilsonScoreInterval(successes, trials).lower).toBeCloseTo(lower, 6);
    expect(wilsonScoreInterval(successes, trials).upper).toBeCloseTo(upper, 6);
  });
});
