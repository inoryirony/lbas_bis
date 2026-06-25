'use strict';

const {
  AIR_STATES,
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  requiredAirForState,
} = require('./air-power');

const SLOTS_PER_BASE = 4;
const DEFAULT_MAX_RESULTS = 10;
const MAX_BASE_CANDIDATES = 160;

function optimizeLoadouts(options) {
  const {
    equipment,
    baseCount = 1,
    targetRadius,
    enemyAir,
    targetStates = [],
    maxResults = DEFAULT_MAX_RESULTS,
  } = options;
  const messages = [];
  const candidates = generateBaseCandidates(equipment, targetRadius, enemyAir);

  if (candidates.length === 0) {
    messages.push(`No candidate loadout can reach radius ${targetRadius}.`);
    return { messages, results: [] };
  }

  const wantedBaseCount = Math.max(1, Math.min(3, Number(baseCount) || 1));
  const results = combineBases({
    candidates,
    baseIndex: 0,
    baseCount: wantedBaseCount,
    enemyAir,
    targetStates,
    usedIds: new Set(),
    selected: [],
  })
    .map((bases) => summarizePlan(bases, enemyAir, targetStates))
    .filter((plan) => plan.fulfilled)
    .sort(comparePlans)
    .slice(0, maxResults);

  return {
    messages,
    results,
  };
}

function generateBaseCandidates(equipment, targetRadius, enemyAir) {
  const pool = selectCandidatePool(equipment);
  const combinations = [];
  choose(pool, SLOTS_PER_BASE, 0, [], combinations);

  return combinations
    .map((loadout) => {
      const airPower = calculateBaseAirPower(loadout);
      const radius = calculateEffectiveRadius(loadout);
      const state = airStateFor(airPower, enemyAir);
      const attackScore = loadout.reduce((total, plane) => total + planeAttackScore(plane), 0);

      return {
        loadout,
        airPower,
        radius,
        state,
        attackScore,
        fighterCount: loadout.filter((plane) => plane.role.includes('fighter')).length,
      };
    })
    .filter((candidate) => candidate.radius >= targetRadius)
    .sort(compareCandidates)
    .slice(0, MAX_BASE_CANDIDATES);
}

function selectCandidatePool(equipment) {
  const unique = new Map();
  for (const plane of equipment || []) {
    if (!plane || plane.instanceId == null || unique.has(plane.instanceId)) {
      continue;
    }
    unique.set(plane.instanceId, plane);
  }
  return [...unique.values()]
    .filter((plane) => (plane.radius || 0) > 0)
    .sort((left, right) => equipmentSortScore(right) - equipmentSortScore(left))
    .slice(0, 48);
}

function choose(items, count, start, current, output) {
  if (current.length === count) {
    output.push([...current]);
    return;
  }

  for (let index = start; index <= items.length - (count - current.length); index += 1) {
    current.push(items[index]);
    choose(items, count, index + 1, current, output);
    current.pop();
  }
}

function combineBases(context) {
  const {
    candidates,
    baseIndex,
    baseCount,
    enemyAir,
    targetStates,
    usedIds,
    selected,
  } = context;

  if (baseIndex === baseCount) {
    return [[...selected]];
  }

  const targetState = targetStates[baseIndex] || targetStates[0] || 'parity';
  const requiredRank = AIR_STATES[targetState]?.rank ?? AIR_STATES.parity.rank;
  const plans = [];

  for (const candidate of candidates) {
    if (candidate.state.rank < requiredRank || overlaps(candidate, usedIds)) {
      continue;
    }

    for (const plane of candidate.loadout) {
      usedIds.add(plane.instanceId);
    }
    selected.push(candidate);

    plans.push(
      ...combineBases({
        candidates,
        baseIndex: baseIndex + 1,
        baseCount,
        enemyAir,
        targetStates,
        usedIds,
        selected,
      }),
    );

    selected.pop();
    for (const plane of candidate.loadout) {
      usedIds.delete(plane.instanceId);
    }

    if (plans.length >= DEFAULT_MAX_RESULTS * 8) {
      break;
    }
  }

  return plans;
}

function summarizePlan(bases, enemyAir, targetStates) {
  const baseSummaries = bases.map((candidate, index) => {
    const targetState = targetStates[index] || targetStates[0] || 'parity';
    return {
      ...candidate,
      targetState,
      marginToTarget: candidate.airPower - requiredAirForTarget(enemyAir, targetState),
    };
  });
  const fulfilled = baseSummaries.every(
    (base) => base.state.rank >= (AIR_STATES[base.targetState]?.rank ?? AIR_STATES.parity.rank),
  );
  return {
    fulfilled,
    bases: baseSummaries,
    totalAirPower: baseSummaries.reduce((total, base) => total + base.airPower, 0),
    totalAttackScore: baseSummaries.reduce((total, base) => total + base.attackScore, 0),
    worstMargin: Math.min(...baseSummaries.map((base) => base.marginToTarget)),
  };
}

function overlaps(candidate, usedIds) {
  return candidate.loadout.some((plane) => usedIds.has(plane.instanceId));
}

function compareCandidates(left, right) {
  return (
    right.state.rank - left.state.rank ||
    right.attackScore - left.attackScore ||
    right.airPower - left.airPower ||
    left.fighterCount - right.fighterCount
  );
}

function comparePlans(left, right) {
  return (
    Number(right.fulfilled) - Number(left.fulfilled) ||
    right.totalAttackScore - left.totalAttackScore ||
    right.worstMargin - left.worstMargin ||
    right.totalAirPower - left.totalAirPower
  );
}

function equipmentSortScore(plane) {
  return (
    (plane.antiAir || 0) * 10 +
    (plane.intercept || 0) * 8 +
    planeAttackScore(plane) +
    (plane.radius || 0)
  );
}

function planeAttackScore(plane) {
  return (plane.torpedo || 0) + (plane.bombing || 0);
}

function requiredAirForTarget(enemyAir, targetState) {
  return requiredAirForState(enemyAir, targetState);
}

module.exports = {
  generateBaseCandidates,
  optimizeLoadouts,
};
