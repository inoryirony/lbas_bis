'use strict';

const { requiredAirForState } = require('./air-power');
const {
  createDetailedDamageBoundContext,
  createDetailedScoreContext,
  evaluateDetailedPlanScore,
  maximumDetailedExpectedDamage,
} = require('./wave-simulator');
const {
  canonicalPlanKey,
  comparePlanScores,
  scorePlan,
  summarizePlan,
} = require('./search-score');
const {
  createBaseContext,
  enumerateBase,
  featureForGroup,
  solveStaticExact,
} = require('./static-exact-solver');

const SLOT_KINDS = Object.freeze({
  LOCKED_ITEM: 'LOCKED_ITEM',
  OPEN: 'OPEN',
});

/** Solves a rank-one fixed-sample detailed search from reusable per-base frontiers. */
function solveDetailedExact(prepared, solverOptions = {}) {
  validatePrepared(prepared);
  const startedAt = Date.now();
  const stats = {
    backend: 'detailed-frontier',
    status: 'undefined',
    nodesExplored: 0,
    candidatesByBase: [],
    combinationsEvaluated: 0,
    prefixEvaluations: 0,
    simulationSamplesEvaluated: 0,
    damageUpperBoundEvaluations: 0,
    numericScoreEvaluations: 0,
    dynamicAirBoundEvaluations: 0,
    prefixDamageBoundEvaluations: 0,
    prefixCandidatesEvaluated: 0,
    prefixTrajectorySimulations: 0,
    prefixStateSignatureProbes: 0,
    prefixDamageContributionSimulations: 0,
    trajectoryCount: 0,
    suffixCandidatesEvaluated: 0,
    suffixTrajectorySimulations: 0,
    suffixStateSignatureProbes: 0,
    suffixDamageContributionSimulations: 0,
    elapsedMs: 0,
  };
  const work = createWorkController(prepared, solverOptions, stats, startedAt);
  const damageBoundContext = createDetailedDamageBoundContext({
    combatContext: prepared.combatContext,
    ...prepared.simulationOptions,
  });
  const scoreContext = createDetailedScoreContext({
    baseCount: prepared.baseCount,
    combatContext: prepared.combatContext,
    enemy: prepared.enemy,
    enemyFleets: prepared.enemyFleets,
    targetStates: prepared.waveTargets,
    ...prepared.simulationOptions,
  });
  solverOptions.onPhaseChange?.('finding_feasible');

  let incumbent = buildStaticSeed(prepared, work);
  if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason, incumbent);
  if (incumbent) {
    stats.numericScoreEvaluations += 1;
    stats.simulationSamplesEvaluated +=
      incumbent.simulation?.samplesEvaluated || prepared.simulationOptions.sampleCount;
  }
  if (incumbent?.allWaveTargetFulfillmentProbability === 1) {
    solverOptions.onIncumbent?.(
      incumbent,
      progressSnapshot(work, 'improving', startedAt),
    );
    if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason, incumbent);
    solverOptions.onPhaseChange?.('proving_optimal');
    const refined = refineStaticSeed(incumbent, prepared, work, stats);
    if (refined && comparePlanScores(refined, incumbent) > 0) {
      incumbent = refined;
      solverOptions.onIncumbent?.(
        incumbent,
        progressSnapshot(work, 'improving', startedAt),
      );
    }
  } else {
    return stoppedResult(stats, startedAt, 'no_full_fulfillment_seed', incumbent);
  }
  if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason, incumbent);

  const features = prepared.groups.map((group, groupIndex) =>
    featureForGroup(group, groupIndex, prepared.inventoryCounts, prepared.combatContext));
  const contexts = prepared.baseLocks.map((lock, baseIndex) => {
    const context = createBaseContext(prepared, lock, baseIndex, features);
    if (baseIndex === 0) {
      context.requiredAir = requiredAirForState(
        prepared.enemyAir,
        prepared.waveTargets[0],
      );
      context.targetState = prepared.waveTargets[0];
    } else {
      context.requiredAir = 0;
      context.targetState = 'none';
    }
    return context;
  });
  const maximumStaticDamage = [];
  for (const context of contexts) {
    const result = enumerateBase(context, work, { findMaximum: true });
    maximumStaticDamage.push(result.maximumDamage);
    if (work.stopped) break;
  }
  if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason, incumbent);

  const incumbentDamage = scorePlan(incumbent).damage;
  const candidateSets = [];
  for (let baseIndex = 0; baseIndex < contexts.length; baseIndex += 1) {
    const context = contexts[baseIndex];
    const otherUpper = maximumStaticDamage.reduce(
      (total, value, index) => index === baseIndex ? total : total + 2 * value,
      0,
    );
    const minimumStaticDamage = (incumbentDamage - otherUpper) / 2;
    const enumerated = enumerateBase(context, work, { minimumDamage: minimumStaticDamage });
    const candidates = [];
    for (const candidate of enumerated.candidates) {
      if (!work.checkStop()) break;
      const preparedCandidate = prepareCandidate(
        candidate,
        baseIndex,
        prepared,
        damageBoundContext,
      );
      stats.damageUpperBoundEvaluations += 1;
      if (preparedCandidate.maximumDamage + otherUpper >= incumbentDamage) {
        candidates.push(preparedCandidate);
      }
    }
    candidates.sort(compareDetailedCandidates);
    stats.candidatesByBase[baseIndex] = candidates.length;
    emitProgress(solverOptions, work, 'proving_optimal', startedAt);
    candidateSets.push(candidates);
    if (work.stopped) break;
  }
  if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason, incumbent);

  if (prepared.baseCount === 2) {
    incumbent = combineTwoBaseTrajectories(
      candidateSets,
      prepared,
      work,
      stats,
      scoreContext,
      incumbent,
      solverOptions,
      startedAt,
    );
    stats.candidatesEvaluated = stats.combinationsEvaluated + stats.prefixCandidatesEvaluated;
    if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason, incumbent);
    return finishedResult(incumbent, stats, startedAt);
  }

  const selected = Array(prepared.baseCount).fill(null);
  const used = new Uint16Array(prepared.groups.length);
  const maximumDamageSuffix = Array(prepared.baseCount + 1).fill(0);
  for (let baseIndex = prepared.baseCount - 1; baseIndex >= 0; baseIndex -= 1) {
    maximumDamageSuffix[baseIndex] = maximumDamageSuffix[baseIndex + 1] +
      (candidateSets[baseIndex][0]?.maximumDamage || 0);
  }

  function visit(baseIndex, requiredAir = 0, prefixDamage = 0) {
    if (!work.consume()) return;
    if (baseIndex === prepared.baseCount) {
      stats.combinationsEvaluated += 1;
      const loadouts = materializeLoadouts(selected, prepared);
      if (canonicalPlanKey({ bases: loadouts.map((loadout) => ({ loadout })) }) ===
          incumbent.canonicalKey) return;
      const evaluation = evaluateDetailedPlanScore({
        bases: loadouts,
        baseCacheKeys: selected.map((candidate) => candidate.key),
        enemy: prepared.enemy,
        enemyFleets: prepared.enemyFleets,
        targetStates: prepared.waveTargets,
        combatContext: prepared.combatContext,
        scoreContext,
        ...prepared.simulationOptions,
        incumbentScore: scorePlan(incumbent),
      });
      stats.numericScoreEvaluations += 1;
      stats.simulationSamplesEvaluated +=
        evaluation.samplesEvaluated || prepared.simulationOptions.sampleCount;
      if (evaluation.prunedBySimulationBound) return;
      const plan = summarizePlan(loadouts, {
        ...prepared,
        simulationOptions: {
          ...prepared.simulationOptions,
          incumbentScore: scorePlan(incumbent),
        },
      });
      stats.simulationSamplesEvaluated +=
        plan.simulation?.samplesEvaluated || prepared.simulationOptions.sampleCount;
      if (!plan.prunedBySimulationBound && comparePlanScores(plan, incumbent) > 0) {
        incumbent = plan;
        solverOptions.onIncumbent?.(
          incumbent,
          progressSnapshot(work, 'proving_optimal', startedAt),
        );
      }
      return;
    }

    for (const candidate of candidateSets[baseIndex]) {
      if (!work.checkStop()) return;
      if (candidate.air < requiredAir) continue;
      if (prefixDamage + candidate.maximumDamage + maximumDamageSuffix[baseIndex + 1] <
          scorePlan(incumbent).damage) break;
      if (!reserveCandidate(candidate, used, prepared.groups)) continue;
      selected[baseIndex] = candidate;

      if (baseIndex < prepared.baseCount - 1) {
        const prefix = evaluatePrefix(
          materializeLoadouts(selected.slice(0, baseIndex + 1), prepared),
          prepared,
          baseIndex + 1,
          selected.slice(0, baseIndex + 1).map((candidate) => candidate.key),
          scoreContext,
        );
        stats.prefixEvaluations += 1;
        stats.dynamicAirBoundEvaluations += 1;
        stats.prefixDamageBoundEvaluations += 1;
        stats.numericScoreEvaluations += 1;
        stats.simulationSamplesEvaluated +=
          prefix.samplesEvaluated || prepared.simulationOptions.sampleCount;
        const prefixFeasible = prefix.allWaveTargetFulfillmentProbability === 1;
        const nextRequiredAir = prefixFeasible
          ? requiredAirAfterPrefix(prefix, prepared, baseIndex + 1)
          : Number.POSITIVE_INFINITY;
        if (prefixFeasible && candidateSets[baseIndex + 1].some((next) =>
          next.air >= nextRequiredAir)) {
          visit(baseIndex + 1, nextRequiredAir, prefix.expectedDamage);
        }
      } else {
        visit(baseIndex + 1, 0, prefixDamage);
      }

      selected[baseIndex] = null;
      releaseCandidate(candidate, used);
    }
  }

  visit(0);
  stats.candidatesEvaluated = stats.combinationsEvaluated +
    (prepared.baseCount > 1 ? 1 : 0);
  if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason, incumbent);
  return finishedResult(incumbent, stats, startedAt);
}

