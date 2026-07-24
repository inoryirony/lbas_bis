'use strict';

const {
  calculateBaseAirPower,
  calculateSlotAirPower,
  defaultSlotSizeForPlane,
  requiredAirForState,
} = require('./air-power');
const { aircraftEquivalenceKey, capabilitiesFor } = require('./aircraft');
const {
  calculatePlaneTargetAttackPower,
  landBasedReconDamageModifier,
} = require('./damage');
const {
  COMBAT_FORMULA,
  calculateHitAndCriticalProbabilities,
  isLbasCombatAttacker,
} = require('./combat-resolution');
const { maximumCoordinateAssignment } = require('./combat-coordinate-bound');
const { createWorkController } = require('./detailed-exact-solver');
const {
  combatScorePlan,
  compareCombatPlanScores,
  summarizePlan,
} = require('./search-score');
const {
  publishSharedCombatScore,
  readSharedCombatScore,
} = require('./shared-combat-score');
const {
  createBaseContext,
  enumerateBase,
  featureForGroup,
} = require('./static-exact-solver');
const {
  createDetailedScoreContext,
  evaluateDetailedCombatContinuationBatch,
  evaluateDetailedPlanScore,
} = require('./wave-simulator');

const SLOT_KINDS = Object.freeze({
  LOCKED_ITEM: 'LOCKED_ITEM',
  OPEN: 'OPEN',
});
const COMBAT_BOUND_BUCKET_COUNT = 64;
const COMBAT_CONTINUATION_BATCH_SIZE = 32;
const COMBAT_TRAJECTORY_CACHE_LIMIT = 512;
const FRONTIER_PROGRESS_INTERVAL_MS = 250;
const FRONTIER_PROGRESS_CHECK_INTERVAL = 256;
const PREFIX_SAMPLE_SHARD_THRESHOLD = 64;

