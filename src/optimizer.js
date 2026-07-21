'use strict';

const { AIR_STATES, calculateSlotAirPower, requiredAirForState } = require('./air-power');
const { aircraftEquivalenceKey, capabilitiesFor } = require('./aircraft');
const {
  comparePlanScores,
  comparePlansForSort,
  inventoryCountsFor,
  isBaseFeasible,
  optimisticPlanScore,
  scorePlan,
  summarizeBase,
  summarizePlan,
  targetStateForBase,
} = require('./search-score');

const SLOTS_PER_BASE = 4;
const WAVES_PER_BASE = 2;
const DEFAULT_MAX_RESULTS = 10;
const SLOT_KINDS = Object.freeze({
  LOCKED_ITEM: 'LOCKED_ITEM',
  LOCKED_EMPTY: 'LOCKED_EMPTY',
  OPEN: 'OPEN',
});

/** Finds exact static LBAS plans with grouped branch-and-bound search. */
function optimizeLoadouts(options = {}) {
  const prepared = prepareSearch(options);
  if (!prepared.valid) {
    return invalidResult('branch-and-bound', prepared.budget, prepared.message);
  }

  const {
    baseCount,
    baseLocks,
    budget,
    enemyAir,
    groups,
    inventoryCounts,
    maxResults,
    targetRadius,
    waveTargets,
  } = prepared;
  const remainingCounts = groups.map((group) => group.instances.length);
  const selected = [];
  const retained = [];
  const retainedByKey = new Map();
  let nodesExplored = 0;
  let budgetExhausted = false;

  /** Visits one partial allocation and proves or bounds all descendants. */
  function visit(baseIndex) {
    if (nodesExplored >= budget) {
      budgetExhausted = true;
      return;
    }
    nodesExplored += 1;

    if (baseIndex === baseCount) {
      retainPlan(materializePlan(selected, prepared), retained, retainedByKey, maxResults);
      return;
    }

    const envelopes = [];
    for (let index = baseIndex; index < baseCount; index += 1) {
      const envelope = enumerateBaseEnvelope(
        baseLocks[index],
        remainingCounts,
        prepared,
        index,
      );
      if (!envelope.feasible) {
        return;
      }
      envelopes.push(envelope);
    }

    if (retained.length >= maxResults) {
      const upperBound = optimisticPlanScore(
        summarizePartial(selected),
        groups,
        { envelopes },
      );
      const kthScore = scorePlan(retained[retained.length - 1]);
      if (upperBound && comparePlanScores(upperBound, kthScore) < 0) {
        return;
      }
    }

    for (const candidate of envelopes[0].candidates) {
      subtractCounts(remainingCounts, candidate.counts);
      selected.push(candidate);
      visit(baseIndex + 1);
      selected.pop();
      addCounts(remainingCounts, candidate.counts);
      if (budgetExhausted) {
        return;
      }
    }
  }

  visit(0);
  retained.sort(comparePlansForSort);
  const status = budgetExhausted
    ? 'budget_exhausted'
    : retained.length
      ? 'optimal'
      : 'infeasible';
  const messages = [];
  if (status === 'infeasible') {
    messages.push(`No candidate loadout can reach radius ${targetRadius}.`);
  }
  if (status === 'budget_exhausted') {
    messages.push('Search node budget exhausted before optimality was proven.');
  }

  return {
    messages,
    results: retained,
    search: {
      mode: 'branch-and-bound',
      status,
      nodesExplored,
      budget,
      provenOptimal: !budgetExhausted,
    },
  };
}