/** Proves a two-base optimum by reusing exact suffix scores for equal enemy trajectories. */
function combineTwoBaseTrajectories(
  candidateSets,
  prepared,
  work,
  stats,
  scoreContext,
  initialIncumbent,
  solverOptions,
  startedAt,
) {
  const sampleCount = prepared.simulationOptions.sampleCount;
  const trajectoryGroups = new Map();
  let incumbent = initialIncumbent;
  stats.prefixCandidatesTotal = candidateSets[0].length;
  stats.suffixCandidatesTotal = candidateSets[1].length;
  emitProgress(solverOptions, work, 'building_prefix_trajectories', startedAt);

  for (const candidate of candidateSets[0]) {
    if (!work.checkStop()) return incumbent;
    const evaluation = evaluateDetailedPlanScore({
      bases: [candidate.loadout],
      baseCacheKeys: [candidate.key],
      baseIndexOffset: 0,
      captureFinalEnemySlots: true,
      enemy: prepared.enemy,
      enemyFleets: prepared.enemyFleets,
      targetStates: prepared.waveTargets,
      combatContext: prepared.combatContext,
      scoreContext,
      ...prepared.simulationOptions,
    });
    stats.prefixCandidatesEvaluated += 1;
    stats.dynamicAirBoundEvaluations += 1;
    stats.prefixDamageBoundEvaluations += 1;
    stats.numericScoreEvaluations += 1;
    stats.simulationSamplesEvaluated +=
      evaluation.simulationWorkSamples ?? evaluation.samplesEvaluated ?? sampleCount;
    stats.prefixTrajectorySimulations += evaluation.enemyTrajectorySimulations ?? 1;
    stats.prefixStateSignatureProbes += evaluation.stateSignatureProbes ?? 1;
    stats.prefixDamageContributionSimulations +=
      evaluation.damageContributionSimulations ?? 0;
    if (evaluation.allWaveTargetFulfillmentProbability !== 1) continue;
    const trajectoryKey = enemyTrajectoryKey(evaluation.finalEnemySlotsBySample);
    const group = trajectoryGroups.get(trajectoryKey) || {
      enemySlotsBySample: evaluation.finalEnemySlotsBySample,
      prefixes: [],
    };
    group.prefixes.push({
      candidate,
      damageTotal: evaluation.totalDamageAcrossSamples,
    });
    trajectoryGroups.set(trajectoryKey, group);
    if ((stats.prefixCandidatesEvaluated & 255) === 0) {
      emitProgress(solverOptions, work, 'building_prefix_trajectories', startedAt);
    }
  }
  stats.trajectoryCount = trajectoryGroups.size;
  const initialIncumbentDamageTotal = Math.round(scorePlan(incumbent).damage * sampleCount);
  stats.suffixCandidatesTotal = [...trajectoryGroups.values()].reduce((total, group) => {
    const bestPrefixDamage = group.prefixes.reduce(
      (maximum, prefix) => Math.max(maximum, prefix.damageTotal),
      Number.NEGATIVE_INFINITY,
    );
    const firstExcluded = candidateSets[1].findIndex((candidate) =>
      bestPrefixDamage + Math.round(candidate.maximumDamage * sampleCount) <
        initialIncumbentDamageTotal);
    return total + (firstExcluded < 0 ? candidateSets[1].length : firstExcluded);
  }, 0);
  emitProgress(solverOptions, work, 'building_prefix_trajectories', startedAt);

  const used = new Uint16Array(prepared.groups.length);
  emitProgress(solverOptions, work, 'evaluating_suffix_trajectories', startedAt);
  for (const group of trajectoryGroups.values()) {
    if (!work.checkStop()) return incumbent;
    group.prefixes.sort((left, right) =>
      (right.damageTotal - left.damageTotal) ||
      compareDetailedCandidates(left.candidate, right.candidate));
    const bestPrefixDamage = group.prefixes[0]?.damageTotal || 0;
    let incumbentDamageTotal = Math.round(scorePlan(incumbent).damage * sampleCount);
    const suffixes = [];

    for (const candidate of candidateSets[1]) {
      if (!work.checkStop()) return incumbent;
      const candidateUpperTotal = Math.round(candidate.maximumDamage * sampleCount);
      if (bestPrefixDamage + candidateUpperTotal < incumbentDamageTotal) break;
      const evaluation = evaluateDetailedPlanScore({
        bases: [candidate.loadout],
        baseCacheKeys: [candidate.key],
        baseIndexOffset: 1,
        initialEnemySlotsBySample: group.enemySlotsBySample,
        enemy: prepared.enemy,
        enemyFleets: prepared.enemyFleets,
        targetStates: prepared.waveTargets,
        combatContext: prepared.combatContext,
        scoreContext,
        ...prepared.simulationOptions,
      });
      stats.suffixCandidatesEvaluated += 1;
      stats.numericScoreEvaluations += 1;
      stats.simulationSamplesEvaluated +=
        evaluation.simulationWorkSamples ?? evaluation.samplesEvaluated ?? sampleCount;
      stats.suffixTrajectorySimulations += evaluation.enemyTrajectorySimulations ?? 1;
      stats.suffixStateSignatureProbes += evaluation.stateSignatureProbes ?? 1;
      stats.suffixDamageContributionSimulations +=
        evaluation.damageContributionSimulations ?? 0;
      if (evaluation.allWaveTargetFulfillmentProbability === 1) {
        suffixes.push({
          candidate,
          damageTotal: evaluation.totalDamageAcrossSamples,
        });
      }
      if ((stats.suffixCandidatesEvaluated & 255) === 0) {
        emitProgress(solverOptions, work, 'evaluating_suffix_trajectories', startedAt);
      }
    }
    suffixes.sort((left, right) =>
      (right.damageTotal - left.damageTotal) ||
      compareDetailedCandidates(left.candidate, right.candidate));
    if (suffixes.length === 0) continue;

    for (const prefix of group.prefixes) {
      if (!work.checkStop()) return incumbent;
      incumbentDamageTotal = Math.round(scorePlan(incumbent).damage * sampleCount);
      if (prefix.damageTotal + suffixes[0].damageTotal < incumbentDamageTotal) break;
      if (!reserveCandidate(prefix.candidate, used, prepared.groups)) continue;
      for (const suffix of suffixes) {
        const combinedDamage = prefix.damageTotal + suffix.damageTotal;
        if (combinedDamage < incumbentDamageTotal) break;
        if (!reserveCandidate(suffix.candidate, used, prepared.groups)) continue;
        stats.combinationsEvaluated += 1;
        const loadouts = materializeLoadouts(
          [prefix.candidate, suffix.candidate],
          prepared,
        );
        const plan = summarizePlan(loadouts, prepared);
        stats.simulationSamplesEvaluated +=
          plan.simulation?.samplesEvaluated || sampleCount;
        if (comparePlanScores(plan, incumbent) > 0) {
          incumbent = plan;
          incumbentDamageTotal = Math.round(scorePlan(incumbent).damage * sampleCount);
          solverOptions.onIncumbent?.(
            incumbent,
            progressSnapshot(work, 'proving_optimal', startedAt),
          );
        }
        releaseCandidate(suffix.candidate, used);
      }
      releaseCandidate(prefix.candidate, used);
    }
    emitProgress(solverOptions, work, 'evaluating_suffix_trajectories', startedAt);
  }
  return incumbent;
}

