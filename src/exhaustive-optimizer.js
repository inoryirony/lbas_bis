'use strict';

const { AIR_STATES, calculateEffectiveRadius } = require('./air-power');
const { aircraftEquivalenceKey } = require('./aircraft');
const {
  comparePlanScores,
  comparePlansForSort,
  inventoryCountsFor,
  isBaseFeasible,
  summarizeBase,
  summarizePlan,
  targetStateForBase,
} = require('./search-score');

const SLOTS_PER_BASE = 4;
const WAVES_PER_BASE = 2;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_ITEM_LIMIT = 12;

/**
 * Independently enumerates concrete instance subsets for small optimizer cases.
 * @param {Record<string, any>} [options] Inventory, targets, locks, and oracle limits.
 * @returns {Record<string, any>} Messages, ranked plans, and exhaustive search metadata.
 */
function exhaustiveOptimize(options = {}) {
  const prepared = prepareExhaustive(options);
  if (!prepared.valid) {
    return invalidResult(prepared.budget, prepared.message);
  }

  const retained = [];
  const retainedByKey = new Map();
  const selectedLoadouts = [];
  let nodesExplored = 0;
  let budgetExhausted = false;

  /** Recurses by concrete remaining instances without production groups or pruning. */
  function visit(baseIndex, available) {
    if (nodesExplored >= prepared.budget) {
      budgetExhausted = true;
      return;
    }
    nodesExplored += 1;

    if (baseIndex === prepared.baseCount) {
      const plan = summarizePlan(selectedLoadouts, prepared);
      retainPlan(plan, retained, retainedByKey, prepared.maxResults);
      return;
    }

    const lock = prepared.baseLocks[baseIndex];
    const openCount = lock.slots.filter((slot) => slot.kind === 'OPEN').length;
    for (const choice of enumerateInstanceSubsets(available, openCount)) {
      const loadout = materializeConcreteLoadout(lock, choice.selected);
      const base = summarizeBase(
        loadout,
        prepared.enemyAir,
        targetStateForBase(prepared.waveTargets, baseIndex),
        prepared.inventoryCounts,
        { details: false },
      );
      if (!isBaseFeasible(base, prepared.targetRadius)) {
        continue;
      }
      selectedLoadouts.push(loadout);
      visit(baseIndex + 1, choice.remaining);
      selectedLoadouts.pop();
      if (budgetExhausted) {
        return;
      }
    }
  }

  visit(0, prepared.available);
  retained.sort(comparePlansForSort);
  const status = budgetExhausted
    ? 'budget_exhausted'
    : retained.length
      ? 'optimal'
      : 'infeasible';
  return {
    messages: status === 'infeasible'
      ? [exhaustiveInfeasibleMessage(prepared)]
      : status === 'budget_exhausted'
        ? ['Search node budget exhausted before optimality was proven.']
        : [],
    results: retained,
    search: {
      mode: 'exhaustive',
      status,
      nodesExplored,
      budget: prepared.budget,
      provenOptimal: !budgetExhausted,
    },
  };
}

/** Distinguishes relaxed radius impossibility from target-air infeasibility. */
function exhaustiveInfeasibleMessage(prepared) {
  const radiusFeasible = prepared.baseLocks.every((lock) => {
    const openCount = lock.slots.filter((slot) => slot.kind === 'OPEN').length;
    return enumerateInstanceSubsets(prepared.available, openCount).some((choice) =>
      calculateEffectiveRadius(materializeConcreteLoadout(lock, choice.selected).filter(Boolean)) >=
        prepared.targetRadius);
  });
  return radiusFeasible
    ? 'No loadout can satisfy the target air state.'
    : `No candidate loadout can reach radius ${prepared.targetRadius}.`;
}

/** Validates exhaustive input and reserves locked instances independently. */
function prepareExhaustive(options) {
  const equipment = Array.isArray(options.equipment) ? options.equipment.filter(Boolean) : [];
  const budget = normalizeBudget(options.nodeBudget);
  const itemLimit = Math.max(0, Math.floor(Number(options.exhaustiveItemLimit) || DEFAULT_ITEM_LIMIT));
  if (equipment.length > itemLimit) {
    return { valid: false, budget, message: `Exhaustive inventory limit ${itemLimit} exceeded.` };
  }

  const inventoryById = new Map();
  for (const plane of equipment) {
    if (plane.instanceId == null || inventoryById.has(plane.instanceId)) {
      return { valid: false, budget, message: 'Equipment instance IDs must be unique and non-null.' };
    }
    inventoryById.set(plane.instanceId, plane);
  }

  const baseCount = Math.max(1, Math.min(3, Math.floor(Number(options.baseCount) || 1)));
  const locks = normalizeExhaustiveLocks(options.lockedBases, baseCount, inventoryById);
  if (!locks.valid) {
    return { valid: false, budget, message: locks.message };
  }
  const reservedIds = new Set();
  for (const base of locks.bases) {
    for (const slot of base.slots) {
      if (slot.kind !== 'LOCKED_ITEM') continue;
      if (reservedIds.has(slot.plane.instanceId)) {
        return {
          valid: false,
          budget,
          message: `Locked instance ID ${slot.plane.instanceId} is duplicated.`,
        };
      }
      reservedIds.add(slot.plane.instanceId);
    }
  }

  return {
    valid: true,
    equipment,
    available: equipment.filter((plane) => !reservedIds.has(plane.instanceId)).sort(compareConcretePlanes),
    inventoryCounts: inventoryCountsFor(equipment),
    baseCount,
    baseLocks: locks.bases,
    targetRadius: Math.max(0, Number(options.targetRadius) || 0),
    enemyAir: Math.max(0, Number(options.enemyAir) || 0),
    waveTargets: normalizeWaveTargets(options.targetStates, baseCount),
    maxResults: Math.max(1, Math.floor(Number(options.maxResults) || DEFAULT_MAX_RESULTS)),
    budget,
  };
}

