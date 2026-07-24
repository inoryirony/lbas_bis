import { describe, expect, test } from 'vitest';
import searchEventsModule from '../src/search-events.js';

const { progressEvent } = searchEventsModule;

describe('search progress events', () => {
  test('preserves solver-specific counters for live diagnostics', () => {
    expect(progressEvent({
      phase: 'proving_optimal',
      prefixStates: 267,
      suffixTransitionsEvaluated: 1234,
      frontierBucketCombatBoundsPruned: 5678,
    })).toMatchObject({
      type: 'progress',
      prefixStates: 267,
      suffixTransitionsEvaluated: 1234,
      frontierBucketCombatBoundsPruned: 5678,
    });
  });
});