/** Proves a concentrated two-base combat optimum through reusable enemy continuations. */
function solveCombatFrontier(prepared, solverOptions = {}) {
  const startedAt = Date.now();
  const sampleCount = prepared.simulationOptions.sampleCount;
  const suffixShardCount = Math.max(1, Math.floor(Number(solverOptions.suffixShardCount) || 1));
  const suffixShardIndex = Math.floor(Number(solverOptions.suffixShardIndex) || 0);
  if (suffixShardIndex < 0 || suffixShardIndex >= suffixShardCount) {
    throw new RangeError('suffixShardIndex must select an existing suffix shard.');
  }
  const squareShardWidth = Math.sqrt(suffixShardCount);
  const balancedPrefixShardCount = Number.isInteger(squareShardWidth) ? squareShardWidth : 1;
  const prefixShardCount = sampleCount >= PREFIX_SAMPLE_SHARD_THRESHOLD
    ? suffixShardCount
    : balancedPrefixShardCount;
  const suffixPartitionCount = suffixShardCount / prefixShardCount;
  const prefixShardIndex = Math.floor(suffixShardIndex / suffixPartitionCount);
  const suffixPartitionIndex = suffixShardIndex % suffixPartitionCount;
  const stats = {
    backend: 'combat-frontier',
    status: 'searching',
    nodesExplored: 0,
    nodesPruned: 0,
    candidatesEvaluated: 0,
    terminalPlanSimulations: 0,
    terminalPlanSimulationReuses: 0,
    simulationSamplesEvaluated: 0,
    seedCandidatesEvaluated: 0,
    prefixAirSamplesEvaluated: 0,
    firstWaveAirBoundsPruned: 0,
    continuationFirstWaveAirBoundsPruned: 0,
    prefixCandidates: 0,
    prefixTransitionGroups: 0,
    prefixCombatReplays: 0,
    prefixTrajectoryCacheHits: 0,
    prefixStates: 0,
    prefixAirStates: 0,
    minimumSuffixAir: 0,
    suffixCandidates: 0,
    suffixTransitionGroups: 0,
    suffixTransitionGroupsAssigned: 0,
    suffixTransitionAssignmentComplete: false,
    suffixShardCount,
    suffixShardIndex,
    prefixShardCount,
    prefixShardIndex,
    suffixPartitionCount,
    suffixPartitionIndex,
    suffixEnumerationSharded: suffixPartitionCount > 1,
    shardComplete: false,
    suffixTransitionGroupsProcessed: 0,
    suffixBucketCeilingsComputed: 0,
    suffixBucketCeilingCacheHits: 0,
    suffixTransitionsEvaluated: 0,
    suffixBaseRecordCacheHits: 0,
    suffixCombatTrajectoryHits: 0,
    suffixFirstHpCacheHits: 0,
    suffixCombatBatches: 0,
    suffixCombatStatesBatched: 0,
    suffixHpVectorCacheHits: 0,
    suffixHpVectorsResolved: 0,
    suffixTrajectoryCacheHits: 0,
    suffixTrajectoryStatesReused: 0,
    frontierAggregateCombatBoundsEvaluated: 0,
    frontierAggregateCombatBoundsPruned: 0,
    frontierBucketCombatBoundsEvaluated: 0,
    frontierBucketCombatBoundsPruned: 0,
    inventoryCompatibilityPrunes: 0,
    sharedIncumbentScoreReads: 0,
    elapsedMs: 0,
  };
  let phase = 'finding_feasible';
  let lastProgressAt = Number.NEGATIVE_INFINITY;

  /** Publishes at most four live snapshots per second unless a stage boundary is forced. */
  function emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressAt < FRONTIER_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    solverOptions.onProgress?.(progressSnapshot(stats, startedAt, phase));
  }

  const work = createWorkController(prepared, {
    ...solverOptions,
    onProgress: () => emitProgress(),
  }, stats, startedAt);
  const scoreContext = createDetailedScoreContext({
    baseCount: prepared.baseCount,
    combatContext: prepared.combatContext,
    enemy: prepared.enemy,
    enemyFleets: prepared.enemyFleets,
    targetStates: prepared.waveTargets,
    ...prepared.simulationOptions,
  });
  const staticSummaryContext = { ...prepared, detailed: false };
  const scalarCeilings = createScalarCombatCeilings(prepared, 1);
  let incumbent = null;
  let bestEvaluatedPlan = null;
  let deferredBestLoadouts = null;
  let stopReason = null;
  let nextSimulationProgress = 65536;

  /** Stops atomically before one fixed-sample simulation would exceed its budget. */
  function reserveSimulation() {
    if (!work.checkStop()) return false;
    if (stats.simulationSamplesEvaluated + sampleCount > prepared.simulationBudget) {
      stopReason = 'simulation_budget';
      work.stopped = true;
      work.reason = stopReason;
      return false;
    }
    stats.simulationSamplesEvaluated += sampleCount;
    if (stats.simulationSamplesEvaluated >= nextSimulationProgress) {
      while (nextSimulationProgress <= stats.simulationSamplesEvaluated) {
        nextSimulationProgress += 65536;
      }
      emitProgress();
    }
    return true;
  }

  /** Retains and publishes a target-feasible plan under the complete combat ordering. */
  function considerPlan(plan) {
    if (!plan || plan.allWaveTargetFulfillmentProbability !== 1) return;
    plan.optimizationObjective = 'combat';
    plan.combatScore = combatScorePlan(plan);
    if (incumbent && compareCombatPlanScores(plan, incumbent) <= 0) return;
    const firstIncumbent = incumbent == null;
    incumbent = plan;
    if (!bestEvaluatedPlan || compareCombatPlanScores(plan, bestEvaluatedPlan) > 0) {
      bestEvaluatedPlan = plan;
      deferredBestLoadouts = null;
    }
    publishSharedCombatScore(
      solverOptions.sharedCombatScoreBuffer,
      incumbent.combatScore,
      sampleCount,
    );
    if (firstIncumbent) {
      phase = 'improving';
      solverOptions.onPhaseChange?.(phase);
    }
    solverOptions.onIncumbent?.(incumbent, progressSnapshot(stats, startedAt, phase));
    if (firstIncumbent) {
      phase = 'proving_optimal';
      solverOptions.onPhaseChange?.(phase);
    }
  }

  /** Returns the strongest local or shared primary score that is safe for pruning. */
  function currentPruningScore() {
    const local = bestEvaluatedPlan ? combatScorePlan(bestEvaluatedPlan) : null;
    const shared = readSharedCombatScore(
      solverOptions.sharedCombatScoreBuffer,
      sampleCount,
    );
    if (!shared) return local;
    if (!local || shared.sunk > local.sunk || (
      shared.sunk === local.sunk && shared.hpDamage > local.hpDamage
    )) {
      stats.sharedIncumbentScoreReads += 1;
      return shared;
    }
    return local;
  }

  /** Combines one suffix continuation with every compatible concrete prefix. */
  function considerSuffixContinuation(suffixCandidates, compatiblePrefixes, suffixEvaluation) {
    if (suffixEvaluation.allWaveTargetFulfillmentProbability !== 1) return;
    const pruningScore = currentPruningScore();
    for (const prefix of compatiblePrefixes) {
      if (!combinedHighScoreCanBeat(
        prefix.evaluation,
        suffixEvaluation,
        pruningScore,
      )) continue;
      const combinedEvaluation = combineSegmentCombatEvaluations(
        prefix.evaluation,
        suffixEvaluation,
      );
      for (const prefixCandidate of prefix.candidates) {
        for (const suffixCandidate of suffixCandidates) {
          if (!candidatesAreCompatible(
            prefixCandidate,
            suffixCandidate,
            prepared.groups,
          )) continue;
          stats.candidatesEvaluated += 1;
          const loadouts = materializeLoadouts(
            [prefixCandidate, suffixCandidate],
            prepared,
          );
          const evaluatedPlan = summarizeEvaluatedCombatPlan(
            loadouts,
            staticSummaryContext,
            combinedEvaluation,
          );
          if (bestEvaluatedPlan &&
              compareCombatPlanScores(evaluatedPlan, bestEvaluatedPlan) <= 0) {
            stats.terminalPlanSimulationReuses += 1;
            continue;
          }
          bestEvaluatedPlan = evaluatedPlan;
          deferredBestLoadouts = loadouts;
          publishSharedCombatScore(
            solverOptions.sharedCombatScoreBuffer,
            combatScorePlan(evaluatedPlan),
            sampleCount,
          );
          if (incumbent) {
            stats.terminalPlanSimulationReuses += 1;
            continue;
          }
          if (!reserveSimulation()) return;
          const plan = summarizePlan(loadouts, prepared);
          stats.terminalPlanSimulations += 1;
          considerPlan(plan);
        }
      }
    }
  }

  solverOptions.onPhaseChange?.('finding_feasible');
  emitProgress(true);
  for (const seedLoadouts of solverOptions.seedLoadouts || []) {
    if (!reserveSimulation()) break;
    stats.seedCandidatesEvaluated += 1;
    considerPlan(summarizePlan(seedLoadouts, prepared));
  }
  if (!work.checkStop()) return stoppedResult(incumbent, stats, startedAt, work.reason);

  const features = prepared.groups.map((group, groupIndex) =>
    featureForGroup(group, groupIndex, prepared.inventoryCounts, prepared.combatContext));
  const transitionShardKeys = [...new Set(prepared.groups.map((group) =>
    fixedSamplePlaneTransitionKey(group.representative)))].sort();
  const transitionShardIndexByKey = new Map(transitionShardKeys.map((key, index) => [key, index]));
  features.forEach((feature) => {
    feature.transitionShardIndex = transitionShardIndexByKey.get(fixedSamplePlaneTransitionKey(
      prepared.groups[feature.groupIndex].representative,
    ));
  });
  const prefixContext = createBaseContext(
    prepared,
    prepared.baseLocks[0],
    0,
    features,
  );
  const suffixContext = createBaseContext(
    prepared,
    prepared.baseLocks[1],
    1,
    features,
  );
  suffixContext.requiredAir = 0;
  suffixContext.targetState = 'none';

  const prefixEnumeration = enumerateBase(prefixContext, work, {
    candidateShardForFeature: (feature) => feature.transitionShardIndex,
    candidateShardCount: prefixShardCount,
    candidateShardIndex: prefixShardIndex,
    minimumDamage: Number.NEGATIVE_INFINITY,
  });
  stats.prefixCandidates = prefixEnumeration.candidateCount;
  stats.firstWaveAirBoundsPruned = prefixEnumeration.airBoundPrunes;
  emitProgress(true);
  if (!work.checkStop()) return stoppedResult(incumbent, stats, startedAt, work.reason);
  const prefixTransitions = groupCandidatesByTransition(
    prefixEnumeration.candidates,
    0,
    prepared,
    emitProgress,
  );
  stats.prefixTransitionGroups = prefixTransitions.length;
  emitProgress(true);
  const reusePrefixCombatTrajectories = sampleCount >= PREFIX_SAMPLE_SHARD_THRESHOLD;
  if (reusePrefixCombatTrajectories) {
    prefixTransitions.forEach((transition, transitionIndex) => {
      transition.combatProfileKey = combatProfileKey(transition.loadout);
      if ((transitionIndex & 4095) === 4095) emitProgress();
    });
  }
  const orderedPrefixTransitions = reusePrefixCombatTrajectories
    ? orderSuffixTransitionsForProof(prefixTransitions, emitProgress)
    : prefixTransitions;
  const stateBuckets = new Map();
  const states = [];
  const prefixTrajectoryCacheHolder = {};
  let activePrefixCombatProfileKey = null;

  /** Retains one exact prefix continuation and every inventory-distinct source candidate. */
  function retainPrefixTransition(transition, evaluation, finalEnemyHitPointsFlatByFleet) {
    const state = findOrCreateState(
      stateBuckets,
      states,
      evaluation.finalEnemySlotsFlatByFleet,
      finalEnemyHitPointsFlatByFleet,
      evaluation.finalContactStatesFlatByFleet,
      evaluation.maximumFinalEnemyAir,
      prepared,
    );
    state.prefixes.push({
      ...transition,
      evaluation: compactCombatEvaluation(evaluation),
    });
  }

  for (const transition of orderedPrefixTransitions) {
    if (!reserveSimulation()) break;
    if (!reusePrefixCombatTrajectories) {
      const evaluation = evaluateDetailedPlanScore({
        bases: [transition.loadout],
        baseCacheKeys: [transition.key],
        cacheBaseRecords: false,
        baseIndexOffset: 0,
        captureFinalContinuationsFlat: true,
        includeCombat: true,
        enemy: prepared.enemy,
        enemyFleets: prepared.enemyFleets,
        targetStates: prepared.waveTargets,
        combatContext: prepared.combatContext,
        scoreContext,
        ...prepared.simulationOptions,
      });
      stats.prefixAirSamplesEvaluated += sampleCount;
      if ((stats.prefixAirSamplesEvaluated / sampleCount) %
          FRONTIER_PROGRESS_CHECK_INTERVAL === 0) emitProgress();
      if (evaluation.allWaveTargetFulfillmentProbability === 1) {
        retainPrefixTransition(
          transition,
          evaluation,
          evaluation.finalEnemyHitPointsFlatByFleet,
        );
      }
      continue;
    }
    if (transition.combatProfileKey !== activePrefixCombatProfileKey) {
      activePrefixCombatProfileKey = transition.combatProfileKey;
      prefixTrajectoryCacheHolder.combatTrajectoryCache = null;
    }
    try {
      const airEvaluation = evaluateDetailedPlanScore({
        bases: [transition.loadout],
        baseCacheKeys: [transition.key],
        cacheBaseRecords: true,
        baseIndexOffset: 0,
        captureFinalContinuationsFlat: true,
        captureCombatTrajectory: true,
        disableConcentratedSegmentReuse: true,
        includeCombat: false,
        enemy: prepared.enemy,
        enemyFleets: prepared.enemyFleets,
        targetStates: prepared.waveTargets,
        combatContext: prepared.combatContext,
        scoreContext,
        ...prepared.simulationOptions,
      });
      stats.prefixAirSamplesEvaluated += sampleCount;
      if ((stats.prefixAirSamplesEvaluated / sampleCount) %
          FRONTIER_PROGRESS_CHECK_INTERVAL === 0) emitProgress();
      if (airEvaluation.allWaveTargetFulfillmentProbability !== 1) continue;
      const trajectoryLookup = findOrCreateCombatTrajectoryEntry(
        prefixTrajectoryCacheHolder,
        transition.loadout,
        airEvaluation.combatTrajectory,
      );
      let hpEvaluation = trajectoryLookup.entry.prefixHpEvaluation;
      let finalEnemyHitPointsFlatByFleet =
        trajectoryLookup.entry.prefixFinalEnemyHitPointsFlatByFleet;
      if (trajectoryLookup.hit && hpEvaluation && finalEnemyHitPointsFlatByFleet) {
        stats.prefixTrajectoryCacheHits += 1;
      } else {
        const replayed = evaluateDetailedPlanScore({
          bases: [transition.loadout],
          baseCacheKeys: [transition.key],
          cacheBaseRecords: true,
          baseIndexOffset: 0,
          captureFinalContinuationsFlat: true,
          includeCombat: true,
          combatTrajectory: airEvaluation.combatTrajectory,
          enemy: prepared.enemy,
          enemyFleets: prepared.enemyFleets,
          targetStates: prepared.waveTargets,
          combatContext: prepared.combatContext,
          scoreContext,
          ...prepared.simulationOptions,
        });
        stats.prefixCombatReplays += 1;
        hpEvaluation = compactHpEvaluation(replayed);
        finalEnemyHitPointsFlatByFleet = replayed.finalEnemyHitPointsFlatByFleet;
        trajectoryLookup.entry.prefixHpEvaluation = hpEvaluation;
        trajectoryLookup.entry.prefixFinalEnemyHitPointsFlatByFleet =
          finalEnemyHitPointsFlatByFleet;
      }
      const evaluation = combineAirAndHpEvaluation(airEvaluation, hpEvaluation);
      retainPrefixTransition(transition, evaluation, finalEnemyHitPointsFlatByFleet);
    } finally {
      scoreContext.baseCache.delete(`0:${transition.key}`);
    }
  }
  stats.prefixStates = states.length;
  const slotStateGroups = groupContinuationStatesBySlots(states);
  stats.prefixAirStates = slotStateGroups.length;
  if (!work.checkStop()) return stoppedResult(incumbent, stats, startedAt, work.reason);
  suffixContext.requiredAir = states.length > 0
    ? Math.min(...states.map((state) => state.requiredAir))
    : Number.POSITIVE_INFINITY;
  stats.minimumSuffixAir = suffixContext.requiredAir;
  const suffixEnumeration = enumerateBase(suffixContext, work, {
    candidateShardForFeature: (feature) => feature.transitionShardIndex,
    candidateShardCount: suffixPartitionCount,
    candidateShardIndex: suffixPartitionIndex,
    minimumDamage: Number.NEGATIVE_INFINITY,
  });
  stats.suffixCandidates = suffixEnumeration.candidateCount;
  emitProgress(true);
  if (!work.checkStop()) return stoppedResult(incumbent, stats, startedAt, work.reason);
  const suffixTransitions = groupCandidatesByTransition(
    suffixEnumeration.candidates,
    1,
    prepared,
    emitProgress,
  );
  stats.suffixTransitionGroups = suffixTransitions.length;
  emitProgress(true);
  suffixTransitions.forEach((transition, transitionIndex) => {
    transition.combatProfileKey = combatProfileKey(transition.loadout);
    if ((transitionIndex & 4095) === 4095) emitProgress();
  });
  const orderedSuffixTransitions = orderSuffixTransitionsForProof(suffixTransitions, emitProgress);
  const assignedSuffixTransitions = orderedSuffixTransitions;
  const suffixBucketCeilingCache = new Map();
  stats.suffixTransitionGroupsAssigned = assignedSuffixTransitions.length;
  stats.suffixTransitionAssignmentComplete = true;
  emitProgress(true);

  /** Evaluates one exact transition for every inventory-distinct suffix it represents. */
  function processSuffixTransition(suffixTransition) {
      if (!work.checkStop()) return;
      const suffixCandidates = suffixTransition.candidates;
      const suffixCandidate = suffixCandidates[0];
      const suffixLoadout = suffixTransition.loadout;
      const suffixKey = suffixTransition.key;
      let coordinateBucketCeiling = suffixBucketCeilingCache.get(
        suffixTransition.combatProfileKey,
      );
      if (coordinateBucketCeiling) {
        stats.suffixBucketCeilingCacheHits += 1;
      } else {
        coordinateBucketCeiling = coordinateBucketCeilingForLoadout(
          suffixLoadout,
          prepared,
          1,
        );
        suffixBucketCeilingCache.set(
          suffixTransition.combatProfileKey,
          coordinateBucketCeiling,
        );
        stats.suffixBucketCeilingsComputed += 1;
      }
      const suffixCeiling = scalarCeilingForCandidate(
        suffixCandidate,
        scalarCeilings,
        suffixLoadout,
        prepared,
        1,
        coordinateBucketCeiling,
      );
      let suffixRecordPrepared = false;
      try {
        for (const slotStateGroup of slotStateGroups) {
          let combatTrajectory = null;
          const pendingStates = [];
          for (const state of slotStateGroup.states) {
            if (!work.checkStop()) return;
            if (suffixCandidate.air < state.requiredAir) {
              stats.continuationFirstWaveAirBoundsPruned += 1;
              continue;
            }
            const pruningScore = currentPruningScore();
            stats.frontierAggregateCombatBoundsEvaluated += 1;
            if (!frontierAggregateCanBeat(
              state.prefixes[0].evaluation,
              state,
              suffixCeiling,
              pruningScore,
              sampleCount,
            )) {
              stats.frontierAggregateCombatBoundsPruned += state.prefixes.length;
              continue;
            }
            stats.frontierBucketCombatBoundsEvaluated += 1;
            if (!frontierBucketCanBeat(
              state,
              suffixCeiling,
              pruningScore,
              sampleCount,
            )) {
              stats.frontierBucketCombatBoundsPruned += state.prefixes.length;
              continue;
            }
            const compatiblePrefixes = state.prefixes.filter((prefix) =>
              prefix.candidates.some((prefixCandidate) =>
                suffixCandidates.some((candidate) => candidatesAreCompatible(
                  prefixCandidate,
                  candidate,
                  prepared.groups,
                ))));
            if (compatiblePrefixes.length === 0) {
              stats.inventoryCompatibilityPrunes += 1;
              continue;
            }
            const cached = state.suffixEvaluations.get(suffixKey);
            if (cached) {
              considerSuffixContinuation(suffixCandidates, compatiblePrefixes, cached);
            } else {
              pendingStates.push({ state, compatiblePrefixes });
            }
          }
          if (!work.checkStop() || pendingStates.length === 0) continue;

          const first = pendingStates.shift();
          if (!reserveSimulation()) return;
          if (suffixRecordPrepared) stats.suffixBaseRecordCacheHits += 1;
          const firstAirEvaluated = evaluateDetailedPlanScore({
            bases: [suffixLoadout],
            baseCacheKeys: [suffixKey],
            cacheBaseRecords: true,
            baseIndexOffset: 1,
            initialEnemySlotsFlatByFleet: slotStateGroup.enemySlotsFlatByFleet,
            initialContactStatesFlatByFleet: slotStateGroup.contactStatesFlatByFleet,
            includeCombat: false,
            captureCombatTrajectory: true,
            disableConcentratedSegmentReuse: true,
            enemy: prepared.enemy,
            enemyFleets: prepared.enemyFleets,
            targetStates: prepared.waveTargets,
            combatContext: prepared.combatContext,
            scoreContext,
            ...prepared.simulationOptions,
          });
          suffixRecordPrepared = true;
          if (firstAirEvaluated.allWaveTargetFulfillmentProbability !== 1) {
            const infeasibleEvaluation = compactCombatEvaluation({
              ...firstAirEvaluated,
              expectedSunkCount: 0,
              expectedHpDamage: 0,
            });
            first.state.suffixEvaluations.set(suffixKey, infeasibleEvaluation);
            pendingStates.forEach(({ state }) => {
              state.suffixEvaluations.set(suffixKey, infeasibleEvaluation);
            });
            continue;
          }
          combatTrajectory = firstAirEvaluated.combatTrajectory;
          const trajectoryLookup = findOrCreateCombatTrajectoryEntry(
            slotStateGroup,
            suffixLoadout,
            combatTrajectory,
          );
          if (trajectoryLookup.hit) stats.suffixTrajectoryCacheHits += 1;
          const trajectoryEntry = trajectoryLookup.entry;
          let firstHpEvaluation = trajectoryEntry.hpByState.get(first.state.id);
          if (firstHpEvaluation) {
            stats.suffixFirstHpCacheHits += 1;
            stats.suffixCombatTrajectoryHits += 1;
          } else {
            stats.suffixBaseRecordCacheHits += 1;
            const firstReplayed = evaluateDetailedPlanScore({
              bases: [suffixLoadout],
              baseCacheKeys: [suffixKey],
              cacheBaseRecords: true,
              baseIndexOffset: 1,
              initialEnemyHitPointsFlatByFleet: first.state.enemyHitPointsFlatByFleet,
              includeCombat: true,
              combatTrajectory,
              enemy: prepared.enemy,
              enemyFleets: prepared.enemyFleets,
              targetStates: prepared.waveTargets,
              combatContext: prepared.combatContext,
              scoreContext,
              ...prepared.simulationOptions,
            });
            firstHpEvaluation = compactHpEvaluation(firstReplayed);
            trajectoryEntry.hpByState.set(first.state.id, firstHpEvaluation);
            stats.suffixTransitionsEvaluated += 1;
          }
          const firstEvaluation = compactCombatEvaluation(combineAirAndHpEvaluation(
            firstAirEvaluated,
            firstHpEvaluation,
          ));
          first.state.suffixEvaluations.set(suffixKey, firstEvaluation);
          considerSuffixContinuation(
            suffixCandidates,
            first.compatiblePrefixes,
            firstEvaluation,
          );

          const unresolvedStates = [];
          for (const pending of pendingStates) {
            const cachedHp = trajectoryEntry.hpByState.get(pending.state.id);
            if (!cachedHp) {
              unresolvedStates.push(pending);
              continue;
            }
            const evaluation = combineAirAndHpEvaluation(firstAirEvaluated, cachedHp);
            pending.state.suffixEvaluations.set(suffixKey, evaluation);
            stats.suffixTrajectoryStatesReused += 1;
            considerSuffixContinuation(
              suffixCandidates,
              pending.compatiblePrefixes,
              evaluation,
            );
          }
          pendingStates.length = 0;
          pendingStates.push(...unresolvedStates);

          while (pendingStates.length > 0 && work.checkStop()) {
            const batch = [];
            while (batch.length < COMBAT_CONTINUATION_BATCH_SIZE &&
                pendingStates.length > 0 && reserveSimulation()) {
              batch.push(pendingStates.shift());
            }
            if (batch.length === 0) return;
            stats.suffixBaseRecordCacheHits += batch.length;
            const batchDiagnostics = {};
            const batchEvaluations = evaluateDetailedCombatContinuationBatch({
              bases: [suffixLoadout],
              baseCacheKeys: [suffixKey],
              cacheBaseRecords: true,
              baseIndexOffset: 1,
              initialEnemyHitPointStatesFlatByFleet: batch.map(({ state }) =>
                state.enemyHitPointsFlatByFleet),
              includeCombat: true,
              combatTrajectory,
              diagnostics: batchDiagnostics,
              enemy: prepared.enemy,
              enemyFleets: prepared.enemyFleets,
              targetStates: prepared.waveTargets,
              combatContext: prepared.combatContext,
              scoreContext,
              ...prepared.simulationOptions,
            });
            stats.suffixCombatBatches += 1;
            stats.suffixCombatStatesBatched += batch.length;
            stats.suffixHpVectorCacheHits += batchDiagnostics.hpVectorCacheHits || 0;
            stats.suffixHpVectorsResolved += batchDiagnostics.hpVectorsResolved || 0;
            stats.suffixCombatTrajectoryHits += batch.length;
            stats.suffixTransitionsEvaluated += batch.length;
            batch.forEach(({ state, compatiblePrefixes }, batchIndex) => {
              const evaluation = compactCombatEvaluation(batchEvaluations[batchIndex]);
              trajectoryEntry.hpByState.set(state.id, compactHpEvaluation(evaluation));
              state.suffixEvaluations.set(suffixKey, evaluation);
              considerSuffixContinuation(suffixCandidates, compatiblePrefixes, evaluation);
            });
          }
        }
      } finally {
        scoreContext.baseCache.delete(`1:${suffixKey}`);
      }
      stats.suffixTransitionGroupsProcessed += 1;
      if ((stats.suffixTransitionGroupsProcessed &
          (FRONTIER_PROGRESS_CHECK_INTERVAL - 1)) === 0) emitProgress();
  }
  let activeCombatProfileKey = null;
  for (const suffixTransition of assignedSuffixTransitions) {
    if (suffixTransition.combatProfileKey !== activeCombatProfileKey) {
      activeCombatProfileKey = suffixTransition.combatProfileKey;
      slotStateGroups.forEach((group) => {
        group.combatTrajectoryCache = null;
      });
    }
    processSuffixTransition(suffixTransition);
    if (!work.checkStop()) break;
  }

  if (!work.checkStop()) return stoppedResult(incumbent, stats, startedAt, work.reason);
  if (deferredBestLoadouts &&
      (!incumbent || compareCombatPlanScores(bestEvaluatedPlan, incumbent) > 0)) {
    if (!reserveSimulation()) return stoppedResult(incumbent, stats, startedAt, work.reason);
    stats.terminalPlanSimulationReuses -= 1;
    const plan = summarizePlan(deferredBestLoadouts, prepared);
    stats.terminalPlanSimulations += 1;
    considerPlan(plan);
  }
  if (!work.checkStop()) return stoppedResult(incumbent, stats, startedAt, work.reason);
  stats.shardComplete = suffixShardCount > 1;
  stats.status = suffixShardCount > 1
    ? 'shard_complete'
    : incumbent ? 'optimal' : 'infeasible';
  stats.elapsedMs = Date.now() - startedAt;
  emitProgress(true);
  return {
    plans: incumbent ? [incumbent] : [],
    provenOptimal: suffixShardCount === 1,
    formulaVersion: COMBAT_FORMULA.formulaVersion,
    solverStats: stats,
  };
}

