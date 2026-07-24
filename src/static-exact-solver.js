'use strict';

const {
  calculateSlotAirPower,
  defaultSlotSizeForPlane,
  landReconCoefficient,
  requiredAirForState,
} = require('./air-power');
const { aircraftEquivalenceKey, capabilitiesFor } = require('./aircraft');
const {
  calculatePlaneSurfaceTargetPowerProxy,
  landBasedReconDamageModifier,
} = require('./damage');
const { prepareSearch } = require('./optimizer');
const {
  comparePlanScores,
  summarizePlan,
  targetStateForBase,
} = require('./search-score');

const SLOT_KINDS = Object.freeze({
  LOCKED_ITEM: 'LOCKED_ITEM',
  LOCKED_EMPTY: 'LOCKED_EMPTY',
  OPEN: 'OPEN',
});
const AIR_COEFFICIENTS = Object.freeze([1, 1.15, 1.18]);
const DAMAGE_COEFFICIENTS = Object.freeze([1, 1.125, 1.15]);
const DEFAULT_SEED_LIMIT = 2500;
const DEFAULT_SEED_COMBINATION_LIMIT = 3000000;

/** Solves one static rank-1 LBAS problem by exact base-frontier enumeration. */
function solveStaticExact(preparedOrOptions = {}, solverOptions = {}) {
  const startedAt = Date.now();
  const prepared = isPreparedSearch(preparedOrOptions)
    ? preparedOrOptions
    : prepareSearch({ ...preparedOrOptions, maxResults: 1 });
  validatePrepared(prepared);

  const stats = {
    backend: 'frontier-dp',
    status: 'undefined',
    groupsBefore: prepared.groups.length,
    groupsAfter: 0,
    groupsRemoved: 0,
    nodesExplored: 0,
    candidatesByBase: [],
    combinationsEvaluated: 0,
    elapsedMs: 0,
  };
  const work = createWorkController(prepared, solverOptions, stats, startedAt);
  if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason);
  solverOptions.onPhaseChange?.('finding_feasible');
  const allFeatures = prepared.groups.map((group, groupIndex) =>
    featureForGroup(
      group,
      groupIndex,
      prepared.inventoryCounts,
      prepared.combatContext,
    ));
  const openCapacity = prepared.baseLocks.reduce(
    (total, lock) => total + lock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length,
    0,
  );
  const features = removeCapacityDominatedGroups(allFeatures, openCapacity);
  stats.groupsAfter = features.length;
  stats.groupsRemoved = allFeatures.length - features.length;

  const baseContexts = prepared.baseLocks.map((lock, baseIndex) =>
    createBaseContext(prepared, lock, baseIndex, features));
  const maximumDamageByBase = [];
  for (const context of baseContexts) {
    const result = enumerateBase(context, work, { findMaximum: true });
    if (work.stopped) return stoppedResult(stats, startedAt, work.reason);
    if (!result.feasible) {
      if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason);
      return finishedResult(null, true, stats, startedAt, 'infeasible');
    }
    maximumDamageByBase.push(result.maximumDamage);
    emitProgress(solverOptions, work, 'finding_feasible', startedAt);
  }
  stats.maximumDamageByBase = maximumDamageByBase;

  let incumbent = solverOptions.incumbent || null;
  if (!incumbent) {
    incumbent = findSeedPlan(baseContexts, maximumDamageByBase, prepared, work, solverOptions);
  }
  if (work.stopped) return stoppedResult(stats, startedAt, work.reason, incumbent);

  if (!incumbent) {
    const exactFallback = features.length <= 32;
    if (!exactFallback) return stoppedResult(stats, startedAt, 'no_incumbent');
    const everyCandidate = baseContexts.map((context) =>
      enumerateBase(context, work, { minimumDamage: Number.NEGATIVE_INFINITY }).candidates);
    incumbent = combineCandidateSets(everyCandidate, prepared, work, null).plan;
    if (!incumbent) {
      if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason);
      return finishedResult(null, true, stats, startedAt, 'infeasible');
    }
  }

  const incumbentDamage = incumbent.totalDamagePower;
  solverOptions.onPhaseChange?.('proving_optimal');
  const exactCandidateSets = baseContexts.map((context, baseIndex) => {
    const otherUpper = maximumDamageByBase.reduce(
      (total, value, index) => index === baseIndex ? total : total + value,
      0,
    );
    const minimumDamage = incumbentDamage - otherUpper;
    const result = enumerateBase(context, work, { minimumDamage });
    stats.candidatesByBase[baseIndex] = result.candidates.length;
    emitProgress(solverOptions, work, 'proving_optimal', startedAt);
    return result.candidates;
  });
  if (!work.checkStop()) return stoppedResult(stats, startedAt, work.reason, incumbent);
  if (exactCandidateSets.some((candidates) => candidates.length === 0)) {
    return finishedResult(incumbent, true, stats, startedAt, 'optimal');
  }

  const combined = combineCandidateSets(exactCandidateSets, prepared, work, incumbent);
  if (!work.checkStop()) {
    return stoppedResult(stats, startedAt, work.reason, combined.plan || incumbent);
  }
  if (combined.plan && comparePlanScores(combined.plan, incumbent) > 0) {
    solverOptions.onIncumbent?.(combined.plan, progressSnapshot(work, 'proving_optimal', startedAt));
  }
  return finishedResult(combined.plan || incumbent, true, stats, startedAt, 'optimal');
}

