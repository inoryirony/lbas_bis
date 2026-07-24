'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { Worker: NodeWorker } = require('worker_threads');
const { availableParallelism } = require('os');
const { compareCombatPlanScores } = require('./search-score');
const { createSharedCombatScoreBuffer } = require('./shared-combat-score');

/**
 * Creates one public runner that parallelizes only the exact two-base combat proof.
 * @param {{parallelShardCount?: number, WorkerClass?: any, BrowserWorkerClass?: any, SharedArrayBufferClass?: any, preferBrowserWorker?: boolean, workerPath?: string}} [options]
 */
function createSearchRunner(options = {}) {
  const parallelShardCount = Math.max(1, Math.floor(Number(
    options.parallelShardCount ?? Math.min(4, availableParallelism()),
  ) || 1));
  const SharedArrayBufferClass = Object.hasOwn(options, 'SharedArrayBufferClass')
    ? options.SharedArrayBufferClass
    : globalThis.SharedArrayBuffer;
  const childOptions = { ...options };
  delete childOptions.parallelShardCount;
  const serial = createSingleSearchRunner(childOptions);
  let parallel = null;
  let activeMode = null;
  let activeGeneration = 0;
  let parallelState = null;
  let sequence = 0;

  /** Lazily allocates the worker pool only for an eligible combat proof. */
  function ensureParallel() {
    if (!parallel) {
      parallel = Array.from({ length: parallelShardCount }, () =>
        createSingleSearchRunner(childOptions));
    }
    return parallel;
  }

  /** Cancels the previously active mode before a replacement starts. */
  function cancelActive() {
    if (activeMode === 'serial') serial.cancel();
    if (activeMode === 'parallel') parallel?.forEach((runner) => runner.cancel());
    activeMode = null;
    activeGeneration = 0;
    parallelState = null;
  }

  return {
    start(searchOptions, onEvent) {
      cancelActive();
      const generation = sequence += 1;
      activeGeneration = generation;
      if (!shouldParallelizeCombat(searchOptions, parallelShardCount)) {
        activeMode = 'serial';
        return serial.start(searchOptions, (event) => {
          if (isTerminalEvent(event) && activeMode === 'serial' &&
              activeGeneration === generation) {
            activeMode = null;
            activeGeneration = 0;
          }
          onEvent(event);
        });
      }
      activeMode = 'parallel';
      const requestId = `parallel-search-${Date.now()}-${generation}`;
      const state = {
        requestId,
        onEvent,
        shards: Array.from({ length: parallelShardCount }, () => ({
          progress: null,
          terminal: null,
        })),
        started: false,
        phase: null,
        incumbent: null,
        done: false,
      };
      parallelState = state;
      const sharedCombatScoreBuffer = createSharedCombatScoreBuffer(SharedArrayBufferClass);
      ensureParallel().forEach((runner, suffixShardIndex) => {
        runner.start({
          ...searchOptions,
          suffixShardCount: parallelShardCount,
          suffixShardIndex,
          ...(sharedCombatScoreBuffer ? { sharedCombatScoreBuffer } : {}),
        }, (event) => handleParallelEvent(state, suffixShardIndex, event));
      });
      return requestId;
    },

    cancel() {
      if (!activeMode) return false;
      if (activeMode === 'serial') return serial.cancel();
      parallel?.forEach((runner) => runner.cancel());
      return true;
    },

    dispose() {
      serial.dispose();
      parallel?.forEach((runner) => runner.dispose());
      activeMode = null;
      activeGeneration = 0;
      parallelState = null;
    },
  };

  /** Aggregates one shard event while hiding intermediate shard completion. */
  function handleParallelEvent(state, shardIndex, event) {
    if (parallelState !== state || state.done) return;
    const shard = state.shards[shardIndex];
    if (event?.type === 'started') {
      if (!state.started) {
        state.started = true;
        state.onEvent(event);
      }
      return;
    }
    if (event?.type === 'phase_changed') {
      if (phaseRank(event.phase) > phaseRank(state.phase)) {
        state.phase = event.phase;
        state.onEvent(event);
      }
      return;
    }
    if (event?.type === 'progress') {
      shard.progress = event;
      if (state.shards.every((candidate) => candidate.progress?.shardComplete === true)) {
        activeMode = null;
        activeGeneration = 0;
      }
      state.onEvent(aggregateParallelProgress(state.shards));
      return;
    }
    if (event?.type === 'incumbent') {
      if (!state.incumbent || compareCombatPlanScores(event.plan, state.incumbent) > 0) {
        state.incumbent = event.plan;
        state.onEvent({
          ...event,
          ...aggregateParallelProgress(state.shards),
          type: 'incumbent',
          plan: event.plan,
        });
      }
      return;
    }
    if (!isTerminalEvent(event)) return;
    shard.terminal = event;
    if (event.type === 'failed') {
      state.done = true;
      activeMode = null;
      activeGeneration = 0;
      parallelState = null;
      parallel?.forEach((runner, index) => {
        if (index !== shardIndex) runner.cancel();
      });
      state.onEvent(event);
      return;
    }
    if (!state.shards.every((candidate) => candidate.terminal)) return;
    state.done = true;
    activeMode = null;
    activeGeneration = 0;
    parallelState = null;
    state.onEvent(finalizeParallelSearch(state));
  }
}