/** Returns the production optimistic score for a fixed prefix of base loadouts. */
function optimisticScoreForPartial(options = {}, partialLoadouts = []) {
  const prepared = prepareSearch(options);
  if (!prepared.valid || partialLoadouts.length > prepared.baseCount) {
    return null;
  }

  const remainingCounts = prepared.groups.map((group) => group.instances.length);
  const selected = [];
  const seenIds = new Set();
  for (let baseIndex = 0; baseIndex < partialLoadouts.length; baseIndex += 1) {
    const candidate = candidateFromFixedLoadout(
      partialLoadouts[baseIndex],
      prepared,
      baseIndex,
      remainingCounts,
      seenIds,
    );
    if (!candidate) {
      return null;
    }
    subtractCounts(remainingCounts, candidate.counts);
    selected.push(candidate);
  }

  const envelopes = [];
  for (let baseIndex = partialLoadouts.length; baseIndex < prepared.baseCount; baseIndex += 1) {
    const envelope = enumerateBaseEnvelope(
      prepared.baseLocks[baseIndex],
      remainingCounts,
      prepared,
      baseIndex,
    );
    if (!envelope.feasible) {
      return null;
    }
    envelopes.push(envelope);
  }
  return optimisticPlanScore(summarizePartial(selected), prepared.groups, { envelopes });
}

/** Preserves the legacy one-base candidate API without fixed pool truncation. */
function generateBaseCandidates(equipment, targetRadius, enemyAir, slotConstraints = []) {
  const prepared = prepareSearch({
    equipment,
    baseCount: 1,
    targetRadius,
    enemyAir,
    targetStates: ['loss', 'loss'],
    lockedBases: [{ slots: slotConstraints }],
    nodeBudget: Infinity,
  });
  if (!prepared.valid) {
    return [];
  }
  const envelope = enumerateBaseEnvelope(
    prepared.baseLocks[0],
    prepared.groups.map((group) => group.instances.length),
    prepared,
    0,
  );
  return envelope.candidates.map((candidate) => summarizeBase(
    materializeConcreteCandidateLoadout(prepared.baseLocks[0], candidate.counts, prepared.groups),
    prepared.enemyAir,
    targetStateForBase(prepared.waveTargets, 0),
    prepared.inventoryCounts,
  ));
}

/** Validates inventory and globally reserves every locked instance. */
function prepareSearch(options) {
  const equipment = Array.isArray(options.equipment) ? options.equipment.filter(Boolean) : [];
  const inventoryById = new Map();
  for (const plane of equipment) {
    if (plane.instanceId == null || inventoryById.has(plane.instanceId)) {
      return invalidPreparation(options, 'Equipment instance IDs must be unique and non-null.');
    }
    inventoryById.set(plane.instanceId, plane);
  }

  const baseCount = Math.max(1, Math.min(3, Math.floor(Number(options.baseCount) || 1)));
  const normalizedLocks = normalizeLockedBases(options.lockedBases, baseCount, inventoryById);
  if (!normalizedLocks.valid) {
    return invalidPreparation(options, normalizedLocks.message);
  }

  const reservedIds = new Set();
  for (const base of normalizedLocks.bases) {
    for (const slot of base.slots) {
      if (slot.kind !== SLOT_KINDS.LOCKED_ITEM) continue;
      if (reservedIds.has(slot.plane.instanceId)) {
        return invalidPreparation(options, `Locked instance ID ${slot.plane.instanceId} is duplicated.`);
      }
      reservedIds.add(slot.plane.instanceId);
    }
  }

  const unlockedEquipment = equipment.filter((plane) => !reservedIds.has(plane.instanceId));
  const relevantEquipment = filterRadiusRelevantEquipment(
    unlockedEquipment,
    equipment,
    Math.max(0, Number(options.targetRadius) || 0),
  );
  const groups = groupEquipment(relevantEquipment);
  return {
    valid: true,
    equipment,
    inventoryById,
    inventoryCounts: inventoryCountsFor(equipment),
    baseCount,
    baseLocks: normalizedLocks.bases,
    groups,
    groupIndexByKey: new Map(groups.map((group, index) => [group.key, index])),
    targetRadius: Math.max(0, Number(options.targetRadius) || 0),
    enemyAir: Math.max(0, Number(options.enemyAir) || 0),
    waveTargets: normalizeWaveTargets(options.targetStates, baseCount),
    maxResults: Math.max(1, Math.floor(Number(options.maxResults) || DEFAULT_MAX_RESULTS)),
    budget: normalizeBudget(options.nodeBudget),
  };
}