/** Canonicalizes every fixed-sample enemy slot vector for exact transition reuse. */
function enemyTrajectoryKey(enemySlotsBySample) {
  return enemySlotsBySample
    .map((sample) => sample.map((enemy) => enemy.join(',')).join('/'))
    .join(';');
}

/** Re-optimizes later bases against the simulated remaining enemy air. */
function refineStaticSeed(seed, prepared, work, stats) {
  if (prepared.baseCount !== 2 || prepared.simulationOptions.dispatchMode === 'separate') {
    return seed;
  }
  const firstLoadout = seed.bases[0].loadout;
  const prefix = evaluatePrefix([firstLoadout], prepared, 1);
  stats.prefixEvaluations += 1;
  stats.dynamicAirBoundEvaluations += 1;
  stats.numericScoreEvaluations += 1;
  stats.simulationSamplesEvaluated +=
    prefix.samplesEvaluated || prepared.simulationOptions.sampleCount;
  if (prefix.allWaveTargetFulfillmentProbability !== 1 || !work.checkStop()) return seed;

  const usedIds = new Set(firstLoadout.filter(Boolean).map((plane) => plane.instanceId));
  const enemyAir = prefix.maximumFinalEnemyAir[0] || 0;
  const exact = solveStaticExact({
    equipment: prepared.equipment.filter((plane) => !usedIds.has(plane.instanceId)),
    baseCount: 1,
    targetRadius: prepared.targetRadius,
    enemyAir,
    targetStates: prepared.waveTargets.slice(2, 4),
    lockedBases: [prepared.baseLocks[1]],
    combatContext: prepared.combatContext,
    maxResults: 1,
    nodeBudget: Number.POSITIVE_INFINITY,
  }, {
    isCancelled: () => !work.checkStop(),
  });
  if (!exact.plan) return seed;
  const refined = summarizePlan(
    [firstLoadout, exact.plan.bases[0].loadout],
    prepared,
  );
  stats.simulationSamplesEvaluated +=
    refined.simulation?.samplesEvaluated || prepared.simulationOptions.sampleCount;
  return refined.allWaveTargetFulfillmentProbability === 1 ? refined : seed;
}