/** @param {{WorkerClass?: any, BrowserWorkerClass?: any, SharedArrayBufferClass?: any, preferBrowserWorker?: boolean, workerPath?: string}} [options] */
function createSingleSearchRunner(options = {}) {
  const workerPath = options.workerPath || path.join(__dirname, 'optimizer-worker.js');
  const BrowserWorkerClass = options.BrowserWorkerClass || globalThis.Worker;
  const preferBrowserWorker = options.preferBrowserWorker ?? (
    Boolean(BrowserWorkerClass) && process?.versions?.electron &&
    /** @type {any} */ (process).type === 'renderer'
  );
  const WorkerClass = preferBrowserWorker
    ? BrowserWorkerClass
    : options.WorkerClass || NodeWorker;
  const SharedArrayBufferClass = Object.hasOwn(options, 'SharedArrayBufferClass')
    ? options.SharedArrayBufferClass
    : globalThis.SharedArrayBuffer;
  let worker = null;
  let sequence = 0;
  let active = null;
  let disposed = false;
  let pendingTermination = null;

  function ensureWorker() {
    if (worker) return worker;
    const createdWorker = preferBrowserWorker
      ? new WorkerClass(pathToFileURL(workerPath).href)
      : new WorkerClass(workerPath);
    worker = createdWorker;
    addWorkerListener(createdWorker, 'message', (message) => {
      if (createdWorker !== worker || disposed || !active ||
          message?.requestId !== active.requestId) return;
      const current = active;
      const event = current.cancelRequested && message.event?.type === 'completed'
        ? cancelledEvent(current, message.event.result)
        : message.event;
      if (event?.type === 'incumbent') current.incumbent = event.plan;
      if (event?.type === 'progress') current.progress = event;
      if (isTerminalEvent(event)) active = null;
      current.onEvent(event);
    }, preferBrowserWorker);
    addWorkerListener(createdWorker, 'error', (error) => {
      if (createdWorker !== worker) return;
      failActive(error);
      terminateWorker(createdWorker);
    }, preferBrowserWorker);
    if (!preferBrowserWorker) {
      addWorkerListener(createdWorker, 'exit', (code) => {
        if (createdWorker !== worker) return;
        worker = null;
        if (!disposed && active) {
          failActive(new Error(`Search worker exited before completion (code ${code}).`));
        }
      }, false);
    }
    return createdWorker;
  }

  function failActive(error) {
    if (!active || disposed) return;
    const failed = active;
    active = null;
    const normalized = normalizeWorkerError(error);
    failed.onEvent({ type: 'failed', error: normalized });
  }

  return {
    start(options, onEvent) {
      if (disposed) throw new Error('Search runner has been disposed.');
      let waitForTermination = pendingTermination;
      if (active?.cancellationBuffer) {
        cancelSharedSearch(worker, active);
      } else if (active) {
        active = null;
        waitForTermination = terminateWorker(worker) || pendingTermination;
      }
      const requestId = `search-${Date.now()}-${sequence += 1}`;
      const cancellationBuffer = SharedArrayBufferClass
        ? new SharedArrayBufferClass(Int32Array.BYTES_PER_ELEMENT)
        : null;
      active = {
        requestId,
        cancellationBuffer,
        onEvent,
        incumbent: null,
        progress: null,
        cancelRequested: false,
      };
      const message = {
        type: 'start',
        requestId,
        options,
      };
      if (cancellationBuffer) message.cancellationBuffer = cancellationBuffer;
      /** Starts the queued request only if it still owns the active generation. */
      const postStart = () => {
        if (disposed || active?.requestId !== requestId) return;
        try {
          ensureWorker().postMessage(message);
        } catch (error) {
          failActive(error);
        }
      };
      if (waitForTermination) waitForTermination.then(postStart);
      else postStart();
      return requestId;
    },

    cancel() {
      if (!active || disposed) return false;
      if (active.cancellationBuffer) {
        const cancelled = active;
        if (!cancelSharedSearch(worker, cancelled)) {
          active = null;
          cancelled.onEvent(cancelledEvent(cancelled));
        }
      } else {
        const cancelled = active;
        active = null;
        terminateWorker(worker);
        cancelled.onEvent(cancelledEvent(cancelled));
      }
      return true;
    },

    dispose() {
      if (disposed) return;
      if (active?.cancellationBuffer) cancelSharedSearch(worker, active);
      disposed = true;
      active = null;
      terminateWorker(worker);
    },
  };

  function terminateWorker(target) {
    if (!target) return pendingTermination;
    if (target === worker) worker = null;
    const termination = target.terminate();
    if (!termination || typeof termination.then !== 'function') return pendingTermination;
    const previous = pendingTermination;
    const tracked = Promise.all([
      previous || Promise.resolve(),
      Promise.resolve(termination).catch(() => undefined),
    ]).then(() => undefined);
    pendingTermination = tracked;
    tracked.finally(() => {
      if (pendingTermination === tracked) pendingTermination = null;
    });
    return tracked;
  }
}