/** Normalizes locks without importing production normalization code. */
function normalizeExhaustiveLocks(lockedBases, baseCount, inventoryById) {
  const bases = [];
  for (let baseIndex = 0; baseIndex < baseCount; baseIndex += 1) {
    const sourceSlots = lockedBases?.[baseIndex]?.slots || [];
    const slots = [];
    for (let slotIndex = 0; slotIndex < SLOTS_PER_BASE; slotIndex += 1) {
      const slot = sourceSlots[slotIndex] || {};
      const explicitKind = slot.kind || slot.state || slot.type;
      if (explicitKind === 'OPEN') {
        slots.push({ kind: 'OPEN', plane: null });
        continue;
      }
      if (explicitKind === 'LOCKED_EMPTY' || (slot.locked && !slot.plane)) {
        slots.push({ kind: 'LOCKED_EMPTY', plane: null });
        continue;
      }
      if (explicitKind === 'LOCKED_ITEM' || (slot.locked && slot.plane)) {
        const instanceId = slot.plane?.instanceId ?? slot.instanceId;
        if (instanceId == null || !inventoryById.has(instanceId)) {
          return { valid: false, message: `Locked instance ID ${instanceId} does not exist.` };
        }
        slots.push({ kind: 'LOCKED_ITEM', plane: inventoryById.get(instanceId) });
        continue;
      }
      slots.push({ kind: 'OPEN', plane: null });
    }
    bases.push({ slots });
  }
  return { valid: true, bases };
}

/** Enumerates concrete selected/remaining subsets up to the slot capacity. */
function enumerateInstanceSubsets(items, maximumSelected) {
  const output = [];

  /** Chooses or skips each concrete instance exactly once. */
  function choose(index, selected, remaining) {
    if (index === items.length) {
      output.push({ selected: [...selected], remaining: [...remaining] });
      return;
    }
    remaining.push(items[index]);
    choose(index + 1, selected, remaining);
    remaining.pop();
    if (selected.length < maximumSelected) {
      selected.push(items[index]);
      choose(index + 1, selected, remaining);
      selected.pop();
    }
  }

  choose(0, [], []);
  return output;
}

/** Fills open slots from a canonically sorted concrete subset. */
function materializeConcreteLoadout(lock, selected) {
  const chosen = [...selected].sort(compareConcretePlanes);
  const loadout = lock.slots.map((slot) => slot.kind === 'LOCKED_ITEM' ? slot.plane : null);
  let chosenIndex = 0;
  lock.slots.forEach((slot, slotIndex) => {
    if (slot.kind === 'OPEN') {
      loadout[slotIndex] = chosen[chosenIndex] || null;
      chosenIndex += 1;
    }
  });
  return loadout;
}

/** Retains one representative of each canonical count plan. */
function retainPlan(plan, retained, retainedByKey, maxResults) {
  const existing = retainedByKey.get(plan.canonicalKey);
  if (existing && comparePlanScores(plan, existing) <= 0) return;
  if (existing) retained.splice(retained.indexOf(existing), 1);
  retainedByKey.set(plan.canonicalKey, plan);
  retained.push(plan);
  retained.sort(comparePlansForSort);
  if (retained.length > maxResults) {
    const removed = retained.pop();
    retainedByKey.delete(removed.canonicalKey);
  }
}

/** Orders instances by equivalence key, then stable instance ID. */
function compareConcretePlanes(left, right) {
  return aircraftEquivalenceKey(left).localeCompare(aircraftEquivalenceKey(right)) ||
    String(left.instanceId).localeCompare(String(right.instanceId));
}

/** Normalizes two static wave targets per base. */
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
  if (value === Number.POSITIVE_INFINITY || value == null) return Number.POSITIVE_INFINITY;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : Number.POSITIVE_INFINITY;
}

/** Returns invalid-input metadata in the exhaustive result shape. */
function invalidResult(budget, message) {
  return {
    messages: [message],
    results: [],
    search: {
      mode: 'exhaustive',
      status: 'invalid_input',
      nodesExplored: 0,
      budget,
      provenOptimal: false,
    },
  };
}

module.exports = {
  exhaustiveOptimize,
};