/** Enumerates every feasible base combination above a proven damage threshold. */
function enumerateBase(context, work, options = {}) {
  const {
    openSlots,
    requiredAir,
    targetRadius,
    targetState,
  } = context;
  const features = [...context.features].sort(compareEnumerationFeatures);
  const maximumSlots = openSlots;
  const suffixDamage = buildSuffixUpperBounds(features, maximumSlots, (feature) => feature.damage[2]);
  const suffixAir = buildSuffixUpperBounds(features, maximumSlots, (feature) => feature.air);
  const pairs = [];
  const candidates = [];
  const onCandidate = typeof options.onCandidate === 'function' ? options.onCandidate : null;
  const collectLimit = options.collectLimit ?? Number.POSITIVE_INFINITY;
  const candidateShardCount = Math.max(
    1,
    Math.floor(Number(options.candidateShardCount) || 1),
  );
  const candidateShardIndex = Math.floor(Number(options.candidateShardIndex) || 0);
  if (candidateShardIndex < 0 || candidateShardIndex >= candidateShardCount) {
    throw new RangeError('candidateShardIndex must select an existing candidate shard.');
  }
  let maximumDamage = Number.NEGATIVE_INFINITY;
  let feasible = false;
  let candidateCount = 0;
  let airBoundPrunes = 0;

  /** Enumerates grouped base assignments while applying damage and air upper bounds. */
  function visit(startIndex, slotsLeft, state, firstSelectedIndex = -1) {
    if (!work.consume()) return;
    const cutoff = options.findMaximum ? maximumDamage : options.minimumDamage;
    const optimisticDamage = state.damage[2] + suffixDamage[startIndex][slotsLeft];
    if (Number.isFinite(cutoff) && optimisticDamage < cutoff) return;
    const optimisticAir = Math.floor(
      (state.rawAir + suffixAir[startIndex][slotsLeft]) * AIR_COEFFICIENTS[2],
    );
    if (optimisticAir < requiredAir) {
      airBoundPrunes += 1;
      return;
    }
    const summary = summarizeState(state, requiredAir);
    if (isFeasibleSummary(summary, targetState, targetRadius)) {
      feasible = true;
      if (summary.damage > maximumDamage) maximumDamage = summary.damage;
      if (!options.findMaximum && summary.damage >= options.minimumDamage &&
          (firstSelectedIndex >= 0 || candidateShardIndex === 0)) {
        const candidate = candidateFromState(pairs, summary);
        candidateCount += 1;
        if (onCandidate) {
          onCandidate(candidate);
        } else {
          candidates.push(candidate);
          trimSeedCandidates(candidates, collectLimit);
        }
      }
    }
    if (slotsLeft === 0) return;

    for (let featureIndex = startIndex; featureIndex < features.length; featureIndex += 1) {
      const feature = features[featureIndex];
      const featureShardIndex = typeof options.candidateShardForFeature === 'function'
        ? options.candidateShardForFeature(feature, featureIndex)
        : featureIndex;
      if (firstSelectedIndex < 0 &&
          featureShardIndex % candidateShardCount !== candidateShardIndex) continue;
      const maximum = Math.min(slotsLeft, feature.count);
      for (let count = 1; count <= maximum; count += 1) {
        pairs.push([feature.groupIndex, count]);
        visit(
          featureIndex + 1,
          slotsLeft - count,
          addFeature(state, feature, count),
          firstSelectedIndex < 0 ? featureIndex : firstSelectedIndex,
        );
        pairs.pop();
        if (work.stopped) return;
      }
    }
  }

  visit(0, maximumSlots, context.lockedState);
  if (!onCandidate) {
    candidates.sort(compareBaseCandidates);
    if (Number.isFinite(collectLimit) && candidates.length > collectLimit) {
      candidates.length = collectLimit;
    }
  }
  return { airBoundPrunes, candidateCount, candidates, feasible, maximumDamage };
}