/** Restricts parallel workers to the exact two-base rank-one combat backend. */
function shouldParallelizeCombat(options, shardCount) {
  return shardCount > 1 &&
    options?.parallelCombatSearch !== false &&
    options?.suffixShardCount == null &&
    options?.optimizationObjective === 'combat' &&
    options?.dispatchMode !== 'separate' &&
    options?.simulation?.dispatchMode !== 'separate' &&
    options?.simulationOptions?.dispatchMode !== 'separate' &&
    !Array.isArray(options?.enemyFleets) &&
    !Array.isArray(options?.targets) &&
    Number(options?.baseCount) === 2 &&
    Number(options?.maxResults) === 1 &&
    (options?.nodeBudget == null || options.nodeBudget === Number.POSITIVE_INFINITY) &&
    (options?.simulationWorkBudget == null ||
      options.simulationWorkBudget === Number.POSITIVE_INFINITY);
}

/** Identifies worker events that close one serial or shard search. */
function isTerminalEvent(event) {
  return ['completed', 'cancelled', 'failed'].includes(event?.type);
}

/** Orders public search phases so slower shards cannot move the UI backwards. */
function phaseRank(phase) {
  return {
    finding_feasible: 1,
    improving: 2,
    proving_optimal: 3,
  }[phase] || 0;
}

