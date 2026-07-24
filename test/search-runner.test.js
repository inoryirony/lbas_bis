import { describe, expect, test, vi } from 'vitest';
import runnerModule from '../src/search-runner.js';

const { createSearchRunner } = runnerModule;

describe('worker search runner', () => {
  test('ignores stale events, cancels atomically, and disposes the worker', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }

    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const runner = createSearchRunner({ WorkerClass: FakeWorker });
    const firstId = runner.start({ marker: 'first' }, onFirst);
    const secondId = runner.start({ marker: 'second' }, onSecond);
    const worker = workers[0];

    worker.emit({ requestId: firstId, event: { type: 'progress' } });
    worker.emit({ requestId: secondId, event: { type: 'incumbent' } });
    runner.cancel();

    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledWith({ type: 'incumbent' });
    const start = worker.messages.find((message) => message.requestId === secondId && message.type === 'start');
    expect(Atomics.load(new Int32Array(start.cancellationBuffer), 0)).toBe(1);
    expect(worker.messages.at(-1)).toMatchObject({ type: 'cancel', requestId: secondId });

    runner.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  test('downgrades a queued optimal completion after cancellation was accepted', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }
    const events = [];
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 1 });
    const requestId = runner.start({ marker: 'late-optimal' }, (event) => events.push(event));

    expect(runner.cancel()).toBe(true);
    workers[0].emit({ requestId, event: {
      type: 'completed',
      result: {
        messages: [],
        results: [combatPlan(1, 10)],
        search: { status: 'optimal', provenOptimal: true },
      },
    } });

    expect(events.at(-1)).toMatchObject({
      type: 'cancelled',
      result: { search: { status: 'cancelled', provenOptimal: false } },
    });
    expect(events.at(-1).result.results).toHaveLength(1);
    runner.dispose();
  });

  test('streams a completed result from the real worker', async () => {
    const runner = createSearchRunner();
    const events = [];
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('worker search timed out')), 10000);
        runner.start(lockedStaticScenario(), (event) => {
          events.push(event);
          if (event.type === 'completed' || event.type === 'failed') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    } finally {
      runner.dispose();
    }

    expect(events[0]).toMatchObject({ type: 'started' });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: { search: { status: 'optimal', provenOptimal: true } },
    });
  });

  test('merges four combat suffix workers into one proven result and progress stream', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }

    const events = [];
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 4 });
    runner.start({
      optimizationObjective: 'combat',
      baseCount: 2,
      maxResults: 1,
      nodeBudget: Infinity,
    }, (event) => events.push(event));

    expect(workers).toHaveLength(4);
    const sharedCombatScoreBuffer = workers[0].messages[0].options.sharedCombatScoreBuffer;
    expect(sharedCombatScoreBuffer).toBeInstanceOf(SharedArrayBuffer);
    workers.forEach((worker, suffixShardIndex) => {
      expect(worker.messages[0]).toMatchObject({
        type: 'start',
        options: { suffixShardCount: 4, suffixShardIndex },
      });
      expect(worker.messages[0].options.sharedCombatScoreBuffer).toBe(sharedCombatScoreBuffer);
      const requestId = worker.messages[0].requestId;
      worker.emit({ requestId, event: { type: 'started' } });
      worker.emit({ requestId, event: {
        type: 'progress',
        suffixShardCount: 4,
        suffixEnumerationSharded: false,
        suffixTransitionGroups: 6,
        suffixTransitionGroupsAssigned: 2,
        suffixTransitionAssignmentComplete: true,
        suffixTransitionGroupsProcessed: 2,
      } });
      worker.emit({ requestId, event: {
        type: 'incumbent',
        plan: combatPlan(suffixShardIndex, 10 + suffixShardIndex),
      } });
      worker.emit({ requestId, event: {
        type: 'completed',
        result: {
          messages: [],
          results: [combatPlan(suffixShardIndex, 10 + suffixShardIndex)],
          search: {
            status: 'shard_complete',
            provenOptimal: false,
            optimalityScope: 'fixed_sample',
            evaluationSampleCount: 4096,
            formulaVersion: 'lbas-combat-v1',
            solverStats: {
              shardComplete: true,
              nodesExplored: suffixShardIndex + 1,
              totalNodesExplored: suffixShardIndex + 2,
              firstWaveAirBoundsPruned: suffixShardIndex + 1,
              prefixCombatReplays: suffixShardIndex + 1,
              prefixTrajectoryCacheHits: suffixShardIndex + 1,
              terminalPlanSimulations: suffixShardIndex + 1,
              terminalPlanSimulationReuses: suffixShardIndex + 1,
              suffixBucketCeilingsComputed: suffixShardIndex + 1,
              suffixBucketCeilingCacheHits: suffixShardIndex + 1,
              suffixFirstHpCacheHits: suffixShardIndex + 1,
              simulationSamplesEvaluated: 100 * (suffixShardIndex + 1),
              suffixShardCount: 4,
              suffixEnumerationSharded: false,
              suffixTransitionGroups: 6,
              suffixTransitionGroupsAssigned: 2,
              suffixTransitionAssignmentComplete: true,
              suffixTransitionGroupsProcessed: 2,
            },
          },
        },
      } });
    });

    expect(events.filter((event) => event.type === 'started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: {
        results: [{ simulation: { expectedSunkCount: 3 } }],
        search: {
          status: 'optimal',
          provenOptimal: true,
          optimalityScope: 'fixed_sample',
          evaluationSampleCount: 4096,
          formulaVersion: 'lbas-combat-v1',
          solverStats: {
            suffixTransitionGroups: 8,
            suffixTransitionGroupsAssigned: 8,
            suffixTransitionGroupsProcessed: 8,
            nodesExplored: 10,
            totalNodesExplored: 14,
            firstWaveAirBoundsPruned: 10,
            prefixCombatReplays: 10,
            prefixTrajectoryCacheHits: 10,
            terminalPlanSimulations: 10,
            terminalPlanSimulationReuses: 10,
            suffixBucketCeilingsComputed: 10,
            suffixBucketCeilingCacheHits: 10,
            suffixFirstHpCacheHits: 10,
            simulationSamplesEvaluated: 1000,
          },
        },
      },
    });
    expect(events.filter((event) => event.type === 'progress').at(-1)).toMatchObject({
      completedWork: 7,
      totalWork: 8,
    });

    runner.dispose();
    workers.forEach((worker) => expect(worker.terminate).toHaveBeenCalledOnce());
  });

  test('stops accepting cancellation before publishing certified 100% progress', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }

      terminate() {}
    }

    let cancelResult = null;
    const events = [];
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 2 });
    runner.start(parallelCombatScenario(), (event) => {
      events.push(event);
      if (event.type === 'progress' &&
          event.totalWork != null && event.completedWork === event.totalWork) {
        cancelResult = runner.cancel();
      }
    });
    const requestIds = workers.map((worker) => worker.messages[0].requestId);
    workers.forEach((worker, shardIndex) => {
      worker.emit({ requestId: requestIds[shardIndex], event: {
        type: 'progress',
        shardComplete: true,
        suffixShardCount: 2,
        suffixTransitionGroupsAssigned: 1,
        suffixTransitionAssignmentComplete: true,
        suffixTransitionGroupsProcessed: 1,
      } });
    });

    expect(cancelResult).toBe(false);
    expect(workers.flatMap((worker) => worker.messages)
      .filter((message) => message.type === 'cancel')).toHaveLength(0);

    workers.forEach((worker, shardIndex) => {
      worker.emit({ requestId: requestIds[shardIndex], event: {
        type: 'completed',
        result: {
          messages: [],
          results: [combatPlan(shardIndex, 10 + shardIndex)],
          search: {
            status: 'shard_complete',
            provenOptimal: false,
            solverStats: { shardComplete: true },
          },
        },
      } });
    });

    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: { search: { status: 'optimal', provenOptimal: true } },
    });
    runner.dispose();
  });

  test('keeps parallel progress below 100 percent until every shard is certified', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }

      terminate() {}
    }

    const events = [];
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 2 });
    runner.start(parallelCombatScenario(), (event) => events.push(event));
    workers.forEach((worker) => {
      worker.emit({ requestId: worker.messages[0].requestId, event: {
        type: 'progress',
        shardComplete: false,
        suffixShardCount: 2,
        suffixTransitionGroupsAssigned: 1,
        suffixTransitionAssignmentComplete: true,
        suffixTransitionGroupsProcessed: 1,
      } });
    });

    expect(events.filter((event) => event.type === 'progress').at(-1)).toMatchObject({
      completedWork: 1,
      totalWork: 2,
    });
    expect(runner.cancel()).toBe(true);
    runner.dispose();
  });

  test.each([
    { dispatchMode: 'separate' },
    { simulationOptions: { dispatchMode: 'separate' } },
    { enemyFleets: [{}, {}] },
    { maxResults: undefined },
  ])('keeps non-frontier two-base combat options on one serial worker: %j', (extra) => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }
    }
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 4 });

    runner.start({ ...parallelCombatScenario(), ...extra }, vi.fn());

    expect(workers).toHaveLength(1);
    expect(workers[0].messages[0].options.suffixShardCount).toBeUndefined();
    runner.dispose();
  });

  test('publishes one fixed suffix total only after every shard finishes assignment', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }

    const events = [];
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 4 });
    runner.start(parallelCombatScenario(), (event) => events.push(event));
    const emitProgress = (shardIndex, assigned, processed, assignmentComplete) => {
      const worker = workers[shardIndex];
      worker.emit({
        requestId: worker.messages[0].requestId,
        event: {
          type: 'progress',
          suffixShardCount: 4,
          suffixTransitionGroupsAssigned: assigned,
          suffixTransitionGroupsProcessed: processed,
          suffixTransitionAssignmentComplete: assignmentComplete,
        },
      });
    };

    emitProgress(0, 2, 0, true);
    emitProgress(1, 3, 0, true);
    emitProgress(2, 1, 0, true);
    expect(events.filter((event) => event.type === 'progress').at(-1)).toMatchObject({
      completedWork: 0,
      totalWork: null,
    });

    emitProgress(3, 2, 0, true);
    emitProgress(0, 2, 1, true);
    const determinate = events.filter((event) => event.type === 'progress').slice(-2);
    expect(determinate.map((event) => event.totalWork)).toEqual([8, 8]);
    expect(determinate.map((event) => event.completedWork)).toEqual([0, 1]);

    runner.dispose();
  });

  test('keeps parallel phases monotonic and fails immediately while cancelling siblings', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }
    const events = [];
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 4 });
    runner.start(parallelCombatScenario(), (event) => events.push(event));
    const requestIds = workers.map((worker) => worker.messages[0].requestId);

    workers[0].emit({ requestId: requestIds[0], event: {
      type: 'phase_changed', phase: 'finding_feasible',
    } });
    workers[0].emit({ requestId: requestIds[0], event: {
      type: 'phase_changed', phase: 'proving_optimal',
    } });
    workers[1].emit({ requestId: requestIds[1], event: {
      type: 'phase_changed', phase: 'improving',
    } });
    workers[2].emit({ requestId: requestIds[2], event: {
      type: 'failed', error: { name: 'Error', message: 'shard exploded', stack: '' },
    } });

    expect(events.filter((event) => event.type === 'phase_changed').map((event) => event.phase))
      .toEqual(['finding_feasible', 'proving_optimal']);
    expect(events.at(-1)).toMatchObject({
      type: 'failed', error: { message: 'shard exploded' },
    });
    workers.forEach((worker, index) => {
      if (index === 2) return;
      const start = worker.messages[0];
      expect(Atomics.load(new Int32Array(start.cancellationBuffer), 0)).toBe(1);
      expect(worker.messages.at(-1)).toMatchObject({ type: 'cancel' });
    });

    workers[0].emit({ requestId: requestIds[0], event: { type: 'cancelled' } });
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(1);
    runner.dispose();
  });

  test('allows a terminal callback to start and then cancel a replacement search', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 1 });
    let replacementId = null;
    const firstId = runner.start({ marker: 'first' }, (event) => {
      if (event.type === 'completed') {
        replacementId = runner.start({ marker: 'replacement' }, vi.fn());
      }
    });
    const worker = workers[0];
    worker.emit({ requestId: firstId, event: {
      type: 'completed', result: { results: [], search: { status: 'optimal' } },
    } });

    expect(replacementId).toBeTruthy();
    expect(runner.cancel()).toBe(true);
    expect(worker.messages.at(-1)).toMatchObject({ type: 'cancel', requestId: replacementId });
    runner.dispose();
  });

  test('does not let a replaced serial terminal clear a newer parallel search', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 4 });
    const serialId = runner.start({ marker: 'serial' }, vi.fn());
    runner.start(parallelCombatScenario(), vi.fn());

    expect(workers).toHaveLength(5);
    workers[0].emit({ requestId: serialId, event: {
      type: 'cancelled', result: { results: [], search: { status: 'cancelled' } },
    } });

    expect(runner.cancel()).toBe(true);
    workers.slice(1).forEach((worker) => {
      expect(worker.messages.at(-1)).toMatchObject({ type: 'cancel' });
    });
    runner.dispose();
  });

  test('waits for termination before replacing a worker without SharedArrayBuffer', async () => {
    const workers = [];
    /** @type {(value?: void) => void} */
    let finishTermination = () => {};
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn(() => new Promise((resolve) => {
          finishTermination = resolve;
        }));
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }
    }
    const runner = createSearchRunner({
      WorkerClass: FakeWorker,
      SharedArrayBufferClass: null,
      parallelShardCount: 1,
    });
    runner.start({ marker: 'first' }, vi.fn());
    const replacementId = runner.start({ marker: 'replacement' }, vi.fn());

    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toHaveLength(1);
    finishTermination();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[1].messages[0]).toMatchObject({
      type: 'start', requestId: replacementId, options: { marker: 'replacement' },
    });
    runner.dispose();
  });

  test('cancels a queued search safely while the failed worker is still terminating', async () => {
    const workers = [];
    /** @type {(value?: void) => void} */
    let finishTermination = () => {};
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn(() => new Promise((resolve) => {
          finishTermination = resolve;
        }));
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emitError(error) {
        this.listeners.get('error')?.(error);
      }
    }
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 1 });
    runner.start({ marker: 'failed' }, vi.fn());
    workers[0].emitError(new Error('worker failed'));
    const events = [];
    runner.start({ marker: 'queued' }, (event) => events.push(event));

    expect(() => runner.cancel()).not.toThrow();
    expect(events.at(-1)).toMatchObject({
      type: 'cancelled',
      result: { search: { status: 'cancelled', provenOptimal: false } },
    });
    finishTermination();
    await Promise.resolve();
    await Promise.resolve();
    expect(workers).toHaveLength(1);
    runner.dispose();
  });

  test('preserves the global incumbent when parallel cancellation completes', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }
    const events = [];
    const runner = createSearchRunner({ WorkerClass: FakeWorker, parallelShardCount: 4 });
    runner.start(parallelCombatScenario(), (event) => events.push(event));
    const requestIds = workers.map((worker) => worker.messages[0].requestId);
    workers[0].emit({ requestId: requestIds[0], event: {
      type: 'incumbent', plan: combatPlan(1, 10),
    } });
    workers[1].emit({ requestId: requestIds[1], event: {
      type: 'incumbent', plan: combatPlan(2, 20),
    } });

    expect(runner.cancel()).toBe(true);
    workers.forEach((worker, index) => worker.emit({
      requestId: requestIds[index],
      event: { type: 'cancelled', result: { results: [], search: { status: 'cancelled' } } },
    }));

    expect(events.at(-1)).toMatchObject({
      type: 'cancelled',
      result: {
        results: [{ simulation: { expectedSunkCount: 2, expectedHpDamage: 20 } }],
        search: { status: 'cancelled', provenOptimal: false },
      },
    });
    runner.dispose();
  });

  test('uses the Electron Web Worker event interface when available', () => {
    const workers = [];
    class FakeWebWorker {
      constructor(url) {
        this.url = url;
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      addEventListener(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(type, data) {
        this.listeners.get(type)?.(type === 'message' ? { data } : data);
      }
    }

    const onEvent = vi.fn();
    const runner = createSearchRunner({
      BrowserWorkerClass: FakeWebWorker,
      preferBrowserWorker: true,
      SharedArrayBufferClass: null,
      workerPath: 'C:\\plugin\\src\\optimizer-worker.js',
    });
    const requestId = runner.start({ marker: 'electron' }, onEvent);
    const worker = workers[0];

    expect(worker.url).toMatch(/^file:/);
    expect(worker.messages[0]).not.toHaveProperty('cancellationBuffer');
    worker.emit('message', { requestId, event: { type: 'started' } });
    expect(onEvent).toHaveBeenCalledWith({ type: 'started' });

    expect(runner.cancel()).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cancelled',
      result: expect.objectContaining({
        search: expect.objectContaining({ status: 'cancelled', provenOptimal: false }),
      }),
    }));

    runner.start({ marker: 'second-electron-search' }, vi.fn());
    expect(workers).toHaveLength(2);

    runner.dispose();
    expect(workers[1].terminate).toHaveBeenCalledOnce();
  });
});