/** Groups inventory-distinct candidates while reporting long synchronous grouping work. */
function groupCandidatesByTransition(candidates, baseIndex, prepared, onProgress = null) {
  const byKey = new Map();
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    const loadout = materializeSingleBase(candidate, baseIndex, prepared);
    const key = combatTransitionKey(loadout, candidateKey(candidate));
    const group = byKey.get(key) || { key, loadout, candidates: [] };
    group.candidates.push(candidate);
    byKey.set(key, group);
    if ((candidateIndex & 4095) === 4095) onProgress?.();
  }
  return [...byKey.values()];
}

/** Canonicalizes every non-jet input that can affect enemy air or HP continuation. */
function combatTransitionKey(loadout, uniqueJetKey) {
  const entries = loadout.map((plane, slotIndex) => plane ? {
    key: aircraftEquivalenceKey(plane),
    plane,
    slotIndex,
    transitionKey: fixedSamplePlaneTransitionKey(plane),
  } : null).filter(Boolean).sort((left, right) =>
    left.key.localeCompare(right.key) || left.slotIndex - right.slotIndex);
  if (entries.some(({ plane }) => capabilitiesFor(plane).isJet === true)) {
    return `jet:${uniqueJetKey}`;
  }
  return JSON.stringify([
    calculateBaseAirPower(loadout),
    landBasedReconDamageModifier(loadout.filter(Boolean)),
    entries.map(({ transitionKey }) => transitionKey),
  ]);
}

