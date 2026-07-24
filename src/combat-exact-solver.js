'use strict';

const {
  calculateSlotAirPower,
  defaultSlotSizeForPlane,
  landReconCoefficient,
  requiredAirForState,
} = require('./air-power');
const { aircraftEquivalenceKey, capabilitiesFor } = require('./aircraft');
const {
  COMBAT_FORMULA,
  calculateHitAndCriticalProbabilities,
  isLbasCombatAttacker,
} = require('./combat-resolution');
const { maximumCoordinateAssignment } = require('./combat-coordinate-bound');
const {
  calculatePlaneTargetAttackPower,
  landBasedReconDamageModifier,
} = require('./damage');
const { createDetailedScoreContext, evaluateDetailedPlanScore } = require('./wave-simulator');
const {
  canonicalPlanKey,
  combatScorePlan,
  compareCombatPlanScores,
  summarizePlan,
} = require('./search-score');

const SLOT_KINDS = Object.freeze({
  LOCKED_ITEM: 'LOCKED_ITEM',
  OPEN: 'OPEN',
});
const PROGRESS_NODE_INTERVAL = 65536;
const FIXED_COMBAT_BASE_CACHE_LIMIT = 128;

/** Selects the reusable two-base frontier when its exact continuation assumptions hold. */
function solveCombatExact(prepared, solverOptions = {}) {
  const enemies = prepared.enemyFleets || (prepared.enemy ? [prepared.enemy] : []);
  if (prepared.baseCount === 2 &&
      prepared.maxResults === 1 &&
      prepared.budget === Number.POSITIVE_INFINITY &&
      prepared.simulationOptions.dispatchMode !== 'separate' &&
      enemies.length === 1) {
    const { solveCombatFrontier } = require('./combat-frontier-solver');
    return solveCombatFrontier(prepared, solverOptions);
  }
  return solveCombatGroupedExact(prepared, solverOptions);
}