/** Builds a bounded feasible lower bound without delaying exact proof or cancellation. */
function buildStaticSeed(prepared, work) {
  const { buildStaticSeedCandidates } = require('./optimizer');
  const candidatesByBase = [];
  for (let baseIndex = 0; baseIndex < prepared.baseLocks.length; baseIndex += 1) {
    const candidates = buildStaticSeedCandidates(
      prepared.baseLocks[baseIndex],
      prepared,
      baseIndex,
      { isCancelled: () => !work.checkStop() },
    );
    candidatesByBase.push(candidates);
    if (work.stopped) return null;
  }
  if (candidatesByBase.some((candidates) => candidates.length === 0)) return null;

  const retained = [];
  const selected = [];
  const usedIds = new Set();
  const suffixDamage = Array(prepared.baseCount + 1).fill(0);
  for (let baseIndex = prepared.baseCount - 1; baseIndex >= 0; baseIndex -= 1) {
    suffixDamage[baseIndex] = suffixDamage[baseIndex + 1] +
      candidatesByBase[baseIndex][0].summary.damagePower;
  }
  let combinations = 0;

  function combine(baseIndex, damage) {
    if (!work.checkStop() || combinations >= 100000) return;
    if (retained.length >= 64 && damage + suffixDamage[baseIndex] < retained.at(-1).damage) {
      return;
    }
    if (baseIndex === prepared.baseCount) {
      retained.push({
        damage,
        loadouts: selected.map((candidate) => candidate.loadout),
      });
      retained.sort((left, right) => right.damage - left.damage);
      if (retained.length > 64) retained.length = 64;
      return;
    }
    for (const candidate of candidatesByBase[baseIndex]) {
      combinations += 1;
      if (candidate.instanceIds.some((instanceId) => usedIds.has(instanceId))) continue;
      candidate.instanceIds.forEach((instanceId) => usedIds.add(instanceId));
      selected.push(candidate);
      combine(baseIndex + 1, damage + candidate.summary.damagePower);
      selected.pop();
      candidate.instanceIds.forEach((instanceId) => usedIds.delete(instanceId));
      if (!work.checkStop() || combinations >= 100000) return;
    }
  }

  combine(0, 0);
  let best = null;
  for (const candidate of retained) {
    if (!work.checkStop()) break;
    const plan = summarizePlan(candidate.loadouts, prepared);
    if (plan.allWaveTargetFulfillmentProbability === 1 &&
        (!best || comparePlanScores(plan, best) > 0)) best = plan;
  }
  return best;
}