/** Finds a lower bound only; all proof work is repeated without this truncation. */
function findSeedPlan(contexts, maximumDamageByBase, prepared, work, solverOptions) {
  const small = contexts[0]?.features.length <= 32;
  const limit = small
    ? Number.POSITIVE_INFINITY
    : Math.max(32, Number(solverOptions.seedCandidateLimit) || DEFAULT_SEED_LIMIT);
  const windows = small ? [Number.POSITIVE_INFINITY] : [48, 96, 160, 256];
  for (const window of windows) {
    const candidateSets = contexts.map((context, baseIndex) => enumerateBase(context, work, {
      minimumDamage: Number.isFinite(window)
        ? Math.max(0, maximumDamageByBase[baseIndex] - window)
        : Number.NEGATIVE_INFINITY,
      collectLimit: limit,
    }).candidates);
    if (work.stopped) return null;
    if (candidateSets.some((candidates) => candidates.length === 0)) continue;
    const result = combineCandidateSets(candidateSets, prepared, work, null, {
      combinationLimit: small
        ? Number.POSITIVE_INFINITY
        : Math.max(
          1000,
          Number(solverOptions.seedCombinationLimit) || DEFAULT_SEED_COMBINATION_LIMIT,
        ),
    });
    if (result.plan) {
      solverOptions.onIncumbent?.(
        result.plan,
        progressSnapshot(work, 'improving', work.startedAt),
      );
      solverOptions.onPhaseChange?.('proving_optimal');
      work.checkStop();
      return result.plan;
    }
  }
  return null;
}

/** Combines per-base frontiers while enforcing the original global inventory. */
function combineCandidateSets(candidateSets, prepared, work, initialPlan, options = {}) {
  const used = new Uint16Array(prepared.groups.length);
  const selected = Array(candidateSets.length).fill(null);
  const maximumDamageSuffix = Array(candidateSets.length + 1).fill(0);
  for (let index = candidateSets.length - 1; index >= 0; index -= 1) {
    maximumDamageSuffix[index] = maximumDamageSuffix[index + 1] +
      (candidateSets[index][0]?.damage ?? Number.NEGATIVE_INFINITY);
  }
  const combinationLimit = options.combinationLimit ?? Number.POSITIVE_INFINITY;
  let bestPlan = initialPlan;
  let visits = 0;
  let candidateAttempts = 0;

  function visit(baseIndex, selectedDamage, selectedResource, worstMargin, selectedScarcity) {
    visits += 1;
    if ((visits & 1023) === 1 && !work.checkStop()) return;
    if (work.stopped || work.stats.combinationsEvaluated >= combinationLimit) return;
    if (bestPlan && selectedDamage + maximumDamageSuffix[baseIndex] < bestPlan.totalDamagePower) {
      return;
    }
    if (baseIndex === candidateSets.length) {
      work.stats.combinationsEvaluated += 1;
      if (!numericCandidateCanBeat(
        bestPlan,
        selectedDamage,
        selectedResource,
        worstMargin,
        selectedScarcity,
      )) return;
      const plan = materializePlan(selected, prepared);
      if (!bestPlan || comparePlanScores(plan, bestPlan) > 0) bestPlan = plan;
      return;
    }

    for (const candidate of candidateSets[baseIndex]) {
      candidateAttempts += 1;
      if ((candidateAttempts & 1023) === 0 && !work.checkStop()) return;
      if (bestPlan && selectedDamage + candidate.damage +
          maximumDamageSuffix[baseIndex + 1] < bestPlan.totalDamagePower) {
        break;
      }
      if (!reserveCandidate(candidate, used, prepared.groups)) continue;
      selected[baseIndex] = candidate;
      visit(
        baseIndex + 1,
        selectedDamage + candidate.damage,
        selectedResource + candidate.resource,
        Math.min(worstMargin, candidate.margin),
        selectedScarcity + candidate.scarcity,
      );
      selected[baseIndex] = null;
      releaseCandidate(candidate, used);
      if (work.stopped || work.stats.combinationsEvaluated >= combinationLimit) return;
    }
  }

  visit(0, 0, 0, Number.POSITIVE_INFINITY, 0);
  return { plan: bestPlan };
}

