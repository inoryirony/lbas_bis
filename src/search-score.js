'use strict';

const {
  AIR_STATES,
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  defaultSlotSizeForPlane,
  requiredAirForState,
} = require('./air-power');
const { aircraftEquivalenceKey } = require('./aircraft');
const { calculateBaseDamagePower } = require('./damage');
const { monteCarloWaveSequence } = require('./wave-simulator');
const INVENTORY_KEY_CACHE = Symbol('inventoryKeyCache');
const MIN_SCORE = -Number.MAX_VALUE;
const MAX_SCORE = Number.MAX_VALUE;

/**
 * Builds the shared lexicographic score for a complete or optimistic plan.
 * @param {Record<string, any>} plan Complete plan totals or an existing score.
 * @returns {Record<string, any>} Canonical lexicographic score fields.
 */
function scorePlan(plan) {
  if (isPlanScoreShape(plan)) {
    const detailedScore = isDetailedScore(plan);
    return {
      ...(detailedScore ? {
        fulfillment: finiteNumber(plan.fulfillment, 0),
      } : {}),
      damage: finiteNumber(plan.damage, 0),
      ...(detailedScore ? {
        loss: finiteNumber(plan.loss, 0),
      } : {}),
      resource: finiteNumber(plan.resource, 0),
      margin: finiteNumber(plan.margin, MIN_SCORE),
      scarcity: finiteNumber(plan.scarcity, 0),
      canonicalKey: String(plan.canonicalKey ?? ''),
    };
  }
  if (plan?.calculationMode === 'detailed' ||
      plan?.allWaveTargetFulfillmentProbability != null) {
    return {
      fulfillment: finiteNumber(plan.allWaveTargetFulfillmentProbability, 0),
      damage: finiteNumber(plan?.totalDamagePower, 0),
      loss: -finiteNumber(plan?.totalExpectedLoss, 0),
      resource: -finiteNumber(plan?.totalResourceCost, 0),
      margin: finiteNumber(plan?.worstMargin, MIN_SCORE),
      scarcity: -finiteNumber(plan?.scarcityCost, 0),
      canonicalKey: String(plan?.canonicalKey ?? canonicalPlanKey(plan)),
    };
  }
  return {
    damage: finiteNumber(plan?.totalDamagePower, 0),
    resource: -finiteNumber(plan?.totalResourceCost, 0),
    margin: finiteNumber(plan?.worstMargin, MIN_SCORE),
    scarcity: -finiteNumber(plan?.scarcityCost, 0),
    canonicalKey: String(plan?.canonicalKey ?? canonicalPlanKey(plan)),
  };
}

/**
 * Compares scores positively when the left score is lexicographically better.
 * @param {Record<string, any>} left Left plan or score.
 * @param {Record<string, any>} right Right plan or score.
 * @returns {number} Positive, zero, or negative ordering value.
 */
function comparePlanScores(left, right) {
  const leftScore = scorePlan(left);
  const rightScore = scorePlan(right);
  const detailed = isDetailedScore(leftScore) || isDetailedScore(rightScore);
  const numeric = (
    (detailed
      ? compareNumber(
        finiteNumber(leftScore.fulfillment, 0),
        finiteNumber(rightScore.fulfillment, 0),
      )
      : 0) ||
    compareNumber(leftScore.damage, rightScore.damage) ||
    (detailed
      ? compareNumber(finiteNumber(leftScore.loss, 0), finiteNumber(rightScore.loss, 0))
      : 0) ||
    compareNumber(leftScore.resource, rightScore.resource) ||
    compareNumber(leftScore.margin, rightScore.margin) ||
    compareNumber(leftScore.scarcity, rightScore.scarcity)
  );
  if (numeric) {
    return numeric;
  }
  return compareCanonicalKeys(leftScore.canonicalKey, rightScore.canonicalKey);
}

/**
 * Combines exact partial totals with independently optimistic base envelopes.
 * @param {Record<string, any>} partial Exact totals for selected bases.
 * @param {Array<Record<string, any>>} remainingGroups Remaining production groups.
 * @param {Record<string, any>} [context] Independently relaxed base envelopes.
 * @returns {Record<string, any> | null} Optimistic score, or null if any envelope is infeasible.
 */