/** Materializes one grouped base and calculates its strict no-loss damage bound once. */
function prepareCandidate(candidate, baseIndex, prepared, damageBoundContext) {
  const loadout = materializeSingleBase(candidate, baseIndex, prepared);
  return {
    ...candidate,
    key: candidate.pairs.map(([groupIndex, count]) => `${groupIndex}:${count}`).join(','),
    loadout,
    maximumDamage: maximumDetailedExpectedDamage({
      bases: [loadout],
      baseIndexOffset: baseIndex,
      damageBoundContext,
      combatContext: prepared.combatContext,
      ...prepared.simulationOptions,
    }),
  };
}

function compareDetailedCandidates(left, right) {
  return (right.maximumDamage - left.maximumDamage) ||
    (right.air - left.air) ||
    left.key.localeCompare(right.key);
}

/** Uses the exact prefix simulation's worst remaining enemy air as a necessary next-base bound. */
function requiredAirAfterPrefix(prefix, prepared, nextBaseIndex) {
  const waveIndex = nextBaseIndex * 2;
  const finalAir = prefix.simulation?.maximumFinalEnemyAir || [];
  if (prepared.simulationOptions.dispatchMode === 'separate') {
    return Math.max(...finalAir.map((air, enemyIndex) => requiredAirForState(
      air,
      prepared.waveTargets[waveIndex + enemyIndex] || prepared.waveTargets[waveIndex],
    )));
  }
  return requiredAirForState(
    finalAir[0] || 0,
    prepared.waveTargets[waveIndex] || prepared.waveTargets[0] || 'parity',
  );
}