/** Avoids expensive full summaries when numeric score fields are already worse. */
function numericCandidateCanBeat(plan, damage, resource, margin, scarcity) {
  if (!plan) return true;
  if (damage !== plan.totalDamagePower) return damage > plan.totalDamagePower;
  if (resource !== plan.totalResourceCost) return resource < plan.totalResourceCost;
  if (margin !== plan.worstMargin) return margin > plan.worstMargin;
  if (Math.abs(scarcity - plan.scarcityCost) > 1e-9) return scarcity < plan.scarcityCost;
  return true;
}

/** Removes a group only when unused better copies can replace it in every full plan. */
function removeCapacityDominatedGroups(features, openCapacity) {
  if (openCapacity <= 0) return features;
  return features.filter((candidate) => {
    let dominatingCapacity = 0;
    for (const replacement of features) {
      if (replacement === candidate || !dominatesInEveryContext(replacement, candidate)) continue;
      dominatingCapacity += replacement.count;
      if (dominatingCapacity >= openCapacity) return false;
    }
    return true;
  });
}

/** Tests one-for-one replacement without relying on a particular surrounding loadout. */
function dominatesInEveryContext(replacement, candidate) {
  if (replacement.air < candidate.air || replacement.radius < candidate.radius) return false;
  if (candidate.isRecon && !replacement.isRecon) return false;
  if (!candidate.blocksRangeExtension && replacement.blocksRangeExtension) return false;
  if (replacement.airMode < candidate.airMode || replacement.damageMode < candidate.damageMode) {
    return false;
  }

  let damageStrict = true;
  for (let ambientMode = 0; ambientMode < DAMAGE_COEFFICIENTS.length; ambientMode += 1) {
    const replacementDamage = replacement.damage[Math.max(ambientMode, replacement.damageMode)];
    const candidateDamage = candidate.damage[Math.max(ambientMode, candidate.damageMode)];
    if (replacementDamage < candidateDamage) return false;
    if (replacementDamage === candidateDamage) damageStrict = false;
  }
  if (damageStrict) return true;
  if (replacement.resource < candidate.resource) return true;
  if (replacement.resource > candidate.resource) return false;
  return replacement.scarcity < candidate.scarcity;
}

function createBaseContext(prepared, lock, baseIndex, features) {
  const lockedPlanes = lock.slots
    .filter((slot) => slot.kind === SLOT_KINDS.LOCKED_ITEM)
    .map((slot) => slot.plane);
  let lockedState = emptyState();
  for (const plane of lockedPlanes) {
    lockedState = addFeature(
      lockedState,
      featureForPlane(plane, null, prepared.inventoryCounts, prepared.combatContext),
      1,
    );
  }
  const targetState = targetStateForBase(prepared.waveTargets, baseIndex);
  return {
    baseIndex,
    features,
    lockedState,
    openSlots: lock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length,
    requiredAir: requiredAirForState(prepared.enemyAir, targetState),
    targetRadius: prepared.targetRadius,
    targetState,
  };
}

function featureForGroup(group, groupIndex, inventoryCounts, combatContext) {
  return {
    ...featureForPlane(group.representative, groupIndex, inventoryCounts, combatContext),
    count: group.instances.length,
  };
}