/** Collapses identity-only fighter differences while retaining every fixed-sample loss curve. */
function fixedSamplePlaneTransitionKey(plane) {
  const capabilities = capabilitiesFor(plane);
  if (isLbasCombatAttacker(plane) ||
      plane.canContact === true || capabilities.canContact === true) {
    return `exact:${aircraftEquivalenceKey(plane)}`;
  }
  const maximumSlot = Math.max(0, Math.floor(Number(
    plane.currentSlot ?? plane.slotSize ?? defaultSlotSizeForPlane(plane),
  ) || 0));
  const isAttacker = plane.isAttacker === true || capabilities.isAttacker === true;
  const isAswPatrol = plane.isAswPatrol === true || capabilities.isAswPatrol === true;
  const isStageTwoTarget = isAttacker ||
    plane.isAswBomber2 === true || capabilities.isAswBomber2 === true;
  return `air:${JSON.stringify([
    maximumSlot,
    isAswPatrol && !isAttacker ? 0.91 : 1,
    isStageTwoTarget,
    Number(plane.shootDownAvoidance) || 0,
    Array.from({ length: maximumSlot + 1 }, (_unused, currentSlot) =>
      calculateSlotAirPower({ ...plane, currentSlot })),
  ])}`;
}

/** Canonicalizes only the attacker formulas and order that affect HP combat. */
function combatProfileKey(loadout) {
  const attackers = loadout.map((plane, slotIndex) => plane ? {
    key: aircraftEquivalenceKey(plane),
    plane,
    slotIndex,
  } : null).filter((entry) =>
    entry && isLbasCombatAttacker(entry.plane))
    .sort((left, right) => left.key.localeCompare(right.key) || left.slotIndex - right.slotIndex);
  return JSON.stringify([
    landBasedReconDamageModifier(loadout.filter(Boolean)),
    attackers.map(({ key }) => key),
  ]);
}

/** Keeps equal combat profiles adjacent while reporting long synchronous ordering work. */
function orderSuffixTransitionsForProof(transitions, onProgress = null) {
  const profiles = new Map();
  for (let transitionIndex = 0; transitionIndex < transitions.length; transitionIndex += 1) {
    const transition = transitions[transitionIndex];
    const profileKey = transition.combatProfileKey;
    const priority = Math.max(
      Number.NEGATIVE_INFINITY,
      ...transition.candidates.map((candidate) => Number(candidate.damage) || 0),
    );
    const profile = profiles.get(profileKey) || {
      key: profileKey,
      priority: Number.NEGATIVE_INFINITY,
      transitions: [],
    };
    profile.priority = Math.max(profile.priority, priority);
    profile.transitions.push({ transition, priority });
    profiles.set(profileKey, profile);
    if ((transitionIndex & 4095) === 4095) onProgress?.();
  }
  return [...profiles.values()]
    .sort((left, right) =>
      (right.priority - left.priority) || left.key.localeCompare(right.key))
    .flatMap((profile) => profile.transitions
      .sort((left, right) =>
        (right.priority - left.priority) || left.transition.key.localeCompare(right.transition.key))
      .map(({ transition }) => transition));
}