/** Sums proof work while retaining the latest solver-specific progress fields. */
function aggregateParallelProgress(shards) {
  const snapshots = shards.map(parallelShardSnapshot).filter(Boolean);
  const latest = snapshots.at(-1) || {};
  const phase = snapshots.reduce((current, snapshot) =>
    phaseRank(snapshot.phase) > phaseRank(current) ? snapshot.phase : current, null);
  /** Sums one numeric counter across all available shard snapshots. */
  const sum = (field) => snapshots.reduce((total, snapshot) =>
    total + (Number(snapshot[field]) || 0), 0);
  /** Selects the greatest observed value for a non-additive shard field. */
  const maximum = (field) => snapshots.reduce((value, snapshot) =>
    Math.max(value, Number(snapshot[field]) || 0), 0);
  const assigned = sum('suffixTransitionGroupsAssigned');
  const assignmentComplete = snapshots.length === shards.length && snapshots.every((snapshot) =>
    snapshot.suffixTransitionAssignmentComplete === true);
  const frontierWorkSharded = snapshots.length > 0 && snapshots.every((snapshot) =>
    Number(snapshot.suffixShardCount) > 1);
  const totalGroups = assignmentComplete ? assigned : null;
  const processed = sum('suffixTransitionGroupsProcessed');
  const allShardsCertified = snapshots.length === shards.length && snapshots.every((snapshot) =>
    snapshot.shardComplete === true);
  const completedWork = totalGroups == null
    ? processed
    : Math.min(processed, Math.max(0, totalGroups - Number(!allShardsCertified)));
  return {
    ...latest,
    type: 'progress',
    phase,
    nodesExplored: sum('nodesExplored'),
    totalNodesExplored: sum('totalNodesExplored'),
    nodesPruned: sum('nodesPruned'),
    candidatesEvaluated: sum('candidatesEvaluated'),
    terminalPlanSimulations: sum('terminalPlanSimulations'),
    terminalPlanSimulationReuses: sum('terminalPlanSimulationReuses'),
    simulationSamplesEvaluated: sum('simulationSamplesEvaluated'),
    suffixTransitionGroups: totalGroups,
    suffixTransitionGroupsAssigned: assigned,
    suffixTransitionAssignmentComplete: assignmentComplete,
    suffixTransitionGroupsProcessed: processed,
    suffixTransitionsEvaluated: sum('suffixTransitionsEvaluated'),
    elapsedMs: maximum('elapsedMs'),
    seedCandidatesEvaluated: sum('seedCandidatesEvaluated'),
    prefixAirSamplesEvaluated: sum('prefixAirSamplesEvaluated'),
    prefixCombatReplays: sum('prefixCombatReplays'),
    prefixTrajectoryCacheHits: sum('prefixTrajectoryCacheHits'),
    firstWaveAirBoundsPruned: sum('firstWaveAirBoundsPruned'),
    continuationFirstWaveAirBoundsPruned: sum('continuationFirstWaveAirBoundsPruned'),
    prefixCandidates: maximum('prefixCandidates'),
    prefixTransitionGroups: maximum('prefixTransitionGroups'),
    prefixStates: maximum('prefixStates'),
    prefixAirStates: maximum('prefixAirStates'),
    minimumSuffixAir: maximum('minimumSuffixAir'),
    suffixCandidates: frontierWorkSharded
      ? sum('suffixCandidates')
      : maximum('suffixCandidates'),
    suffixBucketCeilingsComputed: sum('suffixBucketCeilingsComputed'),
    suffixBucketCeilingCacheHits: sum('suffixBucketCeilingCacheHits'),
    suffixBaseRecordCacheHits: sum('suffixBaseRecordCacheHits'),
    suffixCombatTrajectoryHits: sum('suffixCombatTrajectoryHits'),
    suffixFirstHpCacheHits: sum('suffixFirstHpCacheHits'),
    suffixCombatBatches: sum('suffixCombatBatches'),
    suffixCombatStatesBatched: sum('suffixCombatStatesBatched'),
    suffixHpVectorCacheHits: sum('suffixHpVectorCacheHits'),
    suffixHpVectorsResolved: sum('suffixHpVectorsResolved'),
    suffixTrajectoryCacheHits: sum('suffixTrajectoryCacheHits'),
    suffixTrajectoryStatesReused: sum('suffixTrajectoryStatesReused'),
    frontierAggregateCombatBoundsEvaluated: sum('frontierAggregateCombatBoundsEvaluated'),
    frontierAggregateCombatBoundsPruned: sum('frontierAggregateCombatBoundsPruned'),
    frontierBucketCombatBoundsEvaluated: sum('frontierBucketCombatBoundsEvaluated'),
    frontierBucketCombatBoundsPruned: sum('frontierBucketCombatBoundsPruned'),
    inventoryCompatibilityPrunes: sum('inventoryCompatibilityPrunes'),
    completedWork,
    totalWork: totalGroups,
  };
}

/** Prefers a shard's terminal certificate while retaining fields absent from it. */
function parallelShardSnapshot(shard) {
  const search = shard.terminal?.result?.search;
  const terminalStats = search?.solverStats;
  if (!search && !terminalStats) return shard.progress;
  return {
    ...(shard.progress || {}),
    ...(search || {}),
    ...(terminalStats || {}),
  };
}