function featureForPlane(plane, groupIndex, inventoryCounts, combatContext) {
  const capabilities = capabilitiesFor(plane);
  const airCoefficient = landReconCoefficient([plane]);
  const damageCoefficient = landBasedReconDamageModifier([plane]);
  const inventoryCount = inventoryCounts.get(aircraftEquivalenceKey(plane)) || 1;
  return {
    groupIndex,
    count: 1,
    key: groupIndex == null ? '' : String(groupIndex),
    air: calculateSlotAirPower(plane),
    damage: DAMAGE_COEFFICIENTS.map((modifier) =>
      calculatePlaneSurfaceTargetPowerProxy(plane, { reconModifier: modifier, combatContext })),
    resource: Math.max(
      0,
      Number(plane.slotSize ?? defaultSlotSizeForPlane(plane)) || 0,
    ),
    scarcity: (plane.missing || plane.available === false ? 1000 : 0) +
      1 / Math.max(1, inventoryCount),
    radius: Math.max(0, Number(plane.radius) || 0),
    isRecon: capabilities.isRecon === true,
    blocksRangeExtension: capabilities.blocksRangeExtension === true,
    airMode: coefficientIndex(AIR_COEFFICIENTS, airCoefficient),
    damageMode: coefficientIndex(DAMAGE_COEFFICIENTS, damageCoefficient),
  };
}

function emptyState() {
  return {
    planeCount: 0,
    rawAir: 0,
    damage: [0, 0, 0],
    resource: 0,
    scarcity: 0,
    minimumRadius: Number.POSITIVE_INFINITY,
    reconRadius: 0,
    blocksRangeExtension: false,
    airMode: 0,
    damageMode: 0,
  };
}

function addFeature(state, feature, count) {
  return {
    planeCount: state.planeCount + count,
    rawAir: state.rawAir + feature.air * count,
    damage: state.damage.map((value, index) => value + feature.damage[index] * count),
    resource: state.resource + feature.resource * count,
    scarcity: state.scarcity + feature.scarcity * count,
    minimumRadius: Math.min(state.minimumRadius, feature.radius),
    reconRadius: feature.isRecon ? Math.max(state.reconRadius, feature.radius) : state.reconRadius,
    blocksRangeExtension: state.blocksRangeExtension || feature.blocksRangeExtension,
    airMode: Math.max(state.airMode, feature.airMode),
    damageMode: Math.max(state.damageMode, feature.damageMode),
  };
}

function summarizeState(state, requiredAir) {
  const air = Math.floor(state.rawAir * AIR_COEFFICIENTS[state.airMode]);
  return {
    planeCount: state.planeCount,
    air,
    damage: state.damage[state.damageMode],
    resource: state.resource,
    scarcity: state.scarcity,
    radius: effectiveRadius(state),
    margin: air - requiredAir,
  };
}

function effectiveRadius(state) {
  if (state.planeCount === 0) return 0;
  const natural = state.minimumRadius;
  if (state.blocksRangeExtension || state.reconRadius <= natural) return natural;
  return Math.round(natural + Math.min(Math.sqrt(state.reconRadius - natural), 3));
}

function isFeasibleSummary(summary, targetState, targetRadius) {
  if (summary.radius < targetRadius) return false;
  if (summary.planeCount === 0 && targetState !== 'none') return false;
  return summary.margin >= 0;
}

function candidateFromState(pairs, summary) {
  return {
    pairs: pairs
      .map(([groupIndex, count]) => [groupIndex, count])
      .sort((left, right) => left[0] - right[0]),
    damage: summary.damage,
    resource: summary.resource,
    scarcity: summary.scarcity,
    air: summary.air,
    margin: summary.margin,
  };
}

/** Visits high-potential branches first so strict suffix bounds become useful immediately. */
function compareEnumerationFeatures(left, right) {
  return (right.damage[2] - left.damage[2]) ||
    (right.air - left.air) ||
    (right.radius - left.radius) ||
    (left.groupIndex - right.groupIndex);
}

function compareBaseCandidates(left, right) {
  return (right.damage - left.damage) ||
    (left.resource - right.resource) ||
    (right.margin - left.margin) ||
    (left.scarcity - right.scarcity) ||
    candidateKey(left).localeCompare(candidateKey(right));
}

function candidateKey(candidate) {
  return candidate.pairs.map(([groupIndex, count]) => `${groupIndex}:${count}`).join(',');
}

function trimSeedCandidates(candidates, limit) {
  if (!Number.isFinite(limit) || candidates.length <= limit * 2) return;
  candidates.sort(compareBaseCandidates);
  candidates.length = limit;
}