/** Returns a minimal invalid preparation record with normalized budget. */
function invalidPreparation(options, message) {
  return {
    valid: false,
    message,
    budget: normalizeBudget(options.nodeBudget),
  };
}

/** Normalizes every slot into LOCKED_ITEM, LOCKED_EMPTY, or OPEN. */
function normalizeLockedBases(lockedBases, baseCount, inventoryById) {
  const bases = [];
  for (let baseIndex = 0; baseIndex < baseCount; baseIndex += 1) {
    const sourceSlots = lockedBases?.[baseIndex]?.slots || [];
    const slots = [];
    for (let slotIndex = 0; slotIndex < SLOTS_PER_BASE; slotIndex += 1) {
      const normalized = normalizeSlotConstraint(sourceSlots[slotIndex]);
      if (normalized.kind === SLOT_KINDS.LOCKED_ITEM) {
        const instanceId = normalized.plane?.instanceId ?? normalized.instanceId;
        if (instanceId == null || !inventoryById.has(instanceId)) {
          return { valid: false, message: `Locked instance ID ${instanceId} does not exist.` };
        }
        normalized.plane = inventoryById.get(instanceId);
      }
      slots.push(normalized);
    }
    bases.push({ slots });
  }
  return { valid: true, bases };
}

/** Normalizes current and legacy slot constraint shapes. */
function normalizeSlotConstraint(slot = {}) {
  slot = slot ?? {};
  const explicitKind = slot.kind || slot.state || slot.type;
  if (explicitKind === SLOT_KINDS.LOCKED_EMPTY) {
    return { kind: SLOT_KINDS.LOCKED_EMPTY, plane: null };
  }
  if (explicitKind === SLOT_KINDS.LOCKED_ITEM) {
    return { kind: SLOT_KINDS.LOCKED_ITEM, plane: slot.plane || null, instanceId: slot.instanceId };
  }
  if (explicitKind === SLOT_KINDS.OPEN) {
    return { kind: SLOT_KINDS.OPEN, plane: null };
  }
  if (slot.locked) {
    return slot.plane
      ? { kind: SLOT_KINDS.LOCKED_ITEM, plane: slot.plane }
      : { kind: SLOT_KINDS.LOCKED_EMPTY, plane: null };
  }
  return { kind: SLOT_KINDS.OPEN, plane: null };
}