/** Merges completed shard results or preserves the best incumbent on cancellation. */
function finalizeParallelSearch(state) {
  const terminals = state.shards.map((shard) => shard.terminal);
  const failure = terminals.find((event) => event.type === 'failed');
  if (failure) return failure;
  const results = terminals.map((event) => event.result).filter(Boolean);
  const plans = results.flatMap((result) => result.results || []);
  const proofMetadata = results[0]?.search || {};
  const best = plans.reduce((incumbent, plan) =>
    !incumbent || compareCombatPlanScores(plan, incumbent) > 0 ? plan : incumbent,
  state.incumbent);
  const progress = aggregateParallelProgress(state.shards);
  const cancelled = terminals.some((event) => event.type === 'cancelled');
  if (cancelled) {
    return {
      type: 'cancelled',
      result: parallelResult(best, progress, false, 'cancelled', proofMetadata),
    };
  }
  const everyShardComplete = results.length === state.shards.length && results.every((result) =>
    result.search?.status === 'shard_complete' && result.search?.solverStats?.shardComplete === true);
  if (!everyShardComplete) {
    return {
      type: 'failed',
      error: {
        name: 'Error',
        message: 'A combat proof shard ended without a completion certificate.',
        stack: '',
      },
    };
  }
  return {
    type: 'completed',
    result: parallelResult(
      best,
      progress,
      true,
      best ? 'optimal' : 'infeasible',
      proofMetadata,
    ),
  };
}

/** Builds the single public result represented by all combat suffix shards. */
function parallelResult(best, progress, provenOptimal, status, proofMetadata = {}) {
  const solverStats = {
    ...progress,
    status,
    shardComplete: provenOptimal,
    suffixShardCount: undefined,
    suffixShardIndex: undefined,
  };
  return {
    messages: status === 'cancelled'
      ? ['Search cancelled; the current best plan is preserved but is not proven optimal.']
      : status === 'infeasible' ? ['No target-feasible combat plan exists.'] : [],
    results: best ? [best] : [],
    search: {
      mode: 'branch-and-bound',
      backend: 'combat-frontier-parallel',
      objective: 'combat',
      status,
      provenOptimal,
      ...(proofMetadata.optimalityScope != null
        ? { optimalityScope: proofMetadata.optimalityScope }
        : {}),
      ...(proofMetadata.evaluationSampleCount != null
        ? { evaluationSampleCount: proofMetadata.evaluationSampleCount }
        : {}),
      ...(proofMetadata.formulaVersion != null
        ? { formulaVersion: proofMetadata.formulaVersion }
        : {}),
      nodesExplored: progress.nodesExplored || 0,
      totalNodesExplored: progress.totalNodesExplored || progress.nodesExplored || 0,
      nodesPruned: progress.nodesPruned || 0,
      candidatesEvaluated: progress.candidatesEvaluated || 0,
      simulationSamplesEvaluated: progress.simulationSamplesEvaluated || 0,
      solverStats,
    },
  };
}

function addWorkerListener(worker, type, callback, browserWorker) {
  if (browserWorker) {
    worker.addEventListener(type, (event) => callback(type === 'message' ? event.data : event));
    return;
  }
  worker.on(type, callback);
}

function normalizeWorkerError(error) {
  const source = error?.error || error || {};
  return {
    name: source.name || 'Error',
    message: source.message || error?.message || 'Search worker failed.',
    stack: source.stack || '',
  };
}

/** Marks shared cancellation and notifies a worker when it has already started. */
function cancelSharedSearch(worker, active) {
  active.cancelRequested = true;
  Atomics.store(new Int32Array(active.cancellationBuffer), 0, 1);
  if (!worker) return false;
  worker.postMessage({ type: 'cancel', requestId: active.requestId });
  return true;
}

/** Builds an honest cancelled terminal while preserving any queued final incumbent. */
function cancelledEvent(active, terminalResult = null) {
  const progress = {
    ...(active.progress || {}),
    ...(terminalResult?.search || {}),
  };
  const results = terminalResult?.results?.length
    ? terminalResult.results
    : active.incumbent ? [active.incumbent] : [];
  return {
    type: 'cancelled',
    result: {
      messages: ['Search cancelled; the current best plan is preserved but is not proven optimal.'],
      results,
      search: {
        ...(terminalResult?.search || {}),
        status: 'cancelled',
        provenOptimal: false,
        nodesExplored: progress.nodesExplored || 0,
        nodesPruned: progress.nodesPruned || 0,
        candidatesEvaluated: progress.candidatesEvaluated || 0,
        simulationSamplesEvaluated: progress.simulationSamplesEvaluated || 0,
      },
    },
  };
}

module.exports = { createSearchRunner };