function buildSuffixUpperBounds(features, maximumSlots, valueFor) {
  const output = Array.from({ length: features.length + 1 }, () =>
    Array(maximumSlots + 1).fill(0));
  let top = [];
  for (let index = features.length - 1; index >= 0; index -= 1) {
    const feature = features[index];
    const additions = Array(Math.min(maximumSlots, feature.count)).fill(valueFor(feature));
    top = [...top, ...additions].sort((left, right) => right - left).slice(0, maximumSlots);
    let total = 0;
    for (let count = 1; count <= maximumSlots; count += 1) {
      total += top[count - 1] || 0;
      output[index][count] = total;
    }
  }
  return output;
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

function materializePlan(candidates, prepared) {
  const cursors = prepared.groups.map(() => 0);
  const loadouts = candidates.map((candidate, baseIndex) => {
    const lock = prepared.baseLocks[baseIndex];
    const loadout = lock.slots.map((slot) =>
      slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
    const selectedPlanes = [];
    for (const [groupIndex, count] of candidate.pairs) {
      const group = prepared.groups[groupIndex];
      selectedPlanes.push(...group.instances.slice(cursors[groupIndex], cursors[groupIndex] + count));
      cursors[groupIndex] += count;
    }
    let selectedIndex = 0;
    lock.slots.forEach((slot, slotIndex) => {
      if (slot.kind !== SLOT_KINDS.OPEN) return;
      loadout[slotIndex] = selectedPlanes[selectedIndex] || null;
      selectedIndex += 1;
    });
    return loadout;
  });
  return summarizePlan(loadouts, prepared);
}

function coefficientIndex(values, coefficient) {
  const index = values.indexOf(coefficient);
  return index < 0 ? 0 : index;
}

function createWorkController(prepared, solverOptions, stats, startedAt) {
  const timeLimitMs = solverOptions.timeLimitSeconds == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Number(solverOptions.timeLimitSeconds) || 0) * 1000;
  const nodeLimit = solverOptions.nodeBudget == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Number(solverOptions.nodeBudget) || 0);
  return {
    stats,
    startedAt,
    stopped: false,
    reason: null,
    checkStop() {
      if (prepared.isCancelled?.() || solverOptions.isCancelled?.()) {
        this.stopped = true;
        this.reason = 'cancelled';
      } else if (Date.now() - startedAt >= timeLimitMs) {
        this.stopped = true;
        this.reason = 'time_limit';
      }
      return !this.stopped;
    },
    consume() {
      if (stats.nodesExplored >= nodeLimit) {
        this.stopped = true;
        this.reason = 'node_budget';
        return false;
      }
      stats.nodesExplored += 1;
      if ((stats.nodesExplored & 4095) !== 0) return !this.stopped;
      return this.checkStop();
    },
  };
}

function emitProgress(solverOptions, work, phase, startedAt) {
  solverOptions.onProgress?.(progressSnapshot(work, phase, startedAt));
}

function progressSnapshot(work, phase, startedAt) {
  return {
    phase,
    nodesExplored: work.stats.nodesExplored,
    nodesPruned: null,
    candidatesEvaluated: work.stats.combinationsEvaluated,
    simulationSamplesEvaluated: 0,
    elapsedMs: Date.now() - startedAt,
    completedWork: null,
    totalWork: null,
  };
}

function finishedResult(plan, provenOptimal, stats, startedAt, status) {
  stats.status = status;
  stats.elapsedMs = Date.now() - startedAt;
  return { plan, provenOptimal, solverStats: stats };
}

function stoppedResult(stats, startedAt, reason, plan = null) {
  stats.status = reason === 'cancelled' ? 'cancelled' : 'not_optimal';
  stats.stopReason = reason;
  stats.elapsedMs = Date.now() - startedAt;
  return { plan, provenOptimal: false, solverStats: stats };
}

function validatePrepared(prepared) {
  if (!prepared?.valid) throw new Error(prepared?.message || 'Invalid static exact search input.');
  if (prepared.detailed) throw new Error('Static exact solver does not support detailed simulation.');
  if (prepared.maxResults !== 1) throw new Error('Static exact solver supports maxResults=1 only.');
}

function isPreparedSearch(value) {
  return value?.valid === true && Array.isArray(value.groups) && Array.isArray(value.baseLocks);
}

module.exports = {
  combineCandidateSets,
  createBaseContext,
  dominatesInEveryContext,
  enumerateBase,
  featureForGroup,
  removeCapacityDominatedGroups,
  solveStaticExact,
};