function optimisticPlanScore(partial, remainingGroups, context = {}) {
  void remainingGroups;
  const envelopes = context.envelopes || [];
  if (envelopes.some((envelope) => !envelope?.feasible)) {
    return null;
  }

  const partialMargin = partial?.bases?.length
    ? finiteNumber(partial.worstMargin, MIN_SCORE)
    : MAX_SCORE;
  return {
    damage: finiteNumber(partial?.totalDamagePower, 0) +
      envelopes.reduce((total, envelope) => total + envelope.maxDamage, 0),
    resource: -(
      finiteNumber(partial?.totalResourceCost, 0) +
      envelopes.reduce((total, envelope) => total + envelope.minResource, 0)
    ),
    margin: Math.min(
      partialMargin,
      ...envelopes.map((envelope) => envelope.maxMargin),
    ),
    scarcity: -(
      finiteNumber(partial?.scarcityCost, 0) +
      envelopes.reduce((total, envelope) => total + envelope.minScarcity, 0)
    ),
    canonicalKey: '',
  };
}

/**
 * Creates a permutation- and instance-insensitive key from per-base group counts.
 * @param {Record<string, any>} plan Plan containing four-slot base loadouts.
 * @returns {string} Stable equivalence-count key.
 */
function canonicalPlanKey(plan) {
  const bases = plan?.bases || [];
  return JSON.stringify(bases.map((base) => {
    const counts = new Map();
    let emptyCount = 0;
    for (const plane of base.loadout || []) {
      if (!plane) {
        emptyCount += 1;
        continue;
      }
      const key = aircraftEquivalenceKey(plane);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return {
      empty: emptyCount,
      groups: [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    };
  }));
}

/** Summarizes a complete assignment with the formulas shared by both optimizers. */
function summarizePlan(loadouts, context) {
  const {
    enemyAir,
    waveTargets,
    inventoryCounts = new Map(),
  } = context;
  const bases = loadouts.map((loadout, baseIndex) =>
    summarizeBase(
      loadout,
      enemyAir,
      targetStateForBase(waveTargets, baseIndex),
      inventoryCounts,
      { combatContext: context.combatContext },
    ));
  const minimumProficiencyValues = bases
    .map((base) => base.minimumProficiency)
    .filter((value) => value != null);
  const plan = {
    fulfilled: bases.every((base) => base.fulfilled),
    bases,
    waves: buildWaveSummaries(bases, enemyAir, waveTargets),
    missingEquipment: summarizeMissingEquipment(bases.flatMap((base) => base.loadout.filter(Boolean))),
    minimumProficiency: minimumProficiencyValues.length
      ? Math.max(...minimumProficiencyValues)
      : null,
    totalAirPower: bases.reduce((total, base) => total + base.airPower, 0),
    totalAttackScore: bases.reduce((total, base) => total + base.attackScore, 0),
    totalDamagePower: bases.reduce((total, base) => total + base.damagePower, 0),
    totalResourceCost: bases.reduce((total, base) => total + base.resourceCost, 0),
    scarcityCost: bases.reduce((total, base) => total + base.scarcityCost, 0),
    worstMargin: Math.min(...bases.map((base) => base.marginToTarget)),
    calculationMode: 'static',
    mode: 'static',
    simulation: null,
    limitations: ['STATIC_ENEMY_AIR'],
  };
  if (context.detailed) {
    const simulation = monteCarloWaveSequence({
      bases: loadouts,
      enemy: context.enemy,
      enemyFleets: context.enemyFleets,
      targetStates: waveTargets,
      combatContext: context.combatContext,
      ...context.simulationOptions,
    });
    if (simulation.prunedBySimulationBound) {
      return {
        prunedBySimulationBound: true,
        simulation,
      };
    }
    plan.fulfilled = simulation.allWaveTargetFulfillmentProbability === 1;
    plan.waves = simulation.waves;
    plan.totalDamagePower = simulation.expectedDamage;
    plan.totalExpectedLoss = simulation.expectedOwnSlotLoss;
    plan.totalResourceCost = simulation.expectedResourceCost;
    plan.worstMargin = Math.min(...simulation.waves.map((wave) =>
      wave.expectedOwnAirBefore - requiredAirForState(
        wave.expectedEnemyAirBefore,
        wave.targetState,
      )));
    plan.allWaveTargetFulfillmentProbability =
      simulation.allWaveTargetFulfillmentProbability;
    plan.simulation = simulation;
    plan.calculationMode = 'detailed';
    plan.mode = 'detailed';
    plan.limitations = simulation.limitations;
    plan.limitationNotes = simulation.limitationNotes;
  }
  plan.attackPowerProxy = plan.totalDamagePower;
  plan.canonicalKey = canonicalPlanKey(plan);
  plan.score = scorePlan(plan);
  return plan;
}

/** Summarizes one four-slot base while ignoring null slots in aircraft formulas. */
function summarizeBase(loadout, enemyAir, targetState, inventoryCounts = new Map(), options = {}) {
  const planes = loadout.filter(Boolean);
  const airPower = calculateBaseAirPower(planes);
  const radius = calculateEffectiveRadius(planes);
  const requiredAir = requiredAirForState(enemyAir, targetState);
  const state = airStateFor(airPower, enemyAir, planes.length > 0);
  const requiredRank = AIR_STATES[targetState]?.rank ?? AIR_STATES.parity.rank;
  const damagePower = calculateBaseDamagePower(planes, {
    combatContext: options.combatContext,
  });
  return {
    loadout: [...loadout],
    airPower,
    radius,
    state,
    targetState,
    fulfilled: state.rank >= requiredRank,
    marginToTarget: airPower - requiredAir,
    attackScore: planes.reduce((total, plane) => total + planeAttackScore(plane), 0),
    damagePower,
    attackPowerProxy: damagePower,
    resourceCost: planes.reduce((total, plane) => total + resourceCostForPlane(plane), 0),
    scarcityCost: planes.reduce(
      (total, plane) => total + scarcityCostForPlane(plane, inventoryCounts),
      0,
    ),
    landBasedCount: planes.filter((plane) => plane.isLandBased).length,
    landAttackerCount: planes.filter((plane) => plane.isLandAttacker || plane.role === 'attacker').length,
    fighterCount: planes.filter((plane) => plane.isFighter || plane.role?.includes('fighter')).length,
    minimumProficiency: options.details === false
      ? null
      : minimumProficiencyForTarget(planes, enemyAir, targetState),
    missingEquipment: options.details === false ? [] : summarizeMissingEquipment(planes),
  };
}

/** Returns whether a base satisfies radius and both static wave targets. */
function isBaseFeasible(base, targetRadius) {
  return base.fulfilled && base.radius >= Math.max(0, Number(targetRadius) || 0);
}

/** Sorts complete plans by shared score and canonical tie-break. */
function comparePlansForSort(left, right) {
  return -comparePlanScores(left, right);
}

/** Returns the stricter of the two static targets assigned to a base. */
function targetStateForBase(waveTargets, baseIndex) {
  const first = waveTargets[baseIndex * 2] || waveTargets[0] || 'parity';
  const second = waveTargets[baseIndex * 2 + 1] || first;
  return [first, second].sort(
    (left, right) => (AIR_STATES[right]?.rank ?? 0) - (AIR_STATES[left]?.rank ?? 0),
  )[0];
}

/** Counts available equivalent instances for scarcity scoring. */
function inventoryCountsFor(equipment) {
  const counts = new Map();
  counts[INVENTORY_KEY_CACHE] = new WeakMap();
  for (const plane of equipment || []) {
    if (!plane) continue;
    const key = aircraftEquivalenceKey(plane);
    counts[INVENTORY_KEY_CACHE].set(plane, key);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** Returns the static sortie resource proxy for one aircraft slot. */
function resourceCostForPlane(plane) {
  return Math.max(0, Number(plane.slotSize ?? defaultSlotSizeForPlane(plane)) || 0);
}

/** Penalizes missing aircraft first, then use of scarce equivalence groups. */
function scarcityCostForPlane(plane, inventoryCounts) {
  const missingCost = plane.missing || plane.available === false ? 1000 : 0;
  const count = inventoryCounts.get(equivalenceKeyForInventory(plane, inventoryCounts)) || 1;
  return missingCost + 1 / count;
}

/** Computes the minimum uniform visible proficiency that reaches a target. */
function minimumProficiencyForTarget(loadout, enemyAir, targetState) {
  const requiredRank = AIR_STATES[targetState]?.rank ?? AIR_STATES.parity.rank;
  for (let level = 0; level <= 7; level += 1) {
    const adjusted = loadout.map((plane) => ({
      ...plane,
      proficiency: level,
      internalProficiency: undefined,
    }));
    if (airStateFor(calculateBaseAirPower(adjusted), enemyAir, adjusted.length > 0).rank >= requiredRank) {
      return level;
    }
  }
  return null;
}

/** Aggregates missing equipment by master ID for UI compatibility. */
function summarizeMissingEquipment(loadout) {
  const missing = new Map();
  for (const plane of loadout) {
    if (!plane.missing && plane.available !== false) continue;
    const key = plane.masterId;
    const current = missing.get(key) || { masterId: plane.masterId, name: plane.name, count: 0 };
    current.count += 1;
    missing.set(key, current);
  }
  return [...missing.values()].sort((left, right) => left.masterId - right.masterId);
}

/** Builds two static wave summaries per base. */
function buildWaveSummaries(bases, enemyAir, waveTargets) {
  return waveTargets.map((targetState, waveIndex) => {
    const baseIndex = Math.floor(waveIndex / 2);
    const base = bases[baseIndex];
    return {
      waveIndex,
      baseIndex,
      targetState,
      airPower: base.airPower,
      state: airStateFor(base.airPower, enemyAir, base.loadout.some(Boolean)),
      marginToTarget: base.airPower - requiredAirForState(enemyAir, targetState),
    };
  });
}

/** Returns the legacy raw attack-stat sum used by existing UI summaries. */
function planeAttackScore(plane) {
  return (Number(plane.torpedo) || 0) + (Number(plane.bombing) || 0);
}

/** Detects a score object without recursively rescoring it. */
function isPlanScoreShape(value) {
  return value != null &&
    Object.prototype.hasOwnProperty.call(value, 'damage') &&
    Object.prototype.hasOwnProperty.call(value, 'resource') &&
    Object.prototype.hasOwnProperty.call(value, 'canonicalKey');
}

/** Detects the extended detailed score without changing the legacy static shape. */
function isDetailedScore(value) {
  return value != null &&
    (Object.prototype.hasOwnProperty.call(value, 'fulfillment') ||
      Object.prototype.hasOwnProperty.call(value, 'loss'));
}

/** Compares finite and infinite numeric score fields. */
function compareNumber(left, right) {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/** Uses the lexicographically smaller canonical key as the stable winner. */
function compareCanonicalKeys(left = '', right = '') {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

/** Converts numeric input to a finite value and canonicalizes signed zero. */
function finiteNumber(value, fallback) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? number : fallback;
  return normalized === 0 ? 0 : normalized;
}

/** Reads a per-search key cache without leaking stale keys across optimizer calls. */
function equivalenceKeyForInventory(plane, inventoryCounts) {
  const cache = inventoryCounts?.[INVENTORY_KEY_CACHE];
  const cached = cache?.get(plane);
  if (cached) return cached;
  const key = aircraftEquivalenceKey(plane);
  cache?.set(plane, key);
  return key;
}

module.exports = {
  canonicalPlanKey,
  comparePlanScores,
  comparePlansForSort,
  inventoryCountsFor,
  isBaseFeasible,
  optimisticPlanScore,
  scorePlan,
  summarizeBase,
  summarizePlan,
  targetStateForBase,
};
