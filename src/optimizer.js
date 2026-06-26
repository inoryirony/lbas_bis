'use strict';

const {
  AIR_STATES,
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  requiredAirForState,
} = require('./air-power');
const { calculateBaseDamagePower } = require('./damage');

const SLOTS_PER_BASE = 4;
const DEFAULT_MAX_RESULTS = 10;
const MAX_BASE_CANDIDATES = 1200;
const WAVES_PER_BASE = 2;

function optimizeLoadouts(options) {
  const {
    equipment,
    baseCount = 1,
    targetRadius,
    enemyAir,
    targetStates = [],
    lockedBases = [],
    maxResults = DEFAULT_MAX_RESULTS,
  } = options;
  const messages = [];
  const wantedBaseCount = Math.max(1, Math.min(3, Number(baseCount) || 1));
  const waveTargets = normalizeWaveTargets(targetStates, wantedBaseCount);
  const baseLocks = normalizeLockedBases(lockedBases, wantedBaseCount);
  const candidatesByBase = baseLocks.map((lockedBase) =>
    generateBaseCandidates(equipment, targetRadius, enemyAir, lockedBase.slots),
  );

  if (candidatesByBase.some((candidates) => candidates.length === 0)) {
    messages.push(`No candidate loadout can reach radius ${targetRadius}.`);
    return { messages, results: [] };
  }

  const results = combineBases({
    candidatesByBase,
    baseIndex: 0,
    baseCount: wantedBaseCount,
    enemyAir,
    waveTargets,
    usedIds: new Set(),
    selected: [],
  })
    .map((bases) => summarizePlan(bases, enemyAir, waveTargets))
    .filter((plan) => plan.fulfilled)
    .sort(comparePlans)
    .slice(0, maxResults);

  return {
    messages,
    results,
  };
}

function generateBaseCandidates(equipment, targetRadius, enemyAir, slotConstraints = []) {
  const slots = normalizeSlotConstraints(slotConstraints);
  const lockedLoadout = slots.map((slot) => slot.locked ? slot.plane : null).filter(Boolean);
  if (hasDuplicateInstanceId(lockedLoadout)) {
    return [];
  }

  const lockedIds = new Set(lockedLoadout.map((plane) => plane.instanceId));
  const pool = selectCandidatePool([...(equipment || []), ...lockedLoadout], targetRadius)
    .filter((plane) => !lockedIds.has(plane.instanceId));
  const unlockedSlots = slots
    .map((slot, index) => ({ slot, index }))
    .filter((entry) => !entry.slot.locked);
  const combinations = [];
  choose(pool, unlockedSlots.length, 0, [], combinations);

  return combinations
    .map((selectedPlanes) => buildLoadoutFromSlots(slots, unlockedSlots, selectedPlanes))
    .filter((loadout) => loadout.length === SLOTS_PER_BASE && !hasDuplicateInstanceId(loadout))
    .map((loadout) => summarizeCandidate(loadout, enemyAir))
    .filter((candidate) => candidate.radius >= targetRadius)
    .sort(compareCandidates)
    .slice(0, MAX_BASE_CANDIDATES);
}

function buildLoadoutFromSlots(slots, unlockedSlots, selectedPlanes) {
  const loadout = slots.map((slot) => slot.locked ? slot.plane : null);
  unlockedSlots.forEach((entry, selectedIndex) => {
    loadout[entry.index] = selectedPlanes[selectedIndex] || null;
  });
  return loadout.filter(Boolean);
}

function summarizeCandidate(loadout, enemyAir) {
  const airPower = calculateBaseAirPower(loadout);
  const radius = calculateEffectiveRadius(loadout);
  const state = airStateFor(airPower, enemyAir);
  const attackScore = loadout.reduce((total, plane) => total + planeAttackScore(plane), 0);
  const damagePower = calculateBaseDamagePower(loadout);
  const landBasedCount = loadout.filter((plane) => plane.isLandBased).length;
  const landAttackerCount = loadout.filter((plane) => plane.isLandBased && plane.role === 'attacker').length;

  return {
    loadout,
    airPower,
    radius,
    state,
    attackScore,
    damagePower,
    landBasedCount,
    landAttackerCount,
    fighterCount: loadout.filter((plane) => plane.role.includes('fighter')).length,
  };
}