/** Finds an exact attacker-slot trajectory or retains a bounded new cache entry. */
function findOrCreateCombatTrajectoryEntry(slotStateGroup, loadout, trajectory) {
  const signature = combatTrajectorySignature(loadout, trajectory);
  const cache = slotStateGroup.combatTrajectoryCache || {
    byKey: new Map(),
    size: 0,
  };
  slotStateGroup.combatTrajectoryCache = cache;
  const bucket = cache.byKey.get(signature.key) || [];
  const matched = bucket.find((entry) =>
    combatTrajectoryMatches(entry.attackerSlots, signature.attackerIndices, trajectory));
  if (matched) return { entry: matched, hit: true };
  const entry = {
    attackerSlots: captureAttackerTrajectory(signature.attackerIndices, trajectory),
    hpByState: new Map(),
  };
  if (cache.size < COMBAT_TRAJECTORY_CACHE_LIMIT) {
    bucket.push(entry);
    cache.byKey.set(signature.key, bucket);
    cache.size += 1;
  }
  return { entry, hit: false };
}

/** Hashes exact per-sample attacker slots while retaining indices for collision checks. */
function combatTrajectorySignature(loadout, trajectory) {
  const attackerIndices = loadout.map((plane, slotIndex) => plane ? {
    key: aircraftEquivalenceKey(plane),
    plane,
    slotIndex,
  } : null).filter((entry) =>
    entry && isLbasCombatAttacker(entry.plane))
    .sort((left, right) => left.key.localeCompare(right.key) || left.slotIndex - right.slotIndex)
    .map(({ slotIndex }) => slotIndex);
  let first = 2166136261 >>> 0;
  let second = 2246822519 >>> 0;
  for (let baseIndex = 0; baseIndex < trajectory.attackSlots.length; baseIndex += 1) {
    const base = trajectory.attackSlots[baseIndex];
    const compactIndices = attackerIndices.map((slotIndex) =>
      trajectory.attackerIndices[baseIndex].indexOf(slotIndex));
    for (const wave of base) {
      for (let sample = 0; sample < trajectory.sampleCount; sample += 1) {
        const offset = sample * wave.width;
        for (const compactIndex of compactIndices) {
          const value = Number(wave.values[offset + compactIndex]) >>> 0;
          first = Math.imul(first ^ value, 16777619) >>> 0;
          second = Math.imul(second ^ value, 3266489917) >>> 0;
        }
      }
    }
  }
  for (const base of trajectory.contactMultiplierIndices) {
    for (const wave of base) {
      for (const value of wave) {
        first = Math.imul(first ^ value, 16777619) >>> 0;
        second = Math.imul(second ^ value, 3266489917) >>> 0;
      }
    }
  }
  return {
    attackerIndices,
    key: `${combatProfileKey(loadout)}:${first.toString(16)}:${second.toString(16)}`,
  };
}

/** Copies only attacker slots from a full player-loss trajectory. */
function captureAttackerTrajectory(attackerIndices, trajectory) {
  const values = new Uint16Array(
    trajectory.attackSlots.length * 2 * trajectory.sampleCount *
      (attackerIndices.length + 1),
  );
  let cursor = 0;
  for (let baseIndex = 0; baseIndex < trajectory.attackSlots.length; baseIndex += 1) {
    const base = trajectory.attackSlots[baseIndex];
    const compactIndices = attackerIndices.map((slotIndex) =>
      trajectory.attackerIndices[baseIndex].indexOf(slotIndex));
    for (const wave of base) {
      for (let sample = 0; sample < trajectory.sampleCount; sample += 1) {
        const offset = sample * wave.width;
        for (const compactIndex of compactIndices) {
          values[cursor] = wave.values[offset + compactIndex];
          cursor += 1;
        }
      }
    }
  }
  for (const base of trajectory.contactMultiplierIndices) {
    for (const wave of base) {
      for (const value of wave) {
        values[cursor] = value;
        cursor += 1;
      }
    }
  }
  return values;
}

/** Verifies a hashed attacker trajectory without trusting hash uniqueness. */
function combatTrajectoryMatches(cached, attackerIndices, trajectory) {
  const expectedLength = trajectory.attackSlots.length * 2 *
    trajectory.sampleCount * (attackerIndices.length + 1);
  if (cached.length !== expectedLength) return false;
  let cursor = 0;
  for (let baseIndex = 0; baseIndex < trajectory.attackSlots.length; baseIndex += 1) {
    const base = trajectory.attackSlots[baseIndex];
    const compactIndices = attackerIndices.map((slotIndex) =>
      trajectory.attackerIndices[baseIndex].indexOf(slotIndex));
    for (const wave of base) {
      for (let sample = 0; sample < trajectory.sampleCount; sample += 1) {
        const offset = sample * wave.width;
        for (const compactIndex of compactIndices) {
          if (cached[cursor] !== wave.values[offset + compactIndex]) return false;
          cursor += 1;
        }
      }
    }
  }
  for (const base of trajectory.contactMultiplierIndices) {
    for (const wave of base) {
      for (const value of wave) {
        if (cached[cursor] !== value) return false;
        cursor += 1;
      }
    }
  }
  return true;
}

/** Retains only HP fields that are invariant across equal combat trajectories. */
function compactHpEvaluation(evaluation) {
  return {
    expectedSunkCount: evaluation.expectedSunkCount,
    expectedHpDamage: evaluation.expectedHpDamage,
  };
}

/** Combines current air/proxy fields with exact HP results from an equal trajectory. */
function combineAirAndHpEvaluation(airEvaluation, hpEvaluation) {
  return {
    ...airEvaluation,
    ...hpEvaluation,
  };
}

/** Returns a stable grouped-count key without materializing inventory instance IDs. */
function candidateKey(candidate) {
  return candidate.pairs.map(([groupIndex, count]) => `${groupIndex}:${count}`).join(',');
}

/** Finds an exact state bucket and verifies hash collisions before reusing it. */
function findOrCreateState(
  buckets,
  states,
  enemySlotsFlatByFleet,
  enemyHitPointsFlatByFleet,
  contactStatesFlatByFleet,
  maximumFinalEnemyAir,
  prepared,
) {
  const hash = flatContinuationHash([
    ...enemySlotsFlatByFleet,
    ...enemyHitPointsFlatByFleet,
    ...contactStatesFlatByFleet,
  ]);
  const bucket = buckets.get(hash) || [];
  let state = bucket.find((candidate) =>
    flatContinuationStatesEqual(candidate.enemySlotsFlatByFleet, enemySlotsFlatByFleet) &&
    flatContinuationStatesEqual(
      candidate.enemyHitPointsFlatByFleet,
      enemyHitPointsFlatByFleet,
    ) &&
    flatContinuationStatesEqual(candidate.contactStatesFlatByFleet, contactStatesFlatByFleet));
  if (state) return state;
  state = {
    id: states.length,
    enemySlotsFlatByFleet,
    enemyHitPointsFlatByFleet,
    contactStatesFlatByFleet,
    requiredAir: requiredAirForState(
      maximumFinalEnemyAir[0] || 0,
      prepared.waveTargets[2],
    ),
    prefixes: [],
    suffixEvaluations: new Map(),
  };
  const remainingHitPoints = positiveHitPointsFromFlat(
    enemyHitPointsFlatByFleet,
    0,
    prepared.simulationOptions.sampleCount,
  ).sort((left, right) => left - right);
  state.remainingHpTotal = remainingHitPoints.reduce((total, hitPoints) =>
    total + hitPoints, 0);
  state.cumulativeRemainingHitPoints = new Float64Array(remainingHitPoints.length);
  remainingHitPoints.reduce((total, hitPoints, index) => {
    const cumulative = total + hitPoints;
    state.cumulativeRemainingHitPoints[index] = cumulative;
    return cumulative;
  }, 0);
  state.combatBuckets = createStateCombatBuckets(enemyHitPointsFlatByFleet, prepared);
  bucket.push(state);
  buckets.set(hash, bucket);
  states.push(state);
  return state;
}

