import { describe, expect, test } from 'vitest';
import detailedSolverModule from '../src/detailed-exact-solver.js';

const { createWorkController } = detailedSolverModule;

describe('detailed exact solver progress', () => {
  test('node cadence reports the active trajectory phase instead of regressing', () => {
    const progress = [];
    const stats = { nodesExplored: 4095 };
    const work = createWorkController(
      { budget: Infinity },
      { onProgress: (snapshot) => progress.push(snapshot) },
      stats,
      Date.now(),
    );

    work.setProgressPhase('evaluating_suffix_trajectories');

    expect(work.consume()).toBe(true);
    expect(progress).toEqual([
      expect.objectContaining({
        phase: 'evaluating_suffix_trajectories',
        nodesExplored: 4096,
      }),
    ]);
  });
});