function evaluatePrefix(
  loadouts,
  prepared,
  prefixBaseCount,
  baseCacheKeys = [],
  scoreContext = null,
) {
  return evaluateDetailedPlanScore({
    bases: loadouts,
    baseCacheKeys,
    enemy: prepared.enemy,
    enemyFleets: prepared.enemyFleets,
    targetStates: prepared.waveTargets.slice(0, prefixBaseCount * 2),
    combatContext: prepared.combatContext,
    scoreContext: scoreContext || undefined,
    ...prepared.simulationOptions,
  });
}

function reserveCandidate(candidate, used, groups) {
  for (const [groupIndex, count] of candidate.pairs) {
    if (used[groupIndex] + count > groups[groupIndex].instances.length) return false;
  }
  for (const [groupIndex, count] of candidate.pairs) used[groupIndex] += count;
  return true;
}

function releaseCandidate(candidate, used) {
  for (const [groupIndex, count] of candidate.pairs) used[groupIndex] -= count;
}

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

function materializeLoadouts(candidates, prepared) {
  const cursors = prepared.groups.map(() => 0);
  return candidates.map((candidate, baseIndex) => {
    const lock = prepared.baseLocks[baseIndex];
    const loadout = lock.slots.map((slot) =>
      slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
    const selected = [];
    for (const [groupIndex, count] of candidate.pairs) {
      const group = prepared.groups[groupIndex];
      selected.push(...group.instances.slice(cursors[groupIndex], cursors[groupIndex] + count));
      cursors[groupIndex] += count;
    }
    let cursor = 0;
    lock.slots.forEach((slot, slotIndex) => {
      if (slot.kind === SLOT_KINDS.OPEN) loadout[slotIndex] = selected[cursor++] || null;
    });
    return loadout;
  });
}

function createWorkController(prepared, solverOptions, stats, startedAt) {
  const nodeBudget = prepared.budget;
  return {
    stats,
    reason: null,
    stopped: false,
    checkStop() {
      if (prepared.isCancelled?.() || solverOptions.isCancelled?.()) {
        this.stopped = true;
        this.reason = 'cancelled';
      }
      return !this.stopped;
    },
    consume() {
      if (this.stopped) return false;
      if (stats.nodesExplored >= nodeBudget) {
        this.stopped = true;
        this.reason = 'node_budget';
        return false;
      }
      stats.nodesExplored += 1;
      if ((stats.nodesExplored & 4095) === 0) {
        solverOptions.onProgress?.(progressSnapshot(this, 'proving_optimal', startedAt));
        return this.checkStop();
      }
      return true;
    },
  };
}

function emitProgress(solverOptions, work, phase, startedAt) {
  solverOptions.onProgress?.(progressSnapshot(work, phase, startedAt));
}

function progressSnapshot(work, phase, startedAt) {
  let completedWork = null;
  let totalWork = null;
  if (phase === 'building_prefix_trajectories') {
    completedWork = work.stats?.prefixCandidatesEvaluated ?? 0;
    totalWork = work.stats?.prefixCandidatesTotal ?? null;
  } else if (phase === 'evaluating_suffix_trajectories') {
    completedWork = work.stats?.suffixCandidatesEvaluated ?? 0;
    totalWork = work.stats?.suffixCandidatesTotal == null
      ? null
      : work.stats.suffixCandidatesTotal;
  }
  return {
    phase,
    nodesExplored: work.stats?.nodesExplored ?? null,
    nodesPruned: work.stats?.nodesPruned ?? 0,
    candidatesEvaluated: work.stats?.combinationsEvaluated ?? null,
    simulationSamplesEvaluated: work.stats?.simulationSamplesEvaluated ?? null,
    elapsedMs: Date.now() - startedAt,
    completedWork,
    totalWork,
  };
}

function finishedResult(plan, stats, startedAt) {
  stats.status = plan ? 'optimal' : 'infeasible';
  stats.elapsedMs = Date.now() - startedAt;
  return { plan, provenOptimal: true, solverStats: stats };
}

function stoppedResult(stats, startedAt, reason, plan = null) {
  stats.status = reason === 'cancelled' ? 'cancelled' : 'not_optimal';
  stats.stopReason = reason;
  stats.elapsedMs = Date.now() - startedAt;
  return { plan, provenOptimal: false, solverStats: stats };
}

function validatePrepared(prepared) {
  if (!prepared?.valid || !prepared.detailed || prepared.maxResults !== 1) {
    throw new Error('Detailed exact solver requires a valid rank-one detailed search.');
  }
}

module.exports = { solveDetailedExact };