/** Groups exact combat continuations that share the same enemy aircraft slots. */
function groupContinuationStatesBySlots(states) {
  const buckets = new Map();
  const groups = [];
  for (const state of states) {
    const hash = flatContinuationHash([
      ...state.enemySlotsFlatByFleet,
      ...state.contactStatesFlatByFleet,
    ]);
    const bucket = buckets.get(hash) || [];
    let group = bucket.find((candidate) =>
      flatContinuationStatesEqual(candidate.enemySlotsFlatByFleet, state.enemySlotsFlatByFleet) &&
      flatContinuationStatesEqual(
        candidate.contactStatesFlatByFleet,
        state.contactStatesFlatByFleet,
      ));
    if (!group) {
      group = {
        enemySlotsFlatByFleet: state.enemySlotsFlatByFleet,
        contactStatesFlatByFleet: state.contactStatesFlatByFleet,
        states: [],
      };
      bucket.push(group);
      buckets.set(hash, bucket);
      groups.push(group);
    }
    group.states.push(state);
  }
  return groups;
}

/** Hashes one flat typed continuation without materializing a large string. */
function flatContinuationHash(flatByFleet) {
  let first = 2166136261 >>> 0;
  let second = 2246822519 >>> 0;
  for (const flat of flatByFleet) {
    for (const value of flat.values) {
      const integer = Math.round(Number(value) * 1024) >>> 0;
      first = Math.imul(first ^ integer, 16777619) >>> 0;
      second = Math.imul(second ^ integer, 3266489917) >>> 0;
    }
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** Verifies two flat typed continuations after their hashes match. */
function flatContinuationStatesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let fleetIndex = 0; fleetIndex < left.length; fleetIndex += 1) {
    const leftFleet = left[fleetIndex];
    const rightFleet = right[fleetIndex];
    if (leftFleet.width !== rightFleet.width ||
        leftFleet.values.length !== rightFleet.values.length) return false;
    for (let index = 0; index < leftFleet.values.length; index += 1) {
      if (leftFleet.values[index] !== rightFleet.values[index]) return false;
    }
  }
  return true;
}

/** Drops captured state vectors before retaining one prefix's additive score fields. */
function compactCombatEvaluation(evaluation) {
  return {
    allWaveTargetFulfillmentProbability: evaluation.allWaveTargetFulfillmentProbability,
    expectedSunkCount: evaluation.expectedSunkCount,
    expectedHpDamage: evaluation.expectedHpDamage,
    expectedDamage: evaluation.expectedDamage,
    expectedOwnSlotLoss: evaluation.expectedOwnSlotLoss,
    expectedResourceCost: evaluation.expectedResourceCost,
    worstMargin: evaluation.worstMargin,
  };
}

/** Combines exact additive segment scores without replaying the complete four-wave plan. */
function combineSegmentCombatEvaluations(prefix, suffix) {
  return {
    allWaveTargetFulfillmentProbability: Math.min(
      prefix.allWaveTargetFulfillmentProbability,
      suffix.allWaveTargetFulfillmentProbability,
    ),
    expectedSunkCount: prefix.expectedSunkCount + suffix.expectedSunkCount,
    expectedHpDamage: prefix.expectedHpDamage + suffix.expectedHpDamage,
    expectedDamage: prefix.expectedDamage + suffix.expectedDamage,
    expectedOwnSlotLoss: prefix.expectedOwnSlotLoss + suffix.expectedOwnSlotLoss,
    expectedResourceCost: prefix.expectedResourceCost + suffix.expectedResourceCost,
    worstMargin: Math.min(prefix.worstMargin, suffix.worstMargin),
  };
}

/** Builds exact combat ordering fields while deferring the expensive public simulation. */
function summarizeEvaluatedCombatPlan(loadouts, staticContext, evaluation) {
  const plan = summarizePlan(loadouts, staticContext);
  plan.fulfilled = evaluation.allWaveTargetFulfillmentProbability === 1;
  plan.totalDamagePower = evaluation.expectedDamage;
  plan.attackPowerProxy = evaluation.expectedDamage;
  plan.totalExpectedLoss = evaluation.expectedOwnSlotLoss;
  plan.totalResourceCost = evaluation.expectedResourceCost;
  plan.worstMargin = evaluation.worstMargin;
  plan.allWaveTargetFulfillmentProbability =
    evaluation.allWaveTargetFulfillmentProbability;
  plan.simulation = {
    expectedSunkCount: evaluation.expectedSunkCount,
    expectedHpDamage: evaluation.expectedHpDamage,
  };
  plan.calculationMode = 'detailed';
  plan.mode = 'detailed';
  return plan;
}

/** Collects positive HP values from a sample range in flat fleet-major continuations. */
function positiveHitPointsFromFlat(flatByFleet, sampleStart, sampleEnd) {
  const values = [];
  for (let sample = sampleStart; sample < sampleEnd; sample += 1) {
    for (const flat of flatByFleet) {
      const offset = sample * flat.width;
      for (let index = 0; index < flat.width; index += 1) {
        const hitPoints = Number(flat.values[offset + index]);
        if (hitPoints > 0) values.push(hitPoints);
      }
    }
  }
  return values;
}

/** Builds independently relaxed HP purchase pools from flat fixed-sample continuations. */
function createStateCombatBuckets(enemyHitPointsFlatByFleet, prepared) {
  const bucketCount = Math.min(
    COMBAT_BOUND_BUCKET_COUNT,
    prepared.simulationOptions.sampleCount,
  );
  const bucketSize = Math.ceil(prepared.simulationOptions.sampleCount / bucketCount);
  const initialShips = (prepared.enemyFleets?.[0] || prepared.enemy).ships || [];
  const initialHitPoints = initialShips
    .map((ship) => Math.max(0, Number(ship.currentHp ?? ship.hp) || 0))
    .filter((hitPoints) => hitPoints > 0);
  const initialHpTotal = initialHitPoints.reduce((total, hitPoints) => total + hitPoints, 0);
  return Array.from({ length: bucketCount }, (_unused, bucketIndex) => {
    const start = bucketIndex * bucketSize;
    const end = Math.min(prepared.simulationOptions.sampleCount, start + bucketSize);
    const remaining = positiveHitPointsFromFlat(
      enemyHitPointsFlatByFleet,
      start,
      end,
    ).sort((left, right) => left - right);
    const cumulative = new Float64Array(remaining.length);
    const remainingHp = remaining.reduce((total, hitPoints, index) => {
      const next = total + hitPoints;
      cumulative[index] = next;
      return next;
    }, 0);
    const samples = end - start;
    return {
      cumulativeRemainingHitPoints: cumulative,
      prefixSunk: initialHitPoints.length * samples - remaining.length,
      prefixHpDamage: initialHpTotal * samples - remainingHp,
      remainingHp,
    };
  });
}

/** Precomputes per-group aggregate hit and damage ceilings for one suffix base. */
function createScalarCombatCeilings(prepared, baseIndex) {
  const groupCeilings = prepared.groups.map((group) =>
    scalarPlaneCeiling(group.representative, prepared, baseIndex));
  const bucketCount = Math.min(
    COMBAT_BOUND_BUCKET_COUNT,
    prepared.simulationOptions.sampleCount,
  );
  const lockedCeiling = prepared.baseLocks[baseIndex].slots.reduce((total, slot) => {
    if (slot.kind !== SLOT_KINDS.LOCKED_ITEM) return total;
    const ceiling = scalarPlaneCeiling(slot.plane, prepared, baseIndex);
    total.totalHits += ceiling.totalHits;
    total.totalDamage += ceiling.totalDamage;
    addScaledBuckets(total.hitsByBucket, ceiling.hitsByBucket, 1);
    addScaledBuckets(total.damageByBucket, ceiling.damageByBucket, 1);
    return total;
  }, {
    totalHits: 0,
    totalDamage: 0,
    hitsByBucket: new Float64Array(bucketCount),
    damageByBucket: new Float64Array(bucketCount),
  });
  return { groupCeilings, lockedCeiling };
}