/** Exhaustively proves Top K combat plans over grouped inventory counts. */
function solveCombatGroupedExact(prepared, solverOptions = {}) {
  const startedAt = Date.now();
  const sampleCount = prepared.simulationOptions.sampleCount;
  const remainingCounts = prepared.groups.map((group) => group.instances.length);
  const selectedCounts = [];
  const retained = [];
  const retainedByKey = new Map();
  const evaluatedSeedKeys = new Set();
  const stats = {
    backend: 'combat-grouped-exhaustive',
    status: 'searching',
    nodesExplored: 0,
    nodesPruned: 0,
    candidatesEvaluated: 0,
    simulationSamplesEvaluated: 0,
    airScreenSamplesEvaluated: 0,
    combatSamplesEvaluated: 0,
    airScreensPruned: 0,
    staticCombatBoundsPruned: 0,
    aggregateCombatBoundsPruned: 0,
    fixedSampleCombatBoundSamplesEvaluated: 0,
    fixedSampleSinkBoundsPruned: 0,
    fixedCombatContributionCacheHits: 0,
    fixedCombatContributionCacheMisses: 0,
    fixedCombatBaseContributionCacheHits: 0,
    fixedCombatBaseContributionCacheMisses: 0,
    seedCandidatesEvaluated: 0,
    duplicateSeedLeavesPruned: 0,
    firstWaveAirBoundsPruned: 0,
    firstWaveSuffixAirBoundsPruned: 0,
    firstWavePartialCompletionsPruned: 0,
    prefixAirSamplesEvaluated: 0,
    prefixTargetBranchesPruned: 0,
    continuationFirstWaveAirBoundsPruned: 0,
    continuationPartialCompletionsPruned: 0,
    elapsedMs: 0,
  };
  const groupOrder = orderedGroups(prepared.groups);
  const detailedScoreContext = createDetailedScoreContext({
    baseCount: prepared.baseCount,
    combatContext: prepared.combatContext,
    enemy: prepared.enemy,
    enemyFleets: prepared.enemyFleets,
    targetStates: prepared.waveTargets,
    ...prepared.simulationOptions,
  });
  const groupSearchFeatures = prepared.groups.map((group) => {
    const plane = group.representative;
    const capabilities = capabilitiesFor(plane);
    /** Accepts either an explicit capability override or the derived aircraft capability. */
    const has = (name) => plane[name] === true || capabilities[name] === true;
    return {
      slotAirPower: group.slotAirPower,
      reconCoefficient: has('isLandRecon')
        ? Number(plane.scout) === 9 ? 1.18 : Number(plane.scout) === 8 ? 1.15 : 1
        : 1,
      radius: Number(plane.radius) || 0,
      isRecon: has('isRecon'),
      blocksRangeExtension: has('blocksRangeExtension'),
    };
  });
  const prefixAirConstraints = new Map();
  let fixedCombatHitDraws = null;
  let fixedCombatBoundContext = null;
  let stopReason = null;
  let phase = 'finding_feasible';

  solverOptions.onPhaseChange?.(phase);
  emitProgress();

  /** Returns false after cancellation or an explicit work budget is exhausted. */
  function consumeNode() {
    if (stopReason) return false;
    if (prepared.isCancelled?.() || solverOptions.isCancelled?.()) {
      stopReason = 'cancelled';
      return false;
    }
    if (stats.nodesExplored >= prepared.budget) {
      stopReason = 'node_budget';
      return false;
    }
    stats.nodesExplored += 1;
    if (stats.nodesExplored % PROGRESS_NODE_INTERVAL === 0) emitProgress();
    return true;
  }

  /** Emits one monotonic search snapshot without retaining historical states. */
  function emitProgress() {
    solverOptions.onProgress?.({
      phase,
      nodesExplored: stats.nodesExplored,
      totalNodesExplored: stats.nodesExplored,
      nodesPruned: stats.nodesPruned,
      candidatesEvaluated: stats.candidatesEvaluated,
      simulationSamplesEvaluated: stats.simulationSamplesEvaluated,
      airScreenSamplesEvaluated: stats.airScreenSamplesEvaluated,
      combatSamplesEvaluated: stats.combatSamplesEvaluated,
      elapsedMs: Date.now() - startedAt,
    });
  }

  /** Evaluates one concrete assignment with the full combat simulator. */
  function evaluateLoadouts(loadouts, isSeed = false, suppliedBaseCacheKeys = null) {
    const candidateKey = canonicalPlanKey({
      bases: loadouts.map((loadout) => ({ loadout })),
    });
    if (!isSeed && evaluatedSeedKeys.has(candidateKey)) {
      stats.nodesPruned += 1;
      stats.duplicateSeedLeavesPruned += 1;
      return;
    }
    if (stats.simulationSamplesEvaluated + sampleCount > prepared.simulationBudget) {
      stopReason = 'simulation_budget';
      return;
    }
    const pruningIncumbent = retained.length >= prepared.maxResults
      ? retained[retained.length - 1]
      : null;
    const incumbentScore = pruningIncumbent ? combatScorePlan(pruningIncumbent) : null;
    const baseCacheKeys = suppliedBaseCacheKeys || loadouts.map(combatBaseCacheKey);
    let combatSampleUpperBounds = null;
    if (incumbentScore?.fulfillment === 1 &&
        maximumSinkCount(loadouts, prepared) < incumbentScore.sunk) {
      stats.nodesPruned += 1;
      stats.staticCombatBoundsPruned += 1;
      return;
    }
    if (incumbentScore?.fulfillment === 1) {
      if (stats.simulationSamplesEvaluated + sampleCount > prepared.simulationBudget) {
        stopReason = 'simulation_budget';
        return;
      }
      fixedCombatHitDraws ||= prepareFixedCombatHitDraws(prepared);
      fixedCombatBoundContext ||= createFixedCombatBoundContext(
        prepared,
        fixedCombatHitDraws,
        stats,
      );
      const optimisticCombat = maximumFixedSampleCombatScore(
        loadouts,
        fixedCombatBoundContext,
        baseCacheKeys,
        incumbentScore,
      );
      stats.fixedSampleCombatBoundSamplesEvaluated += optimisticCombat.samplesEvaluated;
      stats.simulationSamplesEvaluated += optimisticCombat.samplesEvaluated;
      if (optimisticCombat.sunk < incumbentScore.sunk || (
        optimisticCombat.sunk === incumbentScore.sunk &&
        optimisticCombat.hpDamage < incumbentScore.hpDamage
      )) {
        stats.nodesPruned += 1;
        stats.fixedSampleSinkBoundsPruned += 1;
        if (optimisticCombat.aggregatePruned) {
          stats.aggregateCombatBoundsPruned += 1;
        }
        return;
      }
      combatSampleUpperBounds = {
        remainingSunk: optimisticCombat.remainingSunk,
        remainingHpDamage: optimisticCombat.remainingHpDamage,
      };
    }
    if (isSeed) {
      const airScreen = evaluateDetailedPlanScore({
        bases: loadouts,
        baseCacheKeys,
        enemy: prepared.enemy,
        enemyFleets: prepared.enemyFleets,
        targetStates: prepared.waveTargets,
        combatContext: prepared.combatContext,
        ...prepared.simulationOptions,
        scoreContext: detailedScoreContext,
        incumbentScore: {
          fulfillment: 1,
          damage: -Number.MAX_VALUE,
        },
      });
      const airSamples = airScreen.samplesEvaluated || sampleCount;
      stats.airScreenSamplesEvaluated += airSamples;
      stats.simulationSamplesEvaluated += airSamples;
      if (airScreen.prunedBySimulationBound ||
          airScreen.allWaveTargetFulfillmentProbability !== 1) {
        stats.nodesPruned += 1;
        stats.airScreensPruned += 1;
        return;
      }
    }
    if (stats.simulationSamplesEvaluated + sampleCount > prepared.simulationBudget) {
      stopReason = 'simulation_budget';
      return;
    }
    if (!isSeed) {
      const combatEvaluation = evaluateDetailedPlanScore({
        bases: loadouts,
        baseCacheKeys,
        enemy: prepared.enemy,
        enemyFleets: prepared.enemyFleets,
        targetStates: prepared.waveTargets,
        combatContext: prepared.combatContext,
        ...prepared.simulationOptions,
        scoreContext: detailedScoreContext,
        includeCombat: true,
        ...(combatSampleUpperBounds ? {
          combatSampleUpperBounds,
        } : {}),
        ...(incumbentScore ? { incumbentScore } : {}),
      });
      stats.candidatesEvaluated += 1;
      const numericCombatSamples = combatEvaluation.samplesEvaluated || sampleCount;
      stats.combatSamplesEvaluated += numericCombatSamples;
      stats.simulationSamplesEvaluated += numericCombatSamples;
      if (combatEvaluation.prunedBySimulationBound ||
          combatEvaluation.expectedHpDamage == null ||
          combatEvaluation.allWaveTargetFulfillmentProbability !== 1 ||
          !numericCombatEvaluationCanBeat(combatEvaluation, incumbentScore)) return;
      if (stats.simulationSamplesEvaluated + sampleCount > prepared.simulationBudget) {
        stopReason = 'simulation_budget';
        return;
      }
    } else {
      stats.candidatesEvaluated += 1;
      evaluatedSeedKeys.add(candidateKey);
    }

    const plan = summarizePlan(loadouts, {
      ...prepared,
      simulationOptions: {
        ...prepared.simulationOptions,
        ...(pruningIncumbent ? {
          incumbentScore: combatScorePlan(pruningIncumbent),
        } : {}),
      },
    });
    const materializationSamples = plan.simulation?.samplesEvaluated || sampleCount;
    if (isSeed) {
      stats.combatSamplesEvaluated += materializationSamples;
      stats.simulationSamplesEvaluated += materializationSamples;
    } else {
      stats.combatMaterializationSamplesEvaluated =
        (stats.combatMaterializationSamplesEvaluated || 0) + materializationSamples;
      stats.simulationSamplesEvaluated += materializationSamples;
    }
    if (plan.prunedBySimulationBound || plan.simulation?.expectedHpDamage == null ||
        plan.allWaveTargetFulfillmentProbability !== 1) return;
    plan.optimizationObjective = 'combat';
    plan.combatScore = combatScorePlan(plan);
    const previousBest = retained[0] || null;
    retainPlan(plan, retained, retainedByKey, prepared.maxResults);
    if (retained[0] !== previousBest) {
      if (phase === 'finding_feasible') {
        phase = 'improving';
        solverOptions.onPhaseChange?.(phase);
      }
      solverOptions.onIncumbent?.(retained[0], progressSnapshot());
      if (phase !== 'proving_optimal') {
        phase = 'proving_optimal';
        solverOptions.onPhaseChange?.(phase);
      }
    }
  }

  /** Materializes and evaluates one exact grouped leaf. */
  function evaluateCompleteAssignment() {
    evaluateLoadouts(
      materializeConcreteLoadouts(selectedCounts, prepared),
      false,
      selectedCounts.map((counts) => counts.join(',')),
    );
  }

  /** Returns the current progress shape used by incumbent events. */
  function progressSnapshot() {
    return {
      phase,
      nodesExplored: stats.nodesExplored,
      totalNodesExplored: stats.nodesExplored,
      nodesPruned: stats.nodesPruned,
      candidatesEvaluated: stats.candidatesEvaluated,
      simulationSamplesEvaluated: stats.simulationSamplesEvaluated,
      airScreenSamplesEvaluated: stats.airScreenSamplesEvaluated,
      combatSamplesEvaluated: stats.combatSamplesEvaluated,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /** Derives the exact next-base first-wave requirement from every fixed prefix sample. */
  function prefixAirConstraint(baseIndex) {
    const key = selectedCounts.map((counts) => counts.join(',')).join('|');
    if (prefixAirConstraints.has(key)) return prefixAirConstraints.get(key);
    if (stats.simulationSamplesEvaluated + sampleCount > prepared.simulationBudget) {
      stopReason = 'simulation_budget';
      return null;
    }
    const baseCacheKeys = selectedCounts.map((counts) => counts.join(','));
    const evaluation = evaluateDetailedPlanScore({
      ...prepared.simulationOptions,
      bases: materializeConcreteLoadouts(selectedCounts, prepared),
      baseCacheKeys,
      enemy: prepared.enemy,
      enemyFleets: prepared.enemyFleets,
      targetStates: prepared.waveTargets.slice(0, baseIndex * 2),
      combatContext: prepared.combatContext,
      scoreContext: detailedScoreContext,
    });
    const samples = evaluation.samplesEvaluated || sampleCount;
    stats.prefixAirSamplesEvaluated += samples;
    stats.simulationSamplesEvaluated += samples;
    const waveIndex = baseIndex * 2;
    const maximumEnemyAir = evaluation.maximumFinalEnemyAir || [];
    const requiredAir = prepared.simulationOptions.dispatchMode === 'separate'
      ? Math.max(0, ...maximumEnemyAir.map((enemyAir, targetIndex) => requiredAirForState(
        enemyAir,
        prepared.waveTargets[waveIndex + targetIndex] || prepared.waveTargets[waveIndex],
      )))
      : requiredAirForState(
        maximumEnemyAir[0] || 0,
        prepared.waveTargets[waveIndex],
      );
    const constraint = {
      prefixFulfilled: evaluation.allWaveTargetFulfillmentProbability === 1,
      requiredAir,
    };
    prefixAirConstraints.set(key, constraint);
    return constraint;
  }

  /** Enumerates each base's grouped multiset, including explicit empty slots. */
  function visitBase(baseIndex) {
    if (!consumeNode()) return;
    if (baseIndex === prepared.baseCount) {
      evaluateCompleteAssignment();
      return;
    }
    const lock = prepared.baseLocks[baseIndex];
    const openSlots = lock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length;
    const counts = prepared.groups.map(() => 0);
    const lockedPlanes = lock.slots
      .filter((slot) => slot.kind === SLOT_KINDS.LOCKED_ITEM)
      .map((slot) => slot.plane);
    const lockedFeatures = lockedPlanes.map((plane) => {
      const capabilities = capabilitiesFor(plane);
      /** Accepts either an explicit capability override or the derived aircraft capability. */
      const has = (name) => plane[name] === true || capabilities[name] === true;
      return {
        slotAirPower: calculateSlotAirPower(plane),
        reconCoefficient: has('isLandRecon')
          ? Number(plane.scout) === 9 ? 1.18 : Number(plane.scout) === 8 ? 1.15 : 1
          : 1,
        radius: Number(plane.radius) || 0,
        isRecon: has('isRecon'),
        blocksRangeExtension: has('blocksRangeExtension'),
      };
    });
    const rawAirStack = [lockedFeatures.reduce(
      (total, feature) => total + feature.slotAirPower,
      0,
    )];
    const reconCoefficientStack = [lockedFeatures.reduce(
      (best, feature) => Math.max(best, feature.reconCoefficient),
      1,
    )];
    const naturalRadiusStack = [lockedFeatures.reduce(
      (minimum, feature) => Math.min(minimum, feature.radius),
      Number.POSITIVE_INFINITY,
    )];
    const reconRadiusStack = [lockedFeatures.reduce(
      (maximum, feature) => feature.isRecon ? Math.max(maximum, feature.radius) : maximum,
      0,
    )];
    const blocksRangeStack = [lockedFeatures.some((feature) => feature.blocksRangeExtension)];
    const relaxedAirSuffixes = buildRelaxedAirSuffixes(
      prepared.groups,
      groupOrder,
      remainingCounts,
      openSlots,
    );
    let firstWaveRequiredAir;
    if (baseIndex === 0) {
      firstWaveRequiredAir = requiredAirForState(
        prepared.enemyAir,
        prepared.waveTargets[0],
      );
    } else {
      const constraint = prefixAirConstraint(baseIndex);
      if (stopReason) return;
      if (!constraint?.prefixFulfilled) {
        stats.nodesPruned += 1;
        stats.prefixTargetBranchesPruned += 1;
        return;
      }
      firstWaveRequiredAir = constraint.requiredAir;
    }

    /** Emits the current multiset, then adds later canonical group choices. */
    function choose(startOrderIndex, selectedCount) {
      if (!consumeNode()) return;
      const stateIndex = rawAirStack.length - 1;
      if (firstWaveRequiredAir != null &&
          maximumRelaxedBaseAir(
             rawAirStack[stateIndex],
             reconCoefficientStack[stateIndex],
             counts,
             relaxedAirSuffixes,
             startOrderIndex,
             openSlots - selectedCount,
           ) < firstWaveRequiredAir) {
         stats.nodesPruned += 1;
         stats.firstWaveAirBoundsPruned += 1;
         if (startOrderIndex > 0) stats.firstWaveSuffixAirBoundsPruned += 1;
         if (baseIndex > 0) stats.continuationFirstWaveAirBoundsPruned += 1;
         return;
      }
      const radiusFeasible = effectiveRadiusForSearchState(
        lockedFeatures.length + selectedCount,
        naturalRadiusStack[stateIndex],
        reconRadiusStack[stateIndex],
        blocksRangeStack[stateIndex],
      ) >= prepared.targetRadius;
      const currentFirstWaveFeasible = firstWaveRequiredAir == null ||
        Math.floor(rawAirStack[stateIndex] * reconCoefficientStack[stateIndex]) >=
          firstWaveRequiredAir;
      if (radiusFeasible && currentFirstWaveFeasible) {
        selectedCounts.push([...counts]);
        subtractCounts(remainingCounts, counts);
        visitBase(baseIndex + 1);
        restoreCounts(remainingCounts, counts);
        selectedCounts.pop();
      } else {
        stats.nodesPruned += 1;
        if (!currentFirstWaveFeasible) {
          stats.firstWavePartialCompletionsPruned += 1;
          if (baseIndex > 0) stats.continuationPartialCompletionsPruned += 1;
        }
      }
      if (stopReason || selectedCount >= openSlots) return;

      for (let orderIndex = startOrderIndex; orderIndex < groupOrder.length; orderIndex += 1) {
        const groupIndex = groupOrder[orderIndex];
        if (counts[groupIndex] >= remainingCounts[groupIndex]) continue;
        const feature = groupSearchFeatures[groupIndex];
        counts[groupIndex] += 1;
        rawAirStack.push(rawAirStack.at(-1) + feature.slotAirPower);
        reconCoefficientStack.push(Math.max(
          reconCoefficientStack.at(-1),
          feature.reconCoefficient,
        ));
        naturalRadiusStack.push(Math.min(naturalRadiusStack.at(-1), feature.radius));
        reconRadiusStack.push(feature.isRecon
          ? Math.max(reconRadiusStack.at(-1), feature.radius)
          : reconRadiusStack.at(-1));
        blocksRangeStack.push(blocksRangeStack.at(-1) || feature.blocksRangeExtension);
        choose(orderIndex, selectedCount + 1);
        blocksRangeStack.pop();
        reconRadiusStack.pop();
        naturalRadiusStack.pop();
        reconCoefficientStack.pop();
        rawAirStack.pop();
        counts[groupIndex] -= 1;
        if (stopReason) return;
      }
    }

    choose(0, 0);
  }

  for (const loadouts of solverOptions.seedLoadouts || []) {
    if (stopReason || prepared.isCancelled?.() || solverOptions.isCancelled?.()) break;
    stats.seedCandidatesEvaluated += 1;
    evaluateLoadouts(loadouts, true);
    emitProgress();
  }
  visitBase(0);
  emitProgress();
  if (!stopReason && (prepared.isCancelled?.() || solverOptions.isCancelled?.())) {
    stopReason = 'cancelled';
  }
  stats.elapsedMs = Date.now() - startedAt;
  stats.status = stopReason === 'cancelled'
    ? 'cancelled'
    : stopReason
      ? 'budget_exhausted'
      : retained.length
        ? 'optimal'
        : 'infeasible';
  stats.stopReason = stopReason;
  return {
    plans: retained,
    provenOptimal: !stopReason,
    formulaVersion: COMBAT_FORMULA.formulaVersion,
    solverStats: stats,
  };
}

/** Retains one canonical representative under the combat lexicographic objective. */
function retainPlan(plan, retained, retainedByKey, maximum) {
  const existing = retainedByKey.get(plan.canonicalKey);
  if (existing && compareCombatPlanScores(plan, existing) <= 0) return;
  if (existing) retained.splice(retained.indexOf(existing), 1);
  retainedByKey.set(plan.canonicalKey, plan);
  retained.push(plan);
  retained.sort((left, right) => -compareCombatPlanScores(left, right));
  if (retained.length > maximum) {
    const removed = retained.pop();
    retainedByKey.delete(removed.canonicalKey);
  }
}

/** Builds a stable per-base cache key for seed loadouts without grouped count vectors. */
function combatBaseCacheKey(loadout) {
  return canonicalPlanKey({ bases: [{ loadout }] });
}

/** Rejects a numeric combat score only after a strict higher-priority loss. */
function numericCombatEvaluationCanBeat(evaluation, incumbentScore) {
  if (!incumbentScore) return true;
  const candidate = {
    fulfillment: evaluation.allWaveTargetFulfillmentProbability,
    sunk: evaluation.expectedSunkCount,
    hpDamage: evaluation.expectedHpDamage,
    damage: evaluation.expectedDamage,
    loss: -evaluation.expectedOwnSlotLoss,
    resource: -evaluation.expectedResourceCost,
  };
  for (const field of ['fulfillment', 'sunk', 'hpDamage', 'damage', 'loss', 'resource']) {
    if (candidate[field] !== incumbentScore[field]) {
      return candidate[field] > incumbentScore[field];
    }
  }
  return true;
}

/** Orders branches for early useful incumbents without deleting any group. */
function orderedGroups(groups) {
  return groups.map((_group, index) => index).sort((left, right) => {
    const leftGroup = groups[left];
    const rightGroup = groups[right];
    const leftUtility = leftGroup.damagePower + 4 * leftGroup.slotAirPower;
    const rightUtility = rightGroup.damagePower + 4 * rightGroup.slotAirPower;
    return rightUtility - leftUtility ||
      Number(rightGroup.representative.isAttacker === true) -
      Number(leftGroup.representative.isAttacker === true) ||
      (Number(rightGroup.representative.accuracy) || 0) -
        (Number(leftGroup.representative.accuracy) || 0) ||
      rightGroup.damagePower - leftGroup.damagePower ||
      rightGroup.slotAirPower - leftGroup.slotAirPower ||
      leftGroup.key.localeCompare(rightGroup.key);
  });
}

/** Maps selected group counts to unique concrete inventory instances. */
function materializeConcreteLoadouts(selectedCounts, prepared) {
  const cursors = prepared.groups.map(() => 0);
  return selectedCounts.map((counts, baseIndex) => {
    const lock = prepared.baseLocks[baseIndex];
    const loadout = lock.slots.map((slot) =>
      slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
    const selected = [];
    counts.forEach((count, groupIndex) => {
      for (let index = 0; index < count; index += 1) {
        selected.push(prepared.groups[groupIndex].instances[cursors[groupIndex]++]);
      }
    });
    let selectedIndex = 0;
    lock.slots.forEach((slot, slotIndex) => {
      if (slot.kind === SLOT_KINDS.OPEN) loadout[slotIndex] = selected[selectedIndex++] || null;
    });
    return loadout;
  });
}

/** Reserves one base's grouped inventory counts. */
function subtractCounts(remaining, selected) {
  selected.forEach((count, index) => { remaining[index] -= count; });
}

/** Releases one base's grouped inventory counts. */
function restoreCounts(remaining, selected) {
  selected.forEach((count, index) => { remaining[index] += count; });
}

/** Returns exact range from incrementally maintained base features. */
function effectiveRadiusForSearchState(planeCount, naturalRadius, reconRadius, blocksRange) {
  if (!planeCount) return 0;
  if (blocksRange || reconRadius <= naturalRadius) return naturalRadius;
  return Math.round(naturalRadius + Math.min(Math.sqrt(reconRadius - naturalRadius), 3));
}

/** Relaxes slot-air choices and recon multiplier independently for a safe air ceiling. */
function maximumRelaxedBaseAir(
  selectedRawAir,
  selectedReconCoefficient,
  selected,
  relaxedAirSuffixes,
  startOrderIndex,
  openSlots,
) {
  let coefficient = selectedReconCoefficient;
  let availableAir = 0;
  let availableCount = 0;
  if (openSlots > 0) {
    const suffix = relaxedAirSuffixes[startOrderIndex];
    coefficient = Math.max(coefficient, suffix.maximumReconCoefficient);
    for (let tokenIndex = 0;
      tokenIndex < suffix.topAirTokens.length && availableCount < openSlots;
      tokenIndex += 1) {
      const token = suffix.topAirTokens[tokenIndex];
      let earlierCopies = 0;
      for (let earlierIndex = 0; earlierIndex < tokenIndex; earlierIndex += 1) {
        if (suffix.topAirTokens[earlierIndex].groupIndex === token.groupIndex) {
          earlierCopies += 1;
        }
      }
      if (earlierCopies < selected[token.groupIndex]) continue;
      availableAir += token.air;
      availableCount += 1;
    }
  }
  const rawAir = selectedRawAir + availableAir;
  return Math.floor(rawAir * coefficient);
}

/** Precompiles each canonical suffix's strongest slot-air tokens and recon coefficient. */
function buildRelaxedAirSuffixes(groups, groupOrder, remainingCounts, openSlots) {
  const maximumTokens = Math.max(0, openSlots * 2);
  const suffixes = Array(groupOrder.length + 1);
  suffixes[groupOrder.length] = {
    maximumReconCoefficient: 1,
    topAirTokens: [],
  };
  for (let orderIndex = groupOrder.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const groupIndex = groupOrder[orderIndex];
    const group = groups[groupIndex];
    const copies = Math.min(maximumTokens, Math.max(0, remainingCounts[groupIndex]));
    const added = Array.from({ length: copies }, () => ({
      air: group.slotAirPower,
      groupIndex,
    }));
    const next = suffixes[orderIndex + 1];
    suffixes[orderIndex] = {
      maximumReconCoefficient: Math.max(
        next.maximumReconCoefficient,
        copies ? landReconCoefficient([group.representative]) : 1,
      ),
      topAirTokens: next.topAirTokens.concat(added)
        .sort((left, right) => right.air - left.air || left.groupIndex - right.groupIndex)
        .slice(0, maximumTokens),
    };
  }
  return suffixes;
}

/** Bounds sinks by living targets and one attack per attacker in each dispatched wave. */
function maximumSinkCount(loadouts, prepared) {
  const attackCount = loadouts.reduce((total, loadout) => total +
    loadout.filter(isLbasCombatAttacker).length * 2, 0);
  const enemies = prepared.enemyFleets || (prepared.enemy ? [prepared.enemy] : []);
  const livingShipCount = enemies.reduce((total, enemy) => total +
    (enemy.ships || []).filter((ship) => Number(ship.currentHp ?? ship.hp) > 0).length, 0);
  return Math.min(attackCount, livingShipCount);
}

/** Creates immutable fleet metadata and a lazy single-aircraft contribution cache. */
function createFixedCombatBoundContext(prepared, hitDrawsByWave, stats) {
  const enemies = prepared.enemyFleets || (prepared.enemy ? [prepared.enemy] : []);
  const fleetProfiles = enemies.map((enemy) => {
    const ships = (enemy.ships || []).filter((ship) => Number(ship.currentHp ?? ship.hp) > 0);
    const hitPoints = ships
      .map((ship) => Number(ship.currentHp ?? ship.hp) || 0)
      .filter((hp) => hp > 0)
      .sort((left, right) => left - right);
    return {
      ships,
      hitPoints,
      totalHp: hitPoints.reduce((total, hp) => total + hp, 0),
      isCombined: Number(enemy.battleType) === 2 ||
        ships.some((ship) => ship.fleet === 'escort'),
    };
  });
  return {
    prepared,
    hitDrawsByWave,
    fleetProfiles,
    sampleCount: prepared.simulationOptions.sampleCount,
    separate: prepared.simulationOptions.dispatchMode === 'separate',
    contributionCache: new Map(),
    baseContributionCaches: Array.from({ length: prepared.baseCount }, () => new Map()),
    sunkScratch: new Uint16Array(prepared.simulationOptions.sampleCount),
    hpDamageScratch: new Float64Array(prepared.simulationOptions.sampleCount),
    stats,
  };
}

/** Bounds fixed-sample sinks and HP damage with perfect targeting and no aircraft losses. */
function maximumFixedSampleCombatScore(
  loadouts,
  context,
  baseCacheKeys = [],
  incumbentScore = null,
) {
  const { sampleCount, separate, fleetProfiles } = context;
  const contributions = loadouts.map((loadout, baseIndex) =>
    fixedCombatBaseContribution(
      context,
      loadout,
      baseIndex,
      baseCacheKeys[baseIndex],
    ));
  let aggregateSinkNumerator = 0;
  let aggregateHpDamageNumerator = 0;
  fleetProfiles.forEach((fleet, enemyIndex) => {
    let totalHits = 0;
    let totalDamage = 0;
    for (const contribution of contributions) {
      totalHits += contribution.totalHitsByFleet[enemyIndex];
      totalDamage += contribution.totalDamageByFleet[enemyIndex];
    }
    aggregateSinkNumerator += Math.min(
      fleet.hitPoints.length * sampleCount,
      totalHits,
      Math.ceil(totalDamage / (fleet.hitPoints[0] ?? Infinity)),
    );
    aggregateHpDamageNumerator += Math.min(fleet.totalHp * sampleCount, totalDamage);
  });
  const aggregateSunk = aggregateSinkNumerator / sampleCount;
  const aggregateHpDamage = aggregateHpDamageNumerator / sampleCount;
  if (incumbentScore && (aggregateSunk < incumbentScore.sunk || (
    aggregateSunk === incumbentScore.sunk && aggregateHpDamage < incumbentScore.hpDamage
  ))) {
    return {
      sunk: aggregateSunk,
      hpDamage: aggregateHpDamage,
      remainingSunk: null,
      remainingHpDamage: null,
      samplesEvaluated: 0,
      aggregatePruned: true,
    };
  }
  let totalSinks = 0;
  let totalHpDamage = 0;
  const sunkBySample = context.sunkScratch;
  const hpDamageBySample = context.hpDamageScratch;

  if (fleetProfiles.length === 1) {
    const fleet = fleetProfiles[0];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      let hits = 0;
      let damage = 0;
      for (const contribution of contributions) {
        hits += contribution.hitsByFleet[0][sample];
        damage += contribution.damageByFleet[0][sample];
      }
      const hpDamage = Math.min(fleet.totalHp, damage);
      const sinks = maximumSinksForDamage(hits, hpDamage, fleet.hitPoints);
      sunkBySample[sample] = sinks;
      hpDamageBySample[sample] = hpDamage;
      totalHpDamage += hpDamage;
      totalSinks += sinks;
    }
  } else {
    const hits = new Uint16Array(fleetProfiles.length);
    const damage = new Float64Array(fleetProfiles.length);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      hits.fill(0);
      damage.fill(0);
      let sampleSinks = 0;
      let sampleHpDamage = 0;
      for (const contribution of contributions) {
        fleetProfiles.forEach((_fleet, enemyIndex) => {
          hits[enemyIndex] += contribution.hitsByFleet[enemyIndex][sample];
          damage[enemyIndex] += contribution.damageByFleet[enemyIndex][sample];
        });
      }
      fleetProfiles.forEach((fleet, enemyIndex) => {
        const hpDamage = Math.min(fleet.totalHp, damage[enemyIndex]);
        const sinks = maximumSinksForDamage(hits[enemyIndex], hpDamage, fleet.hitPoints);
        sampleHpDamage += hpDamage;
        sampleSinks += sinks;
        totalHpDamage += hpDamage;
        totalSinks += sinks;
      });
      sunkBySample[sample] = sampleSinks;
      hpDamageBySample[sample] = sampleHpDamage;
    }
  }
  const sunk = totalSinks / sampleCount;
  const hpDamage = totalHpDamage / sampleCount;
  const canReachIncumbent = !incumbentScore || sunk > incumbentScore.sunk || (
    sunk === incumbentScore.sunk && hpDamage >= incumbentScore.hpDamage
  );
  let remainingSunk = null;
  let remainingHpDamage = null;
  if (canReachIncumbent) {
    remainingSunk = new Float64Array(sampleCount + 1);
    remainingHpDamage = new Float64Array(sampleCount + 1);
    for (let sample = sampleCount - 1; sample >= 0; sample -= 1) {
      remainingSunk[sample] = remainingSunk[sample + 1] + sunkBySample[sample];
      remainingHpDamage[sample] = remainingHpDamage[sample + 1] + hpDamageBySample[sample];
    }
  }
  return {
    sunk,
    hpDamage,
    remainingSunk,
    remainingHpDamage,
    samplesEvaluated: sampleCount,
    aggregatePruned: false,
  };
}

/** Aggregates one base's fixed-sample optimistic attacks for reuse across sibling leaves. */
function fixedCombatBaseContribution(context, loadout, baseIndex, suppliedCacheKey) {
  const cache = context.baseContributionCaches[baseIndex];
  const cacheKey = suppliedCacheKey ?? combatBaseCacheKey(loadout);
  const cached = cache.get(cacheKey);
  if (cached) {
    context.stats.fixedCombatBaseContributionCacheHits += 1;
    return cached;
  }
  context.stats.fixedCombatBaseContributionCacheMisses += 1;
  const hitsByFleet = context.fleetProfiles.map(() => new Uint16Array(context.sampleCount));
  const damageByFleet = context.fleetProfiles.map(() => new Float64Array(context.sampleCount));
  const totalHitsByFleet = new Float64Array(context.fleetProfiles.length);
  const totalDamageByFleet = new Float64Array(context.fleetProfiles.length);
  const planes = canonicalCombatPlanesForBound(loadout);
  const reconModifier = landBasedReconDamageModifier(planes);
  const attackers = planes.filter(isLbasCombatAttacker);
  for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
    const waveIndex = baseIndex * 2 + waveInBase;
    const enemyIndex = context.separate ? waveInBase : 0;
    const hitMatrix = attackers.map((plane) => attackers.map((_unused, attackIndex) =>
      fixedCombatAttackContribution(
        context,
        plane,
        reconModifier,
        attackIndex,
        waveIndex,
        enemyIndex,
      ).hits));
    const damageMatrix = attackers.map((plane) => attackers.map((_unused, attackIndex) =>
      fixedCombatAttackContribution(
        context,
        plane,
        reconModifier,
        attackIndex,
        waveIndex,
        enemyIndex,
      ).damage));
    for (let sample = 0; sample < context.sampleCount; sample += 1) {
      const hits = maximumCoordinateAssignment(hitMatrix, sample);
      const damage = maximumCoordinateAssignment(damageMatrix, sample);
      hitsByFleet[enemyIndex][sample] += hits;
      damageByFleet[enemyIndex][sample] += damage;
      totalHitsByFleet[enemyIndex] += hits;
      totalDamageByFleet[enemyIndex] += damage;
    }
  }
  const aggregate = {
    hitsByFleet,
    damageByFleet,
    totalHitsByFleet,
    totalDamageByFleet,
  };
  if (cache.size >= FIXED_COMBAT_BASE_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(cacheKey, aggregate);
  return aggregate;
}

/** Returns cached optimistic hit and damage vectors for one fixed attack coordinate. */
function fixedCombatAttackContribution(
  context,
  plane,
  reconModifier,
  attackIndex,
  waveIndex,
  enemyIndex,
) {
  const key = JSON.stringify([
    aircraftEquivalenceKey(plane),
    reconModifier,
    attackIndex,
    waveIndex,
    enemyIndex,
  ]);
  const cached = context.contributionCache.get(key);
  if (cached) {
    context.stats.fixedCombatContributionCacheHits += 1;
    return cached;
  }
  context.stats.fixedCombatContributionCacheMisses += 1;
  const fleet = context.fleetProfiles[enemyIndex];
  const currentSlot = Number(
    plane.currentSlot ?? plane.slotSize ?? defaultSlotSizeForPlane(plane),
  ) || 0;
  const targets = fleet.ships.map((target) => {
    const probabilities = calculateHitAndCriticalProbabilities(plane, target, {
      isCombined: fleet.isCombined,
      proficiencyBoundary: context.prepared.simulationOptions.proficiencyBoundary,
    });
    const attackPower = calculatePlaneTargetAttackPower(plane, target, {
      currentSlot,
      combatContext: context.prepared.combatContext,
      reconModifier,
      isCombined: fleet.isCombined,
      aswPowerRoll: 1,
      specialPostCapRoll: 0,
      contactMultiplier: 1.2,
    });
    const hp = Math.max(0, Number(target.currentHp ?? target.hp) || 0);
    const armor = Math.max(0, Number(target.armor) || 0);
    return {
      hitProbability: probabilities.hitProbability,
      criticalProbability: probabilities.criticalProbability,
      normalDamage: maximumArmorDamage(attackPower, hp, armor),
      criticalDamage: maximumArmorDamage(
        Math.floor(attackPower * probabilities.criticalDamageMultiplier),
        hp,
        armor,
      ),
    };
  });
  const hits = new Uint8Array(context.sampleCount);
  const damage = new Float64Array(context.sampleCount);
  let totalHits = 0;
  let totalDamage = 0;
  const draws = context.hitDrawsByWave[waveIndex][attackIndex];
  for (let sample = 0; sample < context.sampleCount; sample += 1) {
    const draw = draws[sample];
    let maximumDamage = 0;
    for (const target of targets) {
      if (draw > target.hitProbability) continue;
      hits[sample] = 1;
      maximumDamage = Math.max(
        maximumDamage,
        draw <= target.criticalProbability ? target.criticalDamage : target.normalDamage,
      );
    }
    damage[sample] = maximumDamage;
    totalHits += hits[sample];
    totalDamage += maximumDamage;
  }
  const contribution = { hits, damage, totalHits, totalDamage };
  context.contributionCache.set(key, contribution);
  return contribution;
}

/** Reproduces the simulator's stable attack coordinates without resolving combat. */
function canonicalCombatPlanesForBound(loadout) {
  return loadout
    .map((plane, sourceIndex) => plane ? {
      plane,
      sourceIndex,
      key: aircraftEquivalenceKey(plane),
    } : null)
    .filter(Boolean)
    .sort((left, right) => left.key.localeCompare(right.key) || left.sourceIndex - right.sourceIndex)
    .map((entry) => entry.plane);
}

/** Preloads the fixed combat-hit coordinates shared by every optimistic leaf bound. */
function prepareFixedCombatHitDraws(prepared) {
  const sampleCount = prepared.simulationOptions.sampleCount;
  const fixedRandom = prepared.simulationOptions.fixedRandom;
  return Array.from({ length: prepared.baseCount * 2 }, (_, waveIndex) =>
    Array.from({ length: 4 }, (_, attackIndex) => {
      const draws = new Float64Array(sampleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        draws[sample] = clampUnit(fixedRandom(
          sample,
          waveIndex,
          'combat-hit',
          attackIndex,
          0,
        ));
      }
      return draws;
    }));
}

/** Returns the maximum HP loss allowed by minimum armor and maximum scratch rolls. */
function maximumArmorDamage(power, currentHp, armor) {
  let damage = Math.floor(power - 0.7 * armor);
  if (damage <= 0 && currentHp > 0) {
    damage = Math.floor(currentHp * 0.06 + 0.08 * Math.max(0, currentHp - 1));
  }
  return Math.min(currentHp, Math.max(0, damage));
}

/** Converts optimistic hit and damage totals into the most ships they could sink. */
function maximumSinksForDamage(hitCount, damage, sortedHitPoints) {
  let consumed = 0;
  let sinks = 0;
  for (const hp of sortedHitPoints) {
    if (sinks >= hitCount || consumed + hp > damage) break;
    consumed += hp;
    sinks += 1;
  }
  return sinks;
}

/** Clamps a deterministic combat draw to the half-open unit interval. */
function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, 1 - Number.EPSILON);
}

module.exports = { solveCombatExact };