function selectCandidatePool(equipment, targetRadius) {
  const unique = new Map();
  for (const plane of equipment || []) {
    if (!plane || plane.instanceId == null || unique.has(plane.instanceId)) {
      continue;
    }
    unique.set(plane.instanceId, plane);
  }
  const values = [...unique.values()];
  const maxExtenderRadius = values
    .filter((plane) => plane.role === 'recon')
    .reduce((best, plane) => Math.max(best, Number(plane.radius) || 0), 0);
  return values
    .filter((plane) => canContributeToTargetRadiusWithExtenders(plane, targetRadius, maxExtenderRadius))
    .sort((left, right) => equipmentSortScore(right, targetRadius) - equipmentSortScore(left, targetRadius))
    .slice(0, 72);
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
    candidatesByBase,
    baseIndex,
    baseCount,
    enemyAir,
    waveTargets,
    usedIds,
    selected,
  } = context;

  if (baseIndex === baseCount) {
    return [[...selected]];
  }

  const targetState = targetStateForBase(waveTargets, baseIndex);
  const requiredRank = AIR_STATES[targetState]?.rank ?? AIR_STATES.parity.rank;
  const plans = [];
  const sortedCandidates = candidatesByBase[baseIndex]
    .filter((candidate) => candidate.state.rank >= requiredRank)
    .sort((left, right) => compareCandidatesForTarget(left, right, enemyAir, targetState));

  for (const candidate of sortedCandidates) {
    if (overlaps(candidate, usedIds)) {
      continue;
    }

    for (const plane of candidate.loadout) {
      usedIds.add(plane.instanceId);
    }
    selected.push(candidate);

    plans.push(
      ...combineBases({
        candidatesByBase,
        baseIndex: baseIndex + 1,
        baseCount,
        enemyAir,
        waveTargets,
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

function summarizePlan(bases, enemyAir, waveTargets) {
  const baseSummaries = bases.map((candidate, index) => {
    const targetState = targetStateForBase(waveTargets, index);
    return {
      ...candidate,
      targetState,
      marginToTarget: candidate.airPower - requiredAirForTarget(enemyAir, targetState),
      minimumProficiency: minimumProficiencyForTarget(candidate.loadout, enemyAir, targetState),
      missingEquipment: summarizeMissingEquipment(candidate.loadout),
    };
  });
  const fulfilled = baseSummaries.every(
    (base) => base.state.rank >= (AIR_STATES[base.targetState]?.rank ?? AIR_STATES.parity.rank),
  );
  const minimumProficiencyValues = baseSummaries
    .map((base) => base.minimumProficiency)
    .filter((value) => value != null);
  return {
    fulfilled,
    bases: baseSummaries,
    waves: buildWaveSummaries(baseSummaries, enemyAir, waveTargets),
    missingEquipment: summarizeMissingEquipment(baseSummaries.flatMap((base) => base.loadout)),
    minimumProficiency: minimumProficiencyValues.length
      ? Math.max(...minimumProficiencyValues)
      : null,
    totalAirPower: baseSummaries.reduce((total, base) => total + base.airPower, 0),
    totalAttackScore: baseSummaries.reduce((total, base) => total + base.attackScore, 0),
    totalDamagePower: baseSummaries.reduce((total, base) => total + base.damagePower, 0),
    worstMargin: Math.min(...baseSummaries.map((base) => base.marginToTarget)),
  };
}

function overlaps(candidate, usedIds) {
  return candidate.loadout.some((plane) => usedIds.has(plane.instanceId));
}

function normalizeLockedBases(lockedBases, baseCount) {
  return Array.from({ length: baseCount }, (_, baseIndex) => ({
    slots: normalizeSlotConstraints(lockedBases?.[baseIndex]?.slots),
  }));
}

function normalizeSlotConstraints(slotConstraints = []) {
  return Array.from({ length: SLOTS_PER_BASE }, (_, slotIndex) => {
    const slot = slotConstraints[slotIndex] || {};
    return {
      plane: slot.plane || null,
      locked: Boolean(slot.locked && slot.plane),
    };
  });
}

function hasDuplicateInstanceId(loadout) {
  const seen = new Set();
  for (const plane of loadout) {
    if (!plane || plane.instanceId == null) {
      return true;
    }
    if (seen.has(plane.instanceId)) {
      return true;
    }
    seen.add(plane.instanceId);
  }
  return false;
}

function compareCandidates(left, right) {
  return (
    right.landAttackerCount - left.landAttackerCount ||
    right.damagePower - left.damagePower ||
    right.landBasedCount - left.landBasedCount ||
    right.attackScore - left.attackScore ||
    left.fighterCount - right.fighterCount ||
    right.airPower - left.airPower ||
    right.state.rank - left.state.rank ||
    0
  );
}

function compareCandidatesForTarget(left, right, enemyAir, targetState) {
  const requiredAir = requiredAirForTarget(enemyAir, targetState);
  const leftWaste = Math.max(0, left.airPower - requiredAir);
  const rightWaste = Math.max(0, right.airPower - requiredAir);

  return (
    right.landAttackerCount - left.landAttackerCount ||
    right.damagePower - left.damagePower ||
    right.landBasedCount - left.landBasedCount ||
    right.attackScore - left.attackScore ||
    leftWaste - rightWaste ||
    left.fighterCount - right.fighterCount
  );
}

function comparePlans(left, right) {
  return (
    Number(right.fulfilled) - Number(left.fulfilled) ||
    right.totalDamagePower - left.totalDamagePower ||
    right.totalAttackScore - left.totalAttackScore ||
    right.worstMargin - left.worstMargin ||
    right.totalAirPower - left.totalAirPower
  );
}

function canContributeToTargetRadius(plane, targetRadius) {
  const radius = Number(plane.radius) || 0;
  if (radius <= 0) {
    return false;
  }
  if (radius >= targetRadius) {
    return true;
  }
  return plane.role === 'recon' && radius >= Math.max(1, targetRadius - 3);
}

function canContributeToTargetRadiusWithExtenders(plane, targetRadius, maxExtenderRadius) {
  const radius = Number(plane.radius) || 0;
  if (canContributeToTargetRadius(plane, targetRadius)) {
    return true;
  }
  if (radius <= 0 || plane.role === 'recon') {
    return false;
  }
  if (maxExtenderRadius <= radius) {
    return false;
  }
  const extension = Math.min(3, Math.max(0, Math.round(Math.sqrt(maxExtenderRadius - radius))));
  return radius + extension >= targetRadius;
}

function equipmentSortScore(plane, targetRadius) {
  const reachesTarget = (Number(plane.radius) || 0) >= targetRadius;
  return (
    (reachesTarget ? 10000 : 0) +
    (plane.isLandBased ? 1000 : 0) +
    (plane.role === 'attacker' ? 700 : 0) +
    (plane.role === 'recon' ? 350 : 0) +
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

function normalizeWaveTargets(targetStates, baseCount) {
  const states = (Array.isArray(targetStates) ? targetStates : [])
    .filter((state) => AIR_STATES[state]);
  const fallback = states[0] || 'parity';
  return Array.from({ length: baseCount * WAVES_PER_BASE }, (_, index) => states[index] || fallback);
}

function minimumProficiencyForTarget(loadout, enemyAir, targetState) {
  const requiredRank = AIR_STATES[targetState]?.rank ?? AIR_STATES.parity.rank;
  for (let level = 0; level <= 7; level += 1) {
    const adjustedLoadout = loadout.map((plane) => ({ ...plane, proficiency: level }));
    const airPower = calculateBaseAirPower(adjustedLoadout);
    if (airStateFor(airPower, enemyAir).rank >= requiredRank) {
      return level;
    }
  }
  return null;
}

function summarizeMissingEquipment(loadout) {
  const missing = new Map();
  for (const plane of loadout) {
    if (!plane.missing && plane.available !== false) {
      continue;
    }
    const key = plane.masterId;
    const current = missing.get(key) || {
      masterId: plane.masterId,
      name: plane.name,
      count: 0,
    };
    current.count += 1;
    missing.set(key, current);
  }
  return [...missing.values()].sort((left, right) => left.masterId - right.masterId);
}

function targetStateForBase(waveTargets, baseIndex) {
  const first = waveTargets[baseIndex * WAVES_PER_BASE] || waveTargets[0] || 'parity';
  const second = waveTargets[baseIndex * WAVES_PER_BASE + 1] || first;
  return [first, second].sort((left, right) => AIR_STATES[right].rank - AIR_STATES[left].rank)[0];
}

function buildWaveSummaries(baseSummaries, enemyAir, waveTargets) {
  return waveTargets.map((targetState, waveIndex) => {
    const baseIndex = Math.floor(waveIndex / WAVES_PER_BASE);
    const base = baseSummaries[baseIndex];
    return {
      waveIndex,
      baseIndex,
      targetState,
      airPower: base.airPower,
      state: airStateFor(base.airPower, enemyAir),
      marginToTarget: base.airPower - requiredAirForTarget(enemyAir, targetState),
    };
  });
}

module.exports = {
  generateBaseCandidates,
  normalizeWaveTargets,
  optimizeLoadouts,
};