/** Materializes one plane's safe hit and HP ceilings at each fixed draw coordinate. */
function scalarPlaneCoordinateVectors(plane, prepared, baseIndex, attackIndexes) {
  const sampleCount = prepared.simulationOptions.sampleCount;
  const hitsByCoordinate = attackIndexes.map(() => new Uint8Array(sampleCount * 2));
  const damageByCoordinate = attackIndexes.map(() => new Float64Array(sampleCount * 2));
  if (!isLbasCombatAttacker(plane)) {
    return { hitsByCoordinate, damageByCoordinate };
  }
  const enemy = prepared.enemyFleets?.[0] || prepared.enemy;
  const ships = (enemy.ships || []).filter((ship) => Number(ship.currentHp ?? ship.hp) > 0);
  const isCombined = Number(enemy.battleType) === 2 ||
    ships.some((ship) => ship.fleet === 'escort');
  const currentSlot = Number(
    plane.currentSlot ?? plane.slotSize ?? defaultSlotSizeForPlane(plane),
  ) || 0;
  const targets = ships.map((target) => {
    const probabilities = calculateHitAndCriticalProbabilities(plane, target, {
      isCombined,
      proficiencyBoundary: prepared.simulationOptions.proficiencyBoundary,
    });
    const power = calculatePlaneTargetAttackPower(plane, target, {
      currentSlot,
      combatContext: prepared.combatContext,
      reconModifier: 1.18,
      isCombined,
      aswPowerRoll: 1,
      specialPostCapRoll: 0,
      contactMultiplier: 1.2,
    });
    const hitPoints = Math.max(0, Number(target.currentHp ?? target.hp) || 0);
    const armor = Math.max(0, Number(target.armor) || 0);
    return {
      hitProbability: probabilities.hitProbability,
      criticalProbability: probabilities.criticalProbability,
      normalDamage: maximumArmorDamage(power, hitPoints, armor),
      criticalDamage: maximumArmorDamage(
        Math.floor(power * probabilities.criticalDamageMultiplier),
        hitPoints,
        armor,
      ),
    };
  });
  for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
    const waveIndex = baseIndex * 2 + waveInBase;
    const waveOffset = waveInBase * sampleCount;
    attackIndexes.forEach((attackIndex, coordinateIndex) => {
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const draw = clampUnit(prepared.simulationOptions.fixedRandom(
          sample,
          waveIndex,
          'combat-hit',
          attackIndex,
          0,
        ));
        let sampleDamage = 0;
        let hit = false;
        for (const target of targets) {
          if (draw > target.hitProbability) continue;
          hit = true;
          sampleDamage = Math.max(
            sampleDamage,
            draw <= target.criticalProbability
              ? target.criticalDamage
              : target.normalDamage,
          );
        }
        hitsByCoordinate[coordinateIndex][waveOffset + sample] = Number(hit);
        damageByCoordinate[coordinateIndex][waveOffset + sample] = sampleDamage;
      }
    });
  }
  return { hitsByCoordinate, damageByCoordinate };
}

/** Relaxes one attacker over all supplied fixed draw coordinates in each dispatched wave. */
function scalarPlaneCeiling(
  plane,
  prepared,
  baseIndex,
  attackIndexes = [0, 1, 2, 3],
) {
  const sampleCount = prepared.simulationOptions.sampleCount;
  const bucketCount = Math.min(COMBAT_BOUND_BUCKET_COUNT, sampleCount);
  const bucketSize = Math.ceil(sampleCount / bucketCount);
  const hitsByBucket = new Float64Array(bucketCount);
  const damageByBucket = new Float64Array(bucketCount);
  const { hitsByCoordinate, damageByCoordinate } = scalarPlaneCoordinateVectors(
    plane,
    prepared,
    baseIndex,
    attackIndexes,
  );
  let totalHits = 0;
  let totalDamage = 0;
  for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
    const waveOffset = waveInBase * sampleCount;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const bucketIndex = Math.floor(sample / bucketSize);
      const vectorIndex = waveOffset + sample;
      let sampleHits = 0;
      let sampleDamage = 0;
      for (let coordinateIndex = 0;
        coordinateIndex < hitsByCoordinate.length;
        coordinateIndex += 1) {
        sampleHits = Math.max(sampleHits, hitsByCoordinate[coordinateIndex][vectorIndex]);
        sampleDamage = Math.max(
          sampleDamage,
          damageByCoordinate[coordinateIndex][vectorIndex],
        );
      }
      totalHits += sampleHits;
      totalDamage += sampleDamage;
      hitsByBucket[bucketIndex] += sampleHits;
      damageByBucket[bucketIndex] += sampleDamage;
    }
  }
  return {
    totalHits,
    totalDamage,
    hitsByBucket,
    damageByBucket,
  };
}

/** Sums the independent per-plane relaxation for one concrete suffix candidate. */
function scalarCeilingForCandidate(
  candidate,
  ceilings,
  loadout,
  prepared,
  baseIndex,
  coordinateBucketCeiling = null,
) {
  let totalHits = ceilings.lockedCeiling.totalHits;
  let totalDamage = ceilings.lockedCeiling.totalDamage;
  for (const [groupIndex, count] of candidate.pairs) {
    const ceiling = ceilings.groupCeilings[groupIndex];
    totalHits += count * ceiling.totalHits;
    totalDamage += count * ceiling.totalDamage;
  }
  if (loadout.some((plane) => plane && capabilitiesFor(plane).isJet === true)) {
    totalHits = Number.POSITIVE_INFINITY;
    totalDamage = Number.POSITIVE_INFINITY;
  }
  const { hitsByBucket, damageByBucket } = coordinateBucketCeiling ||
    coordinateBucketCeilingForLoadout(loadout, prepared, baseIndex);
  return {
    totalHits,
    totalDamage,
    hitsByBucket,
    damageByBucket,
  };
}

/** Uses every coordinate reachable under slot-sensitive canonical combat ordering. */
function coordinateBucketCeilingForLoadout(loadout, prepared, baseIndex) {
  const sampleCount = prepared.simulationOptions.sampleCount;
  const bucketCount = Math.min(COMBAT_BOUND_BUCKET_COUNT, sampleCount);
  const hitsByBucket = new Float64Array(bucketCount);
  const damageByBucket = new Float64Array(bucketCount);
  if (loadout.some((plane) => plane && capabilitiesFor(plane).isJet === true)) {
    hitsByBucket.fill(Number.POSITIVE_INFINITY);
    damageByBucket.fill(Number.POSITIVE_INFINITY);
    return { hitsByBucket, damageByBucket };
  }
  const attackers = loadout.filter((plane) =>
    isLbasCombatAttacker(plane));
  const coordinates = Array.from({ length: attackers.length }, (_unused, index) => index);
  const ceilings = attackers.map((plane) =>
    scalarPlaneCoordinateVectors(plane, prepared, baseIndex, coordinates));
  const hitMatrix = ceilings.map((ceiling) => ceiling.hitsByCoordinate);
  const damageMatrix = ceilings.map((ceiling) => ceiling.damageByCoordinate);
  const bucketSize = Math.ceil(sampleCount / bucketCount);
  for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
    const waveOffset = waveInBase * sampleCount;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const vectorIndex = waveOffset + sample;
      const bucketIndex = Math.floor(sample / bucketSize);
      hitsByBucket[bucketIndex] += maximumCoordinateAssignment(hitMatrix, vectorIndex);
      damageByBucket[bucketIndex] += maximumCoordinateAssignment(damageMatrix, vectorIndex);
    }
  }
  return { hitsByBucket, damageByBucket };
}

/** Bounds each attacker across every rank reachable when any earlier plane can reach zero. */
function possibleAttackCoordinates(loadout) {
  const attackerCount = loadout.filter((plane) =>
    isLbasCombatAttacker(plane)).length;
  const coordinates = Array.from({ length: attackerCount }, (_unused, index) => index);
  const result = Array(loadout.length).fill(null);
  loadout.forEach((plane, slotIndex) => {
    if (isLbasCombatAttacker(plane)) {
      result[slotIndex] = coordinates;
    }
  });
  return result;
}

/** Adds one scaled fixed-length bucket vector into a mutable destination. */
function addScaledBuckets(destination, source, scale) {
  for (let index = 0; index < destination.length; index += 1) {
    destination[index] += source[index] * scale;
  }
}

/** Bounds combined sinks by buying the globally cheapest remaining enemy HP first. */
function frontierAggregateCanBeat(
  prefix,
  state,
  suffixCeiling,
  incumbentScore,
  sampleCount,
) {
  if (!incumbentScore) return true;
  const maximumNewSinks = maximumAffordableSinks(
    suffixCeiling.totalHits,
    suffixCeiling.totalDamage,
    state.cumulativeRemainingHitPoints,
  );
  const sunkNumerator = Math.round(prefix.expectedSunkCount * sampleCount) +
    maximumNewSinks;
  const hpDamageNumerator = Math.round(prefix.expectedHpDamage * sampleCount) +
    Math.min(state.remainingHpTotal, suffixCeiling.totalDamage);
  const incumbentSunkNumerator = Math.round(incumbentScore.sunk * sampleCount);
  const incumbentHpNumerator = Math.round(incumbentScore.hpDamage * sampleCount);
  return sunkNumerator > incumbentSunkNumerator || (
    sunkNumerator === incumbentSunkNumerator &&
    hpDamageNumerator >= incumbentHpNumerator
  );
}