/** Groups interchangeable aircraft and sorts instances for stable materialization. */
function groupEquipment(equipment) {
  const grouped = new Map();
  for (const plane of equipment) {
    const key = aircraftEquivalenceKey(plane);
    const group = grouped.get(key) || { key, representative: plane, instances: [] };
    group.instances.push(plane);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => ({
      ...group,
      slotAirPower: calculateSlotAirPower(group.representative),
      instances: group.instances.sort(compareInstanceIds),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** Enumerates every feasible grouped count assignment for one base. */
function enumerateBaseEnvelope(baseLock, remainingCounts, prepared, baseIndex) {
  const candidates = [];
  const counts = prepared.groups.map(() => 0);
  const openSlots = baseLock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length;
  const lockedAirPower = baseLock.slots
    .filter((slot) => slot.kind === SLOT_KINDS.LOCKED_ITEM)
    .reduce((total, slot) => total + calculateSlotAirPower(slot.plane), 0);
  const requiredAir = requiredAirForState(
    prepared.enemyAir,
    targetStateForBase(prepared.waveTargets, baseIndex),
  );
  const searchOrder = prepared.groups
    .map((_group, index) => index)
    .sort((left, right) =>
      prepared.groups[right].slotAirPower - prepared.groups[left].slotAirPower || left - right);

  /** Recurses over group counts while leaving any unused open slots empty. */
  function enumerate(orderIndex, slotsLeft, selectedAirPower) {
    if (!canReachRequiredAir(
      searchOrder,
      orderIndex,
      slotsLeft,
      selectedAirPower + lockedAirPower,
      remainingCounts,
      prepared.groups,
      requiredAir,
    )) {
      return;
    }
    if (orderIndex === searchOrder.length) {
      const loadout = materializeRepresentativeLoadout(baseLock, counts, prepared.groups);
      const targetState = targetStateForBase(prepared.waveTargets, baseIndex);
      const summary = summarizeBase(
        loadout,
        prepared.enemyAir,
        targetState,
        prepared.inventoryCounts,
        { details: false },
      );
      if (!isBaseFeasible(summary, prepared.targetRadius)) {
        return;
      }
      const candidate = {
        counts: [...counts],
        summary,
        score: scorePlan({
          totalDamagePower: summary.damagePower,
          totalResourceCost: summary.resourceCost,
          worstMargin: summary.marginToTarget,
          scarcityCost: summary.scarcityCost,
          canonicalKey: canonicalBaseCountKey(baseLock, counts, prepared.groups, openSlots),
        }),
      };
      candidates.push(candidate);
      return;
    }

    const groupIndex = searchOrder[orderIndex];
    const maximum = Math.min(remainingCounts[groupIndex], slotsLeft);
    for (let count = 0; count <= maximum; count += 1) {
      counts[groupIndex] = count;
      enumerate(
        orderIndex + 1,
        slotsLeft - count,
        selectedAirPower + count * prepared.groups[groupIndex].slotAirPower,
      );
    }
    counts[groupIndex] = 0;
  }

  enumerate(0, openSlots, 0);
  candidates.sort((left, right) => -comparePlanScores(left.score, right.score));
  if (!candidates.length) {
    return { feasible: false, candidates: [] };
  }
  return {
    feasible: true,
    candidates,
    maxDamage: Math.max(...candidates.map((candidate) => candidate.summary.damagePower)),
    maxMargin: Math.max(...candidates.map((candidate) => candidate.summary.marginToTarget)),
    minResource: Math.min(...candidates.map((candidate) => candidate.summary.resourceCost)),
    minScarcity: Math.min(...candidates.map((candidate) => candidate.summary.scarcityCost)),
  };
}

/** Proves an air target impossible using a recon-relaxed slot-air upper bound. */
function canReachRequiredAir(
  searchOrder,
  orderIndex,
  slotsLeft,
  selectedAirPower,
  remainingCounts,
  groups,
  requiredAir,
) {
  if (requiredAir <= 0) return true;
  let optimisticRawAir = selectedAirPower;
  let capacity = slotsLeft;
  for (let index = orderIndex; index < searchOrder.length && capacity > 0; index += 1) {
    const groupIndex = searchOrder[index];
    const count = Math.min(capacity, remainingCounts[groupIndex]);
    optimisticRawAir += count * groups[groupIndex].slotAirPower;
    capacity -= count;
  }
  return Math.floor(optimisticRawAir * 1.18) >= requiredAir;
}

/** Removes only aircraft that no possible recon partner can extend to target range. */
function filterRadiusRelevantEquipment(unlockedEquipment, allEquipment, targetRadius) {
  if (targetRadius <= 0) return unlockedEquipment;
  const maximumReconRadius = allEquipment.reduce((maximum, plane) => {
    const capabilities = capabilitiesFor(plane);
    return capabilities.isRecon || plane.isRecon
      ? Math.max(maximum, Math.max(0, Number(plane.radius) || 0))
      : maximum;
  }, 0);
  return unlockedEquipment.filter((plane) => {
    const radius = Math.max(0, Number(plane.radius) || 0);
    if (radius >= targetRadius) return true;
    const capabilities = capabilitiesFor(plane);
    if (capabilities.blocksRangeExtension || plane.blocksRangeExtension) return false;
    if (maximumReconRadius <= radius) return false;
    const extended = Math.round(radius + Math.min(Math.sqrt(maximumReconRadius - radius), 3));
    return extended >= targetRadius;
  });
}

/** Fills open slots with group representatives in canonical group order. */
function materializeRepresentativeLoadout(baseLock, counts, groups) {
  const loadout = baseLock.slots.map((slot) =>
    slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
  const selected = [];
  counts.forEach((count, groupIndex) => {
    for (let index = 0; index < count; index += 1) {
      selected.push(groups[groupIndex].representative);
    }
  });
  let selectedIndex = 0;
  baseLock.slots.forEach((slot, slotIndex) => {
    if (slot.kind === SLOT_KINDS.OPEN) {
      loadout[slotIndex] = selected[selectedIndex] || null;
      selectedIndex += 1;
    }
  });
  return loadout;
}

/** Materializes stable concrete IDs for the legacy one-base candidate API. */
function materializeConcreteCandidateLoadout(baseLock, counts, groups) {
  const loadout = baseLock.slots.map((slot) =>
    slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
  const selected = [];
  counts.forEach((count, groupIndex) => {
    selected.push(...groups[groupIndex].instances.slice(0, count));
  });
  let selectedIndex = 0;
  baseLock.slots.forEach((slot, slotIndex) => {
    if (slot.kind === SLOT_KINDS.OPEN) {
      loadout[slotIndex] = selected[selectedIndex] || null;
      selectedIndex += 1;
    }
  });
  return loadout;
}

/** Materializes stable instance IDs only after a complete count plan is found. */
function materializePlan(selected, prepared) {
  const cursors = prepared.groups.map(() => 0);
  const loadouts = selected.map((candidate, baseIndex) => {
    const loadout = prepared.baseLocks[baseIndex].slots.map((slot) =>
      slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
    const chosen = [];
    candidate.counts.forEach((count, groupIndex) => {
      for (let index = 0; index < count; index += 1) {
        chosen.push(prepared.groups[groupIndex].instances[cursors[groupIndex]]);
        cursors[groupIndex] += 1;
      }
    });
    let chosenIndex = 0;
    prepared.baseLocks[baseIndex].slots.forEach((slot, slotIndex) => {
      if (slot.kind === SLOT_KINDS.OPEN) {
        loadout[slotIndex] = chosen[chosenIndex] || null;
        chosenIndex += 1;
      }
    });
    return loadout;
  });
  return summarizePlan(loadouts, prepared);
}

/** Retains a deduplicated Top K without limiting the search itself. */
function retainPlan(plan, retained, retainedByKey, maxResults) {
  const existing = retainedByKey.get(plan.canonicalKey);
  if (existing && comparePlanScores(plan, existing) <= 0) {
    return;
  }
  if (existing) {
    retained.splice(retained.indexOf(existing), 1);
  }
  retainedByKey.set(plan.canonicalKey, plan);
  retained.push(plan);
  retained.sort(comparePlansForSort);
  if (retained.length > maxResults) {
    const removed = retained.pop();
    retainedByKey.delete(removed.canonicalKey);
  }
}

/** Summarizes exact selected bases for optimistic score composition. */
function summarizePartial(selected) {
  const bases = selected.map((candidate) => candidate.summary);
  return {
    bases,
    totalDamagePower: bases.reduce((total, base) => total + base.damagePower, 0),
    totalResourceCost: bases.reduce((total, base) => total + base.resourceCost, 0),
    scarcityCost: bases.reduce((total, base) => total + base.scarcityCost, 0),
    worstMargin: bases.length
      ? Math.min(...bases.map((base) => base.marginToTarget))
      : Number.POSITIVE_INFINITY,
  };
}

/** Converts a fixed concrete prefix loadout into grouped counts and a summary. */
function candidateFromFixedLoadout(loadout, prepared, baseIndex, remainingCounts, seenIds) {
  const normalized = Array.from({ length: SLOTS_PER_BASE }, (_, index) => loadout?.[index] || null);
  const counts = prepared.groups.map(() => 0);
  for (let slotIndex = 0; slotIndex < SLOTS_PER_BASE; slotIndex += 1) {
    const plane = normalized[slotIndex];
    const slotLock = prepared.baseLocks[baseIndex].slots[slotIndex];
    if (slotLock.kind === SLOT_KINDS.LOCKED_EMPTY && plane) {
      return null;
    }
    if (slotLock.kind === SLOT_KINDS.LOCKED_ITEM) {
      if (!plane || plane.instanceId !== slotLock.plane.instanceId || seenIds.has(plane.instanceId)) {
        return null;
      }
      seenIds.add(plane.instanceId);
      normalized[slotIndex] = slotLock.plane;
      continue;
    }
    if (!plane) {
      continue;
    }
    if (plane.instanceId == null || seenIds.has(plane.instanceId) || !prepared.inventoryById.has(plane.instanceId)) {
      return null;
    }
    seenIds.add(plane.instanceId);
    const groupIndex = prepared.groupIndexByKey.get(aircraftEquivalenceKey(plane));
    if (groupIndex == null) {
      return null;
    }
    counts[groupIndex] += 1;
    if (counts[groupIndex] > remainingCounts[groupIndex]) {
      return null;
    }
  }
  const summary = summarizeBase(
    normalized,
    prepared.enemyAir,
    targetStateForBase(prepared.waveTargets, baseIndex),
    prepared.inventoryCounts,
    { details: false },
  );
  return isBaseFeasible(summary, prepared.targetRadius) ? { counts, summary } : null;
}

/** Subtracts a candidate's group usage from remaining inventory. */
function subtractCounts(remainingCounts, counts) {
  counts.forEach((count, index) => {
    remainingCounts[index] -= count;
  });
}

/** Restores a candidate's group usage after recursion. */
function addCounts(remainingCounts, counts) {
  counts.forEach((count, index) => {
    remainingCounts[index] += count;
  });
}

/** Builds the same one-base canonical key directly from equivalence counts. */
function canonicalBaseCountKey(baseLock, counts, groups, openSlots) {
  const groupCounts = new Map();
  let emptyCount = baseLock.slots.filter((slot) => slot.kind === SLOT_KINDS.LOCKED_EMPTY).length;
  for (const slot of baseLock.slots) {
    if (slot.kind !== SLOT_KINDS.LOCKED_ITEM) continue;
    const key = aircraftEquivalenceKey(slot.plane);
    groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
  }
  let selectedCount = 0;
  counts.forEach((count, groupIndex) => {
    if (!count) return;
    selectedCount += count;
    const key = groups[groupIndex].key;
    groupCounts.set(key, (groupCounts.get(key) || 0) + count);
  });
  emptyCount += openSlots - selectedCount;
  return JSON.stringify([{
    empty: emptyCount,
    groups: [...groupCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  }]);
}

/** Orders arbitrary instance IDs deterministically without numeric coercion. */
function compareInstanceIds(left, right) {
  return String(left.instanceId).localeCompare(String(right.instanceId));
}

/** Normalizes one or two target states per base with a parity fallback. */
function normalizeWaveTargets(targetStates, baseCount) {
  const states = (Array.isArray(targetStates) ? targetStates : [])
    .filter((state) => AIR_STATES[state]);
  const fallback = states[0] || 'parity';
  return Array.from(
    { length: baseCount * WAVES_PER_BASE },
    (_, index) => states[index] || fallback,
  );
}

/** Normalizes a finite nonnegative node budget or keeps Infinity explicit. */
function normalizeBudget(value) {
  if (value === Number.POSITIVE_INFINITY || value == null) {
    return Number.POSITIVE_INFINITY;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : Number.POSITIVE_INFINITY;
}

/** Returns the common invalid-input result shape. */
function invalidResult(mode, budget, message) {
  return {
    messages: [message],
    results: [],
    search: {
      mode,
      status: 'invalid_input',
      nodesExplored: 0,
      budget,
      provenOptimal: false,
    },
  };
}

module.exports = {
  SLOT_KINDS,
  generateBaseCandidates,
  normalizeLockedBases,
  normalizeWaveTargets,
  optimizeLoadouts,
  optimisticScoreForPartial,
  prepareSearch,
};