function lockedStaticScenario() {
  const fighter = {
    instanceId: 'worker-fighter',
    masterId: 1,
    name: 'worker fighter',
    equipType: 48,
    antiAir: 12,
    radius: 7,
    improvement: 0,
    proficiency: 0,
    isPlane: true,
    isFighter: true,
    isLandBased: true,
    role: 'fighter',
  };
  return {
    equipment: [fighter],
    baseCount: 1,
    targetRadius: 7,
    enemyAir: 20,
    targetStates: ['parity', 'parity'],
    lockedBases: [{ slots: [
      { plane: fighter, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
    ] }],
    nodeBudget: Infinity,
    maxResults: 1,
  };
}

/** Creates the minimal option shape that activates the parallel combat runner. */
function parallelCombatScenario() {
  return {
    optimizationObjective: 'combat',
    baseCount: 2,
    maxResults: 1,
    nodeBudget: Infinity,
    simulationWorkBudget: Infinity,
  };
}

/** Creates one target-feasible combat incumbent for parallel runner tests. */
function combatPlan(expectedSunkCount, expectedHpDamage) {
  return {
    allWaveTargetFulfillmentProbability: 1,
    simulation: { expectedSunkCount, expectedHpDamage },
    totalDamagePower: expectedHpDamage,
    totalExpectedLoss: 0,
    totalResourceCost: 0,
    worstMargin: 0,
    scarcityCost: 0,
    canonicalKey: `combat-${expectedSunkCount}`,
    bases: [],
  };
}