/** Bounds sinks and HP damage independently inside each contiguous sample bucket. */
function frontierBucketCanBeat(state, suffixCeiling, incumbentScore, sampleCount) {
  if (!incumbentScore) return true;
  let sunkNumerator = 0;
  let hpDamageNumerator = 0;
  for (let bucketIndex = 0; bucketIndex < state.combatBuckets.length; bucketIndex += 1) {
    const bucket = state.combatBuckets[bucketIndex];
    sunkNumerator += bucket.prefixSunk + maximumAffordableSinks(
      suffixCeiling.hitsByBucket[bucketIndex],
      suffixCeiling.damageByBucket[bucketIndex],
      bucket.cumulativeRemainingHitPoints,
    );
    hpDamageNumerator += bucket.prefixHpDamage + Math.min(
      bucket.remainingHp,
      suffixCeiling.damageByBucket[bucketIndex],
    );
  }
  const incumbentSunkNumerator = Math.round(incumbentScore.sunk * sampleCount);
  const incumbentHpNumerator = Math.round(incumbentScore.hpDamage * sampleCount);
  return sunkNumerator > incumbentSunkNumerator || (
    sunkNumerator === incumbentSunkNumerator &&
    hpDamageNumerator >= incumbentHpNumerator
  );
}

/** Binary-searches the most remaining ships affordable under hit and damage totals. */
function maximumAffordableSinks(totalHits, totalDamage, cumulativeHitPoints) {
  let low = 0;
  let high = Math.min(Math.floor(totalHits), cumulativeHitPoints.length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (cumulativeHitPoints[middle - 1] <= totalDamage) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** Returns maximum HP loss under minimum armor and maximum scratch rolls. */
function maximumArmorDamage(power, currentHp, armor) {
  let damage = Math.floor(power - 0.7 * armor);
  if (damage <= 0 && currentHp > 0) {
    damage = Math.floor(currentHp * 0.06 + 0.08 * Math.max(0, currentHp - 1));
  }
  return Math.min(currentHp, Math.max(0, damage));
}

/** Normalizes a deterministic random draw to the simulator's half-open unit interval. */
function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, 1 - Number.EPSILON);
}

/** Rejects only when the additive sinks, HP damage, or proxy score strictly loses. */
function combinedHighScoreCanBeat(prefix, suffix, incumbentScore) {
  if (!incumbentScore) return true;
  const candidate = {
    sunk: prefix.expectedSunkCount + suffix.expectedSunkCount,
    hpDamage: prefix.expectedHpDamage + suffix.expectedHpDamage,
    damage: prefix.expectedDamage + suffix.expectedDamage,
  };
  for (const field of ['sunk', 'hpDamage']) {
    if (candidate[field] !== incumbentScore[field]) {
      return candidate[field] > incumbentScore[field];
    }
  }
  if (incumbentScore.damage == null) return true;
  if (candidate.damage !== incumbentScore.damage) return candidate.damage > incumbentScore.damage;
  return true;
}

/** Checks grouped inventory capacity without reserving mutable global state. */
function candidatesAreCompatible(prefix, suffix, groups) {
  const used = new Map(prefix.pairs);
  for (const [groupIndex, count] of suffix.pairs) {
    if ((used.get(groupIndex) || 0) + count > groups[groupIndex].instances.length) {
      return false;
    }
  }
  return true;
}

/** Materializes one grouped base with stable representative instances. */
function materializeSingleBase(candidate, baseIndex, prepared) {
  const lock = prepared.baseLocks[baseIndex];
  const loadout = lock.slots.map((slot) =>
    slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
  const selected = candidate.pairs.flatMap(([groupIndex, count]) =>
    prepared.groups[groupIndex].instances.slice(0, count));
  let cursor = 0;
  lock.slots.forEach((slot, slotIndex) => {
    if (slot.kind === SLOT_KINDS.OPEN) loadout[slotIndex] = selected[cursor++] || null;
  });
  return loadout;
}

/** Materializes two compatible grouped bases without reusing concrete instances. */
function materializeLoadouts(candidates, prepared) {
  const cursors = prepared.groups.map(() => 0);
  return candidates.map((candidate, baseIndex) => {
    const lock = prepared.baseLocks[baseIndex];
    const loadout = lock.slots.map((slot) =>
      slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
    const selected = candidate.pairs.flatMap(([groupIndex, count]) => {
      const start = cursors[groupIndex];
      cursors[groupIndex] += count;
      return prepared.groups[groupIndex].instances.slice(start, start + count);
    });
    let cursor = 0;
    lock.slots.forEach((slot, slotIndex) => {
      if (slot.kind === SLOT_KINDS.OPEN) loadout[slotIndex] = selected[cursor++] || null;
    });
    return loadout;
  });
}

/** Returns the progress shape consumed by CLI and worker events. */
function progressSnapshot(stats, startedAt, phase = 'proving_optimal') {
  return {
    phase,
    nodesExplored: stats.nodesExplored,
    totalNodesExplored: stats.nodesExplored,
    nodesPruned: stats.nodesPruned,
    prefixCandidates: stats.prefixCandidates,
    prefixTransitionGroups: stats.prefixTransitionGroups,
    prefixCombatReplays: stats.prefixCombatReplays,
    prefixTrajectoryCacheHits: stats.prefixTrajectoryCacheHits,
    prefixStates: stats.prefixStates,
    prefixAirStates: stats.prefixAirStates,
    minimumSuffixAir: stats.minimumSuffixAir,
    prefixShardCount: stats.prefixShardCount,
    prefixShardIndex: stats.prefixShardIndex,
    suffixPartitionCount: stats.suffixPartitionCount,
    suffixPartitionIndex: stats.suffixPartitionIndex,
    suffixEnumerationSharded: stats.suffixEnumerationSharded,
    suffixCandidates: stats.suffixCandidates,
    suffixTransitionGroups: stats.suffixTransitionGroups,
    suffixTransitionGroupsAssigned: stats.suffixTransitionGroupsAssigned,
    suffixTransitionAssignmentComplete: stats.suffixTransitionAssignmentComplete,
    suffixShardCount: stats.suffixShardCount,
    suffixShardIndex: stats.suffixShardIndex,
    shardComplete: stats.shardComplete,
    suffixTransitionGroupsProcessed: stats.suffixTransitionGroupsProcessed,
    suffixBucketCeilingsComputed: stats.suffixBucketCeilingsComputed,
    suffixBucketCeilingCacheHits: stats.suffixBucketCeilingCacheHits,
    suffixTransitionsEvaluated: stats.suffixTransitionsEvaluated,
    suffixBaseRecordCacheHits: stats.suffixBaseRecordCacheHits,
    suffixCombatTrajectoryHits: stats.suffixCombatTrajectoryHits,
    suffixFirstHpCacheHits: stats.suffixFirstHpCacheHits,
    suffixCombatBatches: stats.suffixCombatBatches,
    suffixCombatStatesBatched: stats.suffixCombatStatesBatched,
    suffixHpVectorCacheHits: stats.suffixHpVectorCacheHits,
    suffixHpVectorsResolved: stats.suffixHpVectorsResolved,
    suffixTrajectoryCacheHits: stats.suffixTrajectoryCacheHits,
    suffixTrajectoryStatesReused: stats.suffixTrajectoryStatesReused,
    frontierAggregateCombatBoundsEvaluated: stats.frontierAggregateCombatBoundsEvaluated,
    frontierAggregateCombatBoundsPruned: stats.frontierAggregateCombatBoundsPruned,
    frontierBucketCombatBoundsEvaluated: stats.frontierBucketCombatBoundsEvaluated,
    frontierBucketCombatBoundsPruned: stats.frontierBucketCombatBoundsPruned,
    inventoryCompatibilityPrunes: stats.inventoryCompatibilityPrunes,
    sharedIncumbentScoreReads: stats.sharedIncumbentScoreReads,
    seedCandidatesEvaluated: stats.seedCandidatesEvaluated,
    prefixAirSamplesEvaluated: stats.prefixAirSamplesEvaluated,
    firstWaveAirBoundsPruned: stats.firstWaveAirBoundsPruned,
    continuationFirstWaveAirBoundsPruned: stats.continuationFirstWaveAirBoundsPruned,
    candidatesEvaluated: stats.candidatesEvaluated,
    terminalPlanSimulations: stats.terminalPlanSimulations,
    terminalPlanSimulationReuses: stats.terminalPlanSimulationReuses,
    simulationSamplesEvaluated: stats.simulationSamplesEvaluated,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Finalizes a cancelled or budget-limited frontier search without claiming proof. */
function stoppedResult(incumbent, stats, startedAt, reason) {
  stats.status = reason === 'cancelled' ? 'cancelled' : 'budget_exhausted';
  stats.stopReason = reason;
  stats.elapsedMs = Date.now() - startedAt;
  return {
    plans: incumbent ? [incumbent] : [],
    provenOptimal: false,
    formulaVersion: COMBAT_FORMULA.formulaVersion,
    solverStats: stats,
  };
}

module.exports = {
  combatTransitionKey,
  maximumCoordinateAssignment,
  orderSuffixTransitionsForProof,
  possibleAttackCoordinates,
  scalarPlaneCeiling,
  solveCombatFrontier,
};
