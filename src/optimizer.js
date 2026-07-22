'use strict';

const {
  AIR_STATES,
  calculateEffectiveRadius,
  calculateSlotAirPower,
  defaultSlotSizeForPlane,
  landReconCoefficient,
  requiredAirForState,
} = require('./air-power');
const { aircraftEquivalenceKey, capabilitiesFor } = require('./aircraft');
const { validateCombatContext } = require('./combat-context');
const {
  calculateBaseDamagePower,
  calculatePlaneSurfaceTargetPowerProxy,
  landBasedReconDamageModifier,
} = require('./damage');
const { validateAndNormalizeDetailedEnemySlots } = require('./enemy-slots');
const { createFixedSampleRandom } = require('./random');
const { validateSampleCount } = require('./simulation-options');
const {
  createDetailedScoreContext,
  evaluateDetailedPlanScore,
  maximumDetailedExpectedDamage,
} = require('./wave-simulator');
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
const DEFAULT_NODE_BUDGET = 100000;
const DEFAULT_SIMULATION_WORK_BUDGET = Number.POSITIVE_INFINITY;
const STATIC_AIR_BOUND_WEIGHTS = Object.freeze([0, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32]);
const STATIC_RECON_DAMAGE_MODIFIERS = Object.freeze([1, 1.125, 1.15]);
const DETAILED_DAMAGE_COEFFICIENTS = Object.freeze([1, 1.125, 1.15]);
const SLOT_KINDS = Object.freeze({
  LOCKED_ITEM: 'LOCKED_ITEM',
  LOCKED_EMPTY: 'LOCKED_EMPTY',
  OPEN: 'OPEN',
});

/**
 * Finds exact static LBAS plans with grouped branch-and-bound search.
 * @param {Record<string, any>} [options] Inventory, targets, locks, and search limits.
 * @returns {Record<string, any>} Messages, ranked plans, and proof-aware search metadata.
 */
function optimizeLoadouts(options = {}) {
  const prepared = prepareSearch(options);
  if (!prepared.valid) {
    return invalidResult(
      'branch-and-bound',
      prepared.budget,
      prepared.message,
      prepared.errors,
      prepared.simulationBudget,
    );
  }

  if (!prepared.detailed && prepared.maxResults === 1 && !Number.isFinite(prepared.budget)) {
    return optimizeStaticRankOne(prepared, options);
  }
  if (prepared.detailed && prepared.maxResults === 1 &&
      !Number.isFinite(prepared.budget) && !Number.isFinite(prepared.simulationBudget)) {
    const exact = optimizeDetailedRankOne(prepared, options);
    if (exact) return exact;
  }

  const {
    baseCount,
    baseLocks,
    budget,
    detailed,
    enemyAir,
    groups,
    inventoryCounts,
    maxResults,
    targetRadius,
    waveTargets,
  } = prepared;
  prepared.detailedRequiredAirByBase = Array(baseCount).fill(null);
  const remainingCounts = groups.map((group) => group.instances.length);
  const relaxedBaseDamageUpperBounds = baseLocks.map((baseLock, baseIndex) => {
    const searchOrder = orderedGroupIndices(prepared, baseIndex, 0);
    const counts = groups.map(() => 0);
    return maximumStaticBaseDamage(
      baseLock,
      counts,
      remainingCounts,
      groups,
      searchOrder,
      0,
      baseLock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length,
      detailed
        ? 0
        : requiredAirForState(enemyAir, targetStateForBase(waveTargets, baseIndex)),
      null,
      null,
      prepared.combatContext,
    );
  });
  const selected = [];
  const retained = [];
  const retainedByKey = new Map();
  const simulationBudgetState = createSimulationBudgetState(prepared.simulationBudget);
  const detailedDamageUpperCache = new Map();
  const detailedAirBoundCache = new Map();
  let candidatesEvaluated = 0;
  let damageUpperBoundEvaluations = 0;
  let numericScoreEvaluations = 0;
  let dynamicAirBoundEvaluations = 0;
  let hasFeasibleIncumbent = false;
  let cancelled = false;
  let currentPhase = 'finding_feasible';
  const startedAt = Date.now();
  const progressSnapshot = () => ({
    phase: currentPhase,
    nodesExplored: budgetState.nodesExplored,
    nodesPruned: budgetState.nodesPruned,
    candidatesEvaluated,
    simulationSamplesEvaluated: simulationBudgetState.samplesEvaluated,
    elapsedMs: Date.now() - startedAt,
    completedWork: null,
    totalWork: null,
  });
  const budgetState = createBudgetState(budget, () => {
    options.onProgress?.(progressSnapshot());
  });
  prepared.canPruneZeroFulfillment = () => hasFeasibleIncumbent;
  prepared.isCancelled = () => {
    if (!cancelled && options.isCancelled?.()) cancelled = true;
    return cancelled;
  };

  function considerCompletePlan() {
    const incumbentScore = retained.length >= maxResults
      ? scorePlan(retained[retained.length - 1])
      : null;
    const loadouts = materializeLoadouts(selected, prepared);
    if (detailed && incumbentScore?.fulfillment === 1) {
      const maximumDamage = loadouts.reduce(
        (total, base, baseIndex) => total + detailedDamageUpperForBase(base, baseIndex),
        0,
      );
      if (maximumDamage < incumbentScore.damage) {
        candidatesEvaluated += 1;
        return false;
      }
    }
    if (detailed && incumbentScore) {
      if (!reserveSimulationSamples(
        simulationBudgetState,
        prepared.simulationOptions.sampleCount,
      )) return false;
      const evaluation = evaluateDetailedPlanScore({
        bases: loadouts,
        baseCacheKeys: selected.map((candidate) => candidate.score.canonicalKey),
        enemy: prepared.enemy,
        enemyFleets: prepared.enemyFleets,
        targetStates: waveTargets,
        combatContext: prepared.combatContext,
        ...prepared.simulationOptions,
        incumbentScore,
      });
      numericScoreEvaluations += 1;
      recordSimulationSamples(
        simulationBudgetState,
        evaluation.samplesEvaluated ?? prepared.simulationOptions.sampleCount,
      );
      if (evaluation.prunedBySimulationBound) {
        candidatesEvaluated += 1;
        return false;
      }
    }
    if (detailed && !reserveSimulationSamples(
      simulationBudgetState,
      prepared.simulationOptions.sampleCount,
    )) return false;
    const plan = summarizePlan(loadouts, incumbentScore
      ? {
        ...prepared,
        simulationOptions: {
          ...prepared.simulationOptions,
          incumbentScore,
        },
      }
      : prepared);
    if (detailed) {
      recordSimulationSamples(
        simulationBudgetState,
        plan.simulation?.samplesEvaluated ?? prepared.simulationOptions.sampleCount,
      );
    }
    if (plan.prunedBySimulationBound) {
      candidatesEvaluated += 1;
      return false;
    }
    return considerPlan(plan);
  }

  /** Returns a cached fixed-sample damage upper bound for one selected base. */
  function detailedDamageUpperForBase(base, baseIndex) {
    const cacheKey = `${baseIndex}:${selected[baseIndex].score.canonicalKey}`;
    if (!detailedDamageUpperCache.has(cacheKey)) {
      detailedDamageUpperCache.set(cacheKey, maximumDetailedExpectedDamage({
        bases: [base],
        baseIndexOffset: baseIndex,
        combatContext: prepared.combatContext,
        ...prepared.simulationOptions,
      }));
      damageUpperBoundEvaluations += 1;
    }
    return detailedDamageUpperCache.get(cacheKey);
  }

  /** Returns the necessary initial air for the next base from exact prefix enemy states. */
  function detailedRequiredAirForPrefix(baseIndex) {
    if (!detailed || baseIndex <= 0 || !selected.length) return 0;
    const cacheKey = selected.map((candidate) => candidate.score.canonicalKey).join('|');
    if (detailedAirBoundCache.has(cacheKey)) return detailedAirBoundCache.get(cacheKey);
    if (!reserveSimulationSamples(
      simulationBudgetState,
      prepared.simulationOptions.sampleCount,
    )) return Number.POSITIVE_INFINITY;
    const evaluation = evaluateDetailedPlanScore({
      bases: materializeLoadouts(selected, prepared),
      baseCacheKeys: selected.map((candidate) => candidate.score.canonicalKey),
      enemy: prepared.enemy,
      enemyFleets: prepared.enemyFleets,
      targetStates: waveTargets.slice(0, selected.length * WAVES_PER_BASE),
      combatContext: prepared.combatContext,
      ...prepared.simulationOptions,
    });
    recordSimulationSamples(
      simulationBudgetState,
      evaluation.samplesEvaluated ?? prepared.simulationOptions.sampleCount,
    );
    dynamicAirBoundEvaluations += 1;
    const firstWaveIndex = baseIndex * WAVES_PER_BASE;
    let requiredAir;
    if (prepared.simulationOptions.dispatchMode === 'separate') {
      requiredAir = Math.max(
        ...evaluation.maximumFinalEnemyAir.map((enemyAirValue, targetIndex) =>
          requiredAirForState(
            enemyAirValue,
            waveTargets[firstWaveIndex + targetIndex] || waveTargets[firstWaveIndex] || 'parity',
          )),
      );
    } else {
      requiredAir = requiredAirForState(
        evaluation.maximumFinalEnemyAir[0] || 0,
        waveTargets[firstWaveIndex] || waveTargets[0] || 'parity',
      );
    }
    detailedAirBoundCache.set(cacheKey, requiredAir);
    return requiredAir;
  }

  function considerPlan(plan) {
    candidatesEvaluated += 1;
    const targetFeasible = isTargetFeasibleIncumbent(plan, detailed);
    if (targetFeasible && !hasFeasibleIncumbent) {
      hasFeasibleIncumbent = true;
      removeZeroFulfillmentPlans(retained, retainedByKey);
      currentPhase = 'improving';
      options.onPhaseChange?.(currentPhase);
    }
    const changedRankOne = detailed && hasFeasibleIncumbent && !targetFeasible
      ? false
      : retainPlan(plan, retained, retainedByKey, maxResults);
    if (changedRankOne && targetFeasible) {
      options.onIncumbent?.(plan, {
        phase: currentPhase,
        nodesExplored: budgetState.nodesExplored,
        candidatesEvaluated,
        simulationSamplesEvaluated: simulationBudgetState.samplesEvaluated,
      });
    }
    if (hasFeasibleIncumbent && currentPhase === 'improving') {
      currentPhase = 'proving_optimal';
      options.onPhaseChange?.(currentPhase);
    }
    return targetFeasible;
  }

  /** Visits one partial allocation and proves or bounds all descendants. */
  function visit(baseIndex) {
    if (prepared.isCancelled()) return;
    if (simulationBudgetState.exhausted) return;
    if (!consumeBudget(budgetState)) return;

    if (baseIndex === baseCount) {
      considerCompletePlan();
      return;
    }

    if (detailed && baseIndex > 0) {
      prepared.detailedRequiredAirByBase[baseIndex] = detailedRequiredAirForPrefix(baseIndex);
      if (simulationBudgetState.exhausted) return;
    }

    walkBaseAssignments(
      baseLocks[baseIndex],
      remainingCounts,
      prepared,
      baseIndex,
      budgetState,
      'branch',
      (candidate) => {
        subtractCounts(remainingCounts, candidate.counts);
        selected.push(candidate);
        visit(baseIndex + 1);
        selected.pop();
        addCounts(remainingCounts, candidate.counts);
        return !budgetState.exhausted && !simulationBudgetState.exhausted;
      },
      ({
          counts,
          searchOrder,
          orderIndex,
          slotsLeft,
          staticBoundContext,
          selectedGroupIndices,
        }) => {
          if (retained.length < maxResults) return false;
          const selectedDamage = selected.reduce(
            (total, candidate) => total + candidate.summary.damagePower,
            0,
          );
          const currentBaseUpper = maximumStaticBaseDamage(
            baseLocks[baseIndex],
            counts,
            remainingCounts,
            groups,
            searchOrder,
            orderIndex,
            slotsLeft,
            detailed
              ? 0
              : requiredAirForState(
                enemyAir,
                targetStateForBase(waveTargets, baseIndex),
              ),
            staticBoundContext(),
            selectedGroupIndices,
            prepared.combatContext,
          );
          const futureUpper = relaxedBaseDamageUpperBounds
            .slice(baseIndex + 1)
            .reduce((total, damage) => total + damage, 0);
          const kthScore = scorePlan(retained[retained.length - 1]);
          if (detailed) {
            return comparePlanScores({
              fulfillment: 1,
              damage: 2 * (selectedDamage + currentBaseUpper + futureUpper),
              loss: 0,
              resource: 0,
              margin: Number.MAX_VALUE,
              scarcity: 0,
              canonicalKey: '',
            }, kthScore) < 0;
          }
          const kthDamage = kthScore.damage;
          return selectedDamage + currentBaseUpper + futureUpper < kthDamage;
        },
    );
  }

  function seedIncumbent() {
    const candidatesByBase = baseLocks.map((baseLock, baseIndex) =>
      buildStaticSeedCandidates(baseLock, prepared, baseIndex, options));
    if (candidatesByBase.some((candidates) => candidates.length === 0)) return;
    const seedPlans = [];
    const seedPlansByKey = new Map();
    const seedLoadouts = [];
    const usedIds = new Set();
    const maximumCombinations = Math.max(
      1,
      Number(options.seedCombinationBudget) || 100000,
    );
    const suffixDamage = Array(baseCount + 1).fill(0);
    for (let baseIndex = baseCount - 1; baseIndex >= 0; baseIndex -= 1) {
      suffixDamage[baseIndex] = suffixDamage[baseIndex + 1] +
        candidatesByBase[baseIndex][0].summary.damagePower;
    }
    let combinationsVisited = 0;

    function combine(baseIndex, selectedDamage) {
      if (prepared.isCancelled() || combinationsVisited >= maximumCombinations) return;
      if (seedPlans.length >= maxResults &&
          selectedDamage + suffixDamage[baseIndex] < seedPlans.at(-1).totalDamagePower) {
        return;
      }
      if (baseIndex === baseCount) {
        const seedContext = detailed ? { ...prepared, detailed: false } : prepared;
        retainPlan(
          summarizePlan(seedLoadouts, seedContext),
          seedPlans,
          seedPlansByKey,
          maxResults,
        );
        return;
      }
      for (const candidate of candidatesByBase[baseIndex]) {
        combinationsVisited += 1;
        if (candidate.instanceIds.some((instanceId) => usedIds.has(instanceId))) continue;
        if (seedPlans.length >= maxResults && selectedDamage +
            candidate.summary.damagePower + suffixDamage[baseIndex + 1] <
            seedPlans.at(-1).totalDamagePower) {
          break;
        }
        candidate.instanceIds.forEach((instanceId) => usedIds.add(instanceId));
        seedLoadouts.push(candidate.loadout);
        combine(baseIndex + 1, selectedDamage + candidate.summary.damagePower);
        seedLoadouts.pop();
        candidate.instanceIds.forEach((instanceId) => usedIds.delete(instanceId));
        if (prepared.isCancelled() || combinationsVisited >= maximumCombinations) break;
      }
    }

    combine(0, 0);
    seedPlans.sort(comparePlansForSort);
    for (let index = seedPlans.length - 1; index >= 0; index -= 1) {
      let plan = seedPlans[index];
      if (detailed) {
        if (!reserveSimulationSamples(
          simulationBudgetState,
          prepared.simulationOptions.sampleCount,
        )) break;
        plan = summarizePlan(
          plan.bases.map((base) => base.loadout),
          prepared,
        );
        recordSimulationSamples(
          simulationBudgetState,
          plan.simulation?.samplesEvaluated ?? prepared.simulationOptions.sampleCount,
        );
      }
      considerPlan(plan);
      if (prepared.isCancelled()) break;
    }
    options.onProgress?.(progressSnapshot());
  }

  if (baseCount > 1 && maxResults === 1 && !Number.isFinite(budget)) {
    seedIncumbent();
  }
  visit(0);
  if (detailed && !hasFeasibleIncumbent) {
    removeZeroFulfillmentPlans(retained, retainedByKey);
  }
  retained.sort(comparePlansForSort);
  options.onProgress?.(progressSnapshot());
  const exhausted = budgetState.exhausted || simulationBudgetState.exhausted;
  const status = cancelled
    ? 'cancelled'
    : exhausted
    ? 'budget_exhausted'
    : retained.length
      ? 'optimal'
      : 'infeasible';
  const messages = [];
  if (status === 'infeasible') {
    messages.push(infeasibleMessage(prepared, remainingCounts));
  }
  if (status === 'budget_exhausted') {
    messages.push('Search or simulation work budget exhausted before optimality was proven.');
  }
  if (status === 'cancelled') {
    messages.push('Search cancelled; the current best plan is preserved but is not proven optimal.');
  }

  return {
    messages,
    results: retained,
    search: {
      mode: 'branch-and-bound',
      status,
      nodesExplored: budgetState.nodesExplored,
      budget,
      simulationSamplesEvaluated: simulationBudgetState.samplesEvaluated,
      candidatesEvaluated,
      damageUpperBoundEvaluations,
      numericScoreEvaluations,
      dynamicAirBoundEvaluations,
      simulationBudget: simulationBudgetState.budget,
      provenOptimal: status === 'optimal' || status === 'infeasible',
    },
  };
}

/**
 * Returns the production optimistic score for a fixed prefix of base loadouts.
 * @param {Record<string, any>} [options] Optimizer input without a required budget.
 * @param {Array<Array<Record<string, any> | null>>} [partialLoadouts] Fixed base prefix.
 * @returns {Record<string, any> | null} Optimistic score, or null when no completion exists.
 */
function optimisticScoreForPartial(options = {}, partialLoadouts = []) {
  const prepared = prepareSearch(options);
  if (!prepared.valid || prepared.detailed || partialLoadouts.length > prepared.baseCount) {
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
  const budgetState = createBudgetState(Number.POSITIVE_INFINITY);
  for (let baseIndex = partialLoadouts.length; baseIndex < prepared.baseCount; baseIndex += 1) {
    const envelope = calculateBaseEnvelope(
      prepared.baseLocks[baseIndex],
      remainingCounts,
      prepared,
      baseIndex,
      budgetState,
    );
    if (!envelope.feasible) {
      return null;
    }
    envelopes.push(envelope);
  }
  return optimisticPlanScore(summarizePartial(selected), prepared.groups, { envelopes });
}

/**
 * Preserves the legacy one-base candidate API without fixed pool truncation.
 * @param {Array<Record<string, any>>} equipment Concrete equipment instances.
 * @param {number} targetRadius Required effective radius.
 * @param {number} enemyAir Static enemy air power.
 * @param {Array<Record<string, any> | null>} [slotConstraints] Legacy slot locks.
 * @returns {Array<Record<string, any>>} Every feasible one-base summary.
 */
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
  const candidates = [];
  const budgetState = createBudgetState(Number.POSITIVE_INFINITY);
  walkBaseAssignments(
    prepared.baseLocks[0],
    prepared.groups.map((group) => group.instances.length),
    prepared,
    0,
    budgetState,
    'branch',
    (candidate) => {
      candidates.push(candidate);
      return true;
    },
  );
  candidates.sort((left, right) => -comparePlanScores(left.score, right.score));
  return candidates.map((candidate) => summarizeBase(
    materializeConcreteCandidateLoadout(prepared.baseLocks[0], candidate.counts, prepared.groups),
    prepared.enemyAir,
    targetStateForBase(prepared.waveTargets, 0),
    prepared.inventoryCounts,
    { combatContext: prepared.combatContext },
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
  const combatValidation = validateCombatContext(options.combatContext);
  if (!combatValidation.valid) {
    return invalidPreparation(
      options,
      combatValidation.errors[0].message,
      combatValidation.errors,
    );
  }
  const combatContext = combatValidation.context;
  const inventoryCounts = inventoryCountsFor(equipment);

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
  let groups = groupEquipment(relevantEquipment, combatContext);
  const enemyFleetInputs = Array.isArray(options.enemyFleets)
    ? options.enemyFleets
    : Array.isArray(options.targets) ? options.targets : null;
  const detailed = isDetailedEnemy(options.enemy) ||
    Array.isArray(options.enemySlots) ||
    Boolean(enemyFleetInputs?.length);
  const detailedGroupsBefore = groups.length;
  if (detailed) {
    const openCapacity = normalizedLocks.bases.reduce(
      (total, base) => total + base.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length,
      0,
    );
    groups = removeDetailedCapacityDominatedGroups(
      groups,
      openCapacity,
      combatContext,
      inventoryCounts,
    );
  }
  const detailedGroupsRemoved = detailedGroupsBefore - groups.length;
  const rawSimulationOptions = {
    ...(options.simulation || {}),
    ...(options.simulationOptions || {}),
  };
  const dispatchMode = options.dispatchMode ||
    rawSimulationOptions.dispatchMode ||
    (enemyFleetInputs ? 'separate' : 'concentrated');
  const simulationBudget = detailed
    ? normalizeWorkBudget(options.simulationWorkBudget, DEFAULT_SIMULATION_WORK_BUDGET)
    : 0;
  if (enemyFleetInputs && (
    enemyFleetInputs.length !== 2 || enemyFleetInputs[0] === enemyFleetInputs[1]
  )) {
    const error = separateEnemyValidationError('enemyFleets', enemyFleetInputs.length);
    return invalidPreparation(options, error.message, [error], simulationBudget);
  }
  if (detailed && dispatchMode === 'separate' && !enemyFleetInputs) {
    const error = separateEnemyValidationError('enemyFleets', 0);
    return invalidPreparation(options, error.message, [error], simulationBudget);
  }
  const sampleValidation = detailed
    ? validateSampleCount(
      options.sampleCount ?? rawSimulationOptions.sampleCount,
      { path: 'simulationOptions.sampleCount' },
    )
    : { valid: true, sampleCount: null, errors: [] };
  if (!sampleValidation.valid) {
    return invalidPreparation(
      options,
      sampleValidation.errors[0].message,
      sampleValidation.errors,
      simulationBudget,
    );
  }
  let enemy = options.enemy;
  let enemyFleets = enemyFleetInputs;
  if (detailed) {
    const normalizedEnemies = enemyFleetInputs
      ? enemyFleetInputs.map((fleet, index) =>
        validateOptimizerEnemy(fleet, undefined, `enemyFleets[${index}].slots`))
      : [validateOptimizerEnemy(options.enemy, options.enemySlots, 'enemy.slots')];
    const errors = normalizedEnemies.flatMap((result) => result.errors);
    if (errors.length) {
      return invalidPreparation(options, errors[0].message, errors);
    }
    if (enemyFleetInputs) {
      enemyFleets = normalizedEnemies.map((result) => result.enemy);
    } else {
      enemy = normalizedEnemies[0].enemy;
    }
  }
  const detailedEnemyAir = detailed
    ? initialDetailedEnemyAir(enemyFleets?.[0] || enemy)
    : Math.max(0, Number(options.enemyAir) || 0);
  const fixedRandom = detailed
    ? (typeof rawSimulationOptions.fixedRandom === 'function'
      ? rawSimulationOptions.fixedRandom
      : createFixedSampleRandom(
        rawSimulationOptions.seed ?? 0,
        sampleValidation.sampleCount,
      ))
    : null;
  const waveTargets = normalizeWaveTargets(options.targetStates, baseCount);
  const scoreContext = detailed ? createDetailedScoreContext({
    enemy,
    enemyFleets,
    targetStates: waveTargets,
    baseCount,
    combatContext,
    ...rawSimulationOptions,
    sampleCount: sampleValidation.sampleCount,
    dispatchMode,
    fixedRandom,
  }) : null;
  return {
    valid: true,
    equipment,
    inventoryById,
    inventoryCounts,
    baseCount,
    baseLocks: normalizedLocks.bases,
    groups,
    groupIndexByKey: new Map(groups.map((group, index) => [group.key, index])),
    targetRadius: Math.max(0, Number(options.targetRadius) || 0),
    enemyAir: detailedEnemyAir,
    enemy,
    enemyFleets,
    combatContext,
    detailed,
    detailedGroupsBefore,
    detailedGroupsRemoved,
    simulationOptions: {
      ...rawSimulationOptions,
      ...(detailed ? { sampleCount: sampleValidation.sampleCount } : {}),
      dispatchMode,
      ...(detailed ? { fixedRandom } : {}),
      ...(detailed ? { scoreContext } : {}),
    },
    waveTargets,
    maxResults: Math.max(1, Math.floor(Number(options.maxResults) || DEFAULT_MAX_RESULTS)),
    budget: normalizeBudget(
      options.nodeBudget,
      detailed ? Number.POSITIVE_INFINITY : DEFAULT_NODE_BUDGET,
    ),
    simulationBudget,
    isCancelled: typeof options.isCancelled === 'function' ? options.isCancelled : null,
  };
}

/** Returns a minimal invalid preparation record with normalized budget. */
function invalidPreparation(
  options,
  message,
  errors = [],
  simulationBudget = normalizeWorkBudget(
    options.simulationWorkBudget,
    DEFAULT_SIMULATION_WORK_BUDGET,
  ),
) {
  return {
    valid: false,
    message,
    errors,
    budget: normalizeBudget(options.nodeBudget),
    simulationBudget,
  };
}

/** Creates the structured optimizer error for an invalid separate target list. */
function separateEnemyValidationError(path, count) {
  return {
    code: 'INVALID_SEPARATE_ENEMY_FLEETS',
    path,
    field: 'enemyFleets',
    value: count,
    message: 'Separate dispatch requires exactly two independent enemy fleets.',
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
function groupEquipment(equipment, combatContext) {
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
      damagePower: calculateBaseDamagePower([group.representative], { combatContext }),
      instances: group.instances.sort(compareInstanceIds),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** Removes a detailed group only when strictly stronger copies cover every open slot. */
function removeDetailedCapacityDominatedGroups(
  groups,
  openCapacity,
  combatContext,
  inventoryCounts,
) {
  if (openCapacity <= 0) return groups;
  const features = groups.map((group) =>
    detailedDominanceFeature(group, combatContext, inventoryCounts));
  return groups.filter((_group, candidateIndex) => {
    let dominatingCapacity = 0;
    for (let replacementIndex = 0; replacementIndex < groups.length; replacementIndex += 1) {
      if (replacementIndex === candidateIndex ||
          !strictlyDominatesDetailed(
            features[replacementIndex],
            features[candidateIndex],
          )) continue;
      dominatingCapacity += groups[replacementIndex].instances.length;
      if (dominatingCapacity >= openCapacity) return false;
    }
    return true;
  });
}

/** Precomputes every slot-dependent value needed by conservative detailed dominance. */
function detailedDominanceFeature(group, combatContext, inventoryCounts) {
  const plane = group.representative;
  const capabilities = capabilitiesFor(plane);
  const hasCapability = (name) => plane[name] === true || capabilities[name] === true;
  const slotSize = Math.max(
    0,
    Math.ceil(Number(
      plane.currentSlot ?? plane.slotSize ?? defaultSlotSizeForPlane(plane),
    ) || 0),
  );
  const isJet = hasCapability('isJet');
  const lossModifier = isJet
    ? 0.6
    : hasCapability('isAswPatrol') && !hasCapability('isAttacker') ? 0.91 : 1;
  const behaviorKey = JSON.stringify([
    slotSize,
    hasCapability('isRecon'),
    hasCapability('isLandRecon'),
    hasCapability('blocksRangeExtension'),
    isJet,
    plane.isEscortItem === true,
    lossModifier,
    landReconCoefficient([plane]),
    landBasedReconDamageModifier([plane]),
  ]);
  return {
    behaviorKey,
    key: group.key,
    radius: Math.max(0, Number(plane.radius) || 0),
    scarcity: (plane.missing || plane.available === false ? 1000 : 0) +
      1 / Math.max(1, inventoryCounts.get(group.key) || 1),
    jetSteelCost: isJet
      ? Math.max(0, Number(plane.cost) || 0) * (hasCapability('isHeavyJet') ? 1.2 : 1)
      : 0,
    airBySlot: Array.from({ length: slotSize + 1 }, (_unused, slot) =>
      calculateSlotAirPower({ ...plane, currentSlot: slot })),
    damageByCoefficient: DETAILED_DAMAGE_COEFFICIENTS.map((reconModifier) =>
      Array.from({ length: slotSize + 1 }, (_unused, slot) =>
        calculatePlaneSurfaceTargetPowerProxy(plane, {
          currentSlot: slot,
          reconModifier,
          combatContext,
        }))),
  };
}

/** Requires a one-for-one replacement that cannot lose in any simulated score field. */
function strictlyDominatesDetailed(replacement, candidate) {
  if (replacement.behaviorKey !== candidate.behaviorKey ||
      replacement.radius < candidate.radius ||
      replacement.airBySlot.some((value, index) => value < candidate.airBySlot[index])) {
    return false;
  }
  const damageNonWorse = replacement.damageByCoefficient.every((damageBySlot, coefficientIndex) =>
    damageBySlot.every((value, slot) =>
      value >= candidate.damageByCoefficient[coefficientIndex][slot]));
  if (!damageNonWorse) return false;
  const damageStrict = replacement.damageByCoefficient.every((damageBySlot, coefficientIndex) =>
    damageBySlot.slice(1).every((value, slotOffset) =>
      value > candidate.damageByCoefficient[coefficientIndex][slotOffset + 1]));
  if (damageStrict) return true;
  const damageEqual = replacement.damageByCoefficient.every((damageBySlot, coefficientIndex) =>
    damageBySlot.every((value, slot) =>
      value === candidate.damageByCoefficient[coefficientIndex][slot]));
  const airStrict = replacement.airBySlot.slice(1).every((value, slotOffset) =>
    value > candidate.airBySlot[slotOffset + 1]);
  return damageEqual && airStrict &&
    replacement.jetSteelCost <= candidate.jetSteelCost &&
    replacement.scarcity <= candidate.scarcity &&
    replacement.key < candidate.key;
}

/** Routes static rank-1 searches through the exact capacity-frontier solver. */
function optimizeStaticRankOne(prepared, options) {
  const { solveStaticExact } = require('./static-exact-solver');
  const exact = solveStaticExact(prepared, {
    nodeBudget: prepared.budget,
    isCancelled: options.isCancelled,
    onIncumbent: options.onIncumbent,
    onPhaseChange: options.onPhaseChange,
    onProgress: options.onProgress,
  });
  const stopped = !exact.provenOptimal;
  const cancelled = exact.solverStats.status === 'cancelled';
  const status = exact.provenOptimal
    ? exact.plan ? 'optimal' : 'infeasible'
    : cancelled ? 'cancelled' : 'budget_exhausted';
  const messages = [];
  if (status === 'infeasible') messages.push(infeasibleMessage(prepared, []));
  if (status === 'budget_exhausted') {
    messages.push('Search or simulation work budget exhausted before optimality was proven.');
  }
  if (status === 'cancelled') {
    messages.push('Search cancelled; the current best plan is preserved but is not proven optimal.');
  }
  return {
    messages,
    results: exact.plan ? [exact.plan] : [],
    search: {
      mode: 'branch-and-bound',
      backend: exact.solverStats.backend,
      status,
      nodesExplored: exact.solverStats.nodesExplored,
      budget: prepared.budget,
      simulationSamplesEvaluated: 0,
      candidatesEvaluated: exact.solverStats.combinationsEvaluated,
      simulationBudget: 0,
      provenOptimal: !stopped,
      solverStats: exact.solverStats,
    },
  };
}

/** Builds a small, diverse physical-aircraft pool for fast incumbent construction. */
function buildStaticSeedPool(prepared, options) {
  if (options.isCancelled?.()) return [];
  const maximumPoolSize = Math.max(8, Number(options.seedPoolLimit) || 32);
  const maximumCopies = prepared.baseCount * SLOTS_PER_BASE;
  const bySignature = new Map();
  let visitedPlanes = 0;
  for (const plane of prepared.groups.flatMap((group) => group.instances)) {
    visitedPlanes += 1;
    if ((visitedPlanes & 255) === 0 && options.isCancelled?.()) return [];
    const features = staticSeedFeatures(plane, prepared.combatContext);
    const signature = Object.values(features).join(':');
    const copies = bySignature.get(signature) || [];
    if (copies.length < maximumCopies) copies.push({ plane, features });
    bySignature.set(signature, copies);
  }
  let remaining = [...bySignature.values()].flat();
  const pool = [];
  const layerCount = Math.max(1, Number(options.seedParetoLayers) || 2);
  for (let layer = 0;
    (layer < layerCount || pool.length < maximumCopies) && remaining.length;
    layer += 1) {
    if (options.isCancelled?.()) return [];
    const frontier = remaining.filter((candidate, candidateIndex) =>
      !remaining.some((other, otherIndex) => otherIndex !== candidateIndex &&
        dominatesStaticSeedFeatures(other.features, candidate.features)));
    pool.push(...frontier);
    const frontierIds = new Set(frontier.map(({ plane }) => plane.instanceId));
    remaining = remaining.filter(({ plane }) => !frontierIds.has(plane.instanceId));
  }
  if (pool.length <= maximumPoolSize) return pool.map(({ plane }) => plane);

  const selected = new Map();
  const weights = [0, 0.125, 0.25, 0.5, 1, 2, 4, 8];
  for (const airWeight of weights) {
    const ranked = [...pool].sort((left, right) =>
      (right.features.damage + airWeight * right.features.air) -
      (left.features.damage + airWeight * left.features.air));
    for (const candidate of ranked.slice(0, Math.ceil(maximumPoolSize / weights.length))) {
      selected.set(candidate.plane.instanceId, candidate.plane);
    }
  }
  for (const candidate of pool) {
    if (selected.size >= maximumPoolSize) break;
    selected.set(candidate.plane.instanceId, candidate.plane);
  }
  return [...selected.values()].slice(0, maximumPoolSize);
}

function staticSeedFeatures(plane, combatContext) {
  return {
    air: calculateSlotAirPower(plane),
    damage: calculatePlaneSurfaceTargetPowerProxy(plane, { combatContext }),
    radius: Math.max(0, Number(plane.radius) || 0),
    reconAir: landReconCoefficient([plane]),
    reconDamage: landBasedReconDamageModifier([plane]),
  };
}

function dominatesStaticSeedFeatures(left, right) {
  const keys = ['air', 'damage', 'radius', 'reconAir', 'reconDamage'];
  return keys.every((key) => left[key] >= right[key]) &&
    keys.some((key) => left[key] > right[key]);
}

/** Enumerates feasible per-base seeds from the bounded Pareto pool. */
function buildStaticSeedCandidates(baseLock, prepared, baseIndex, options) {
  if (options.isCancelled?.()) return [];
  const pool = buildStaticSeedPool(prepared, options);
  const openIndices = baseLock.slots
    .map((slot, slotIndex) => slot.kind === SLOT_KINDS.OPEN ? slotIndex : -1)
    .filter((slotIndex) => slotIndex >= 0);
  if (pool.length < openIndices.length) return [];
  const loadout = baseLock.slots.map((slot) =>
    slot.kind === SLOT_KINDS.LOCKED_ITEM ? slot.plane : null);
  const candidates = [];
  const maximumCandidates = Math.max(1, Number(options.seedCandidateLimit) || 4096);
  let visits = 0;
  let cancelled = false;

  function enumerate(startIndex, openIndex) {
    visits += 1;
    if ((visits & 1023) === 0 && options.isCancelled?.()) {
      cancelled = true;
      return;
    }
    if (openIndex === openIndices.length) {
      const summary = summarizeBase(
        loadout,
        prepared.enemyAir,
        targetStateForBase(prepared.waveTargets, baseIndex),
        prepared.inventoryCounts,
        { details: false, combatContext: prepared.combatContext },
      );
      if (!isBaseFeasible(summary, prepared.targetRadius)) return;
      const concrete = [...loadout];
      const instanceIds = concrete.filter(Boolean).map((plane) => plane.instanceId);
      candidates.push({
        loadout: concrete,
        instanceIds,
        summary,
        score: scorePlan({
          totalDamagePower: summary.damagePower,
          totalResourceCost: summary.resourceCost,
          worstMargin: summary.marginToTarget,
          scarcityCost: summary.scarcityCost,
          canonicalKey: instanceIds.slice().sort().join('|'),
        }),
      });
      return;
    }
    const needed = openIndices.length - openIndex;
    for (let poolIndex = startIndex; poolIndex <= pool.length - needed; poolIndex += 1) {
      loadout[openIndices[openIndex]] = pool[poolIndex];
      enumerate(poolIndex + 1, openIndex + 1);
      if (cancelled) return;
    }
    loadout[openIndices[openIndex]] = null;
  }

  enumerate(0, 0);
  if (cancelled) return [];
  candidates.sort((left, right) => -comparePlanScores(left.score, right.score));
  return candidates.slice(0, maximumCandidates);
}

/** Keeps every group that can appear in a nondominated final-base loadout. */
function staticDominanceSearchOrder(searchOrder, remainingCounts, prepared, slotCapacity) {
  if (slotCapacity <= 0) return [];
  const layerLimit = slotCapacity + prepared.maxResults - 1;
  const features = prepared.groups.map((group) => {
    const plane = group.representative;
    const capabilities = capabilitiesFor(plane);
    const summary = summarizeBase(
      [plane],
      prepared.enemyAir,
      'none',
      prepared.inventoryCounts,
      { details: false, combatContext: prepared.combatContext },
    );
    return {
      feasibility: [
        calculateSlotAirPower(plane),
        Math.max(0, Number(plane.radius) || 0),
        landReconCoefficient([plane]),
        landBasedReconDamageModifier([plane]),
        capabilities.isRecon || plane.isRecon ? 1 : 0,
        capabilities.blocksRangeExtension || plane.blocksRangeExtension ? 0 : 1,
      ],
      damage: STATIC_RECON_DAMAGE_MODIFIERS.map((modifier) =>
        calculatePlaneSurfaceTargetPowerProxy(plane, {
          reconModifier: modifier,
          combatContext: prepared.combatContext,
        })),
      resource: summary.resourceCost,
      scarcity: summary.scarcityCost,
    };
  });
  let remaining = searchOrder.flatMap((groupIndex) =>
    Array.from(
      { length: Math.min(slotCapacity, remainingCounts[groupIndex]) },
      (_unused, copyIndex) => ({ groupIndex, copyIndex }),
    ));
  const retainedGroups = new Set();
  for (let layer = 0; layer < layerLimit && remaining.length; layer += 1) {
    const frontier = remaining.filter((candidate, candidateIndex) =>
      !remaining.some((other, otherIndex) => otherIndex !== candidateIndex &&
        dominatesStaticVector(features[other.groupIndex], features[candidate.groupIndex])));
    frontier.forEach(({ groupIndex }) => retainedGroups.add(groupIndex));
    const frontierTokens = new Set(frontier.map(({ groupIndex, copyIndex }) =>
      `${groupIndex}:${copyIndex}`));
    remaining = remaining.filter(({ groupIndex, copyIndex }) =>
      !frontierTokens.has(`${groupIndex}:${copyIndex}`));
  }
  return searchOrder.filter((groupIndex) => retainedGroups.has(groupIndex));
}

function dominatesStaticVector(left, right) {
  if (!left.feasibility.every((value, index) => value >= right.feasibility[index])) {
    return false;
  }
  if (left.damage.every((value, index) => value > right.damage[index])) return true;
  if (!left.damage.every((value, index) => value >= right.damage[index])) return false;
  if (left.resource < right.resource) return true;
  if (left.resource > right.resource || left.scarcity > right.scarcity) return false;
  return left.damage.some((value, index) => value > right.damage[index]) ||
    left.feasibility.some((value, index) => value > right.feasibility[index]) ||
    left.scarcity < right.scarcity;
}

/** Streams grouped count assignments without retaining the candidate set. */
function walkBaseAssignments(
  baseLock,
  remainingCounts,
  prepared,
  baseIndex,
  budgetState,
  mode,
  onCandidate,
  prunePartial = null,
) {
  if (mode === 'branch') {
    return walkBaseAssignmentsBySlots(
      baseLock,
      remainingCounts,
      prepared,
      baseIndex,
      budgetState,
      onCandidate,
      prunePartial,
    );
  }
  const counts = prepared.groups.map(() => 0);
  const openSlots = baseLock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length;
  const lockedAirPower = baseLock.slots
    .filter((slot) => slot.kind === SLOT_KINDS.LOCKED_ITEM)
    .reduce((total, slot) => total + calculateSlotAirPower(slot.plane), 0);
  const requiredAir = requiredAirForState(
    prepared.enemyAir,
    targetStateForBase(prepared.waveTargets, baseIndex),
  );
  const firstWaveRequiredAir = baseIndex === 0
    ? requiredAirForState(prepared.enemyAir, prepared.waveTargets[0] || 'parity')
    : 0;
  const searchOrder = orderedGroupIndices(prepared, baseIndex, requiredAir);
  let boundContext = null;
  const staticBoundContext = () => {
    if (!boundContext) {
      boundContext = buildStaticSuffixDamageBounds(
        remainingCounts,
        prepared.groups,
        searchOrder,
        prepared.combatContext,
      );
    }
    return boundContext;
  };

  /** Recurses in shared-score order while leaving unused open slots empty. */
  function enumerate(orderIndex, slotsLeft, selectedAirPower) {
    if (prepared.isCancelled?.()) return false;
    if (budgetState.exhausted) return false;
    if (prepared.detailed && orderIndex < searchOrder.length &&
        !consumeBudget(budgetState)) return false;
    if (prunePartial?.({
      counts,
      searchOrder,
      orderIndex,
      slotsLeft,
      selectedAirPower,
      lockedAirPower,
      staticBoundContext,
    })) {
      budgetState.nodesPruned += 1;
      return prepared.detailed ? true : consumeBudget(budgetState);
    }
    if (!canReachRequiredAir(
      searchOrder,
      orderIndex,
      slotsLeft,
      selectedAirPower + lockedAirPower,
      remainingCounts,
      prepared.groups,
      prepared.detailed
        ? (prepared.canPruneZeroFulfillment?.() ? firstWaveRequiredAir : 0)
        : requiredAir,
    )) {
      budgetState.nodesPruned += 1;
      return consumeBudget(budgetState);
    }
    if (orderIndex === searchOrder.length || slotsLeft === 0) {
      const loadout = materializeRepresentativeLoadout(baseLock, counts, prepared.groups);
      const targetState = targetStateForBase(prepared.waveTargets, baseIndex);
      const summary = summarizeBase(
        loadout,
        prepared.enemyAir,
        targetState,
        prepared.inventoryCounts,
        { details: false, combatContext: prepared.combatContext },
      );
      const feasible = prepared.detailed
        ? summary.radius >= prepared.targetRadius
        : isBaseFeasible(summary, prepared.targetRadius);
      if (!feasible) return consumeBudget(budgetState);
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
      if (mode === 'envelope' && !consumeBudget(budgetState)) return false;
      return onCandidate(candidate) !== false;
    }

    const groupIndex = searchOrder[orderIndex];
    const maximum = Math.min(remainingCounts[groupIndex], slotsLeft);
    const countOrder = prepared.detailed
      ? orderedDetailedCounts(
        maximum,
        prepared.groups[groupIndex],
        Math.max(0, requiredAir - selectedAirPower - lockedAirPower),
      )
      : orderedCounts(maximum, prepared.groups[groupIndex], requiredAir);
    for (const count of countOrder) {
      counts[groupIndex] = count;
      const completed = enumerate(
        orderIndex + 1,
        slotsLeft - count,
        selectedAirPower + count * prepared.groups[groupIndex].slotAirPower,
      );
      if (!completed) {
        counts[groupIndex] = 0;
        return false;
      }
    }
    counts[groupIndex] = 0;
    return true;
  }

  return enumerate(0, openSlots, 0);
}

/** Enumerates selected slots directly instead of recursing through zero-count groups. */
function walkBaseAssignmentsBySlots(
  baseLock,
  remainingCounts,
  prepared,
  baseIndex,
  budgetState,
  onCandidate,
  prunePartial,
) {
  const counts = prepared.groups.map(() => 0);
  const openSlots = baseLock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length;
  const lockedAirPower = baseLock.slots
    .filter((slot) => slot.kind === SLOT_KINDS.LOCKED_ITEM)
    .reduce((total, slot) => total + calculateSlotAirPower(slot.plane), 0);
  const targetState = targetStateForBase(prepared.waveTargets, baseIndex);
  const requiredAir = requiredAirForState(prepared.enemyAir, targetState);
  const dynamicDetailedRequiredAir = prepared.detailedRequiredAirByBase?.[baseIndex];
  const searchRequiredAir = prepared.detailed
    ? (dynamicDetailedRequiredAir != null && Number.isFinite(dynamicDetailedRequiredAir)
      ? dynamicDetailedRequiredAir
      : baseIndex === 0 && prepared.canPruneZeroFulfillment?.()
        ? requiredAirForState(prepared.enemyAir, prepared.waveTargets[0] || 'parity')
        : 0)
    : requiredAir;
  let searchOrder = orderedGroupIndices(prepared, baseIndex, requiredAir);
  if (!prepared.detailed && prepared.maxResults === 1) {
    const remainingSlotCapacity = prepared.baseLocks
      .slice(baseIndex)
      .reduce((total, lock) => total +
        lock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length, 0);
    searchOrder = staticDominanceSearchOrder(
      searchOrder,
      remainingCounts,
      prepared,
      remainingSlotCapacity,
    );
  }
  let boundContext = null;
  const staticBoundContext = () => {
    if (!boundContext) {
      boundContext = buildStaticSuffixDamageBounds(
        remainingCounts,
        prepared.groups,
        searchOrder,
        prepared.combatContext,
      );
    }
    return boundContext;
  };
  const selectedGroupIndices = [];

  function enumerate(startPosition, slotsLeft, selectedAirPower) {
    if (prepared.isCancelled?.()) return false;
    if (budgetState.exhausted) return false;
    if (prunePartial?.({
      counts,
      searchOrder,
      orderIndex: startPosition,
      slotsLeft,
      selectedAirPower,
      lockedAirPower,
      staticBoundContext,
      selectedGroupIndices,
    })) {
      budgetState.nodesPruned += 1;
      return consumeBudget(budgetState);
    }
    const optimisticRawAir = selectedAirPower + lockedAirPower +
      staticBoundContext().maximumRawAir(startPosition, slotsLeft);
    if (Math.floor(optimisticRawAir * 1.18) < searchRequiredAir) {
      budgetState.nodesPruned += 1;
      return consumeBudget(budgetState);
    }

    if (slotsLeft > 0) {
      for (let position = startPosition; position < searchOrder.length; position += 1) {
        const groupIndex = searchOrder[position];
        if (counts[groupIndex] >= remainingCounts[groupIndex]) continue;
        counts[groupIndex] += 1;
        selectedGroupIndices.push(groupIndex);
        const nextPosition = counts[groupIndex] >= remainingCounts[groupIndex]
          ? position + 1
          : position;
        const completed = enumerate(
          nextPosition,
          slotsLeft - 1,
          selectedAirPower + prepared.groups[groupIndex].slotAirPower,
        );
        selectedGroupIndices.pop();
        counts[groupIndex] -= 1;
        if (!completed) return false;
      }
    }

    const loadout = materializeRepresentativeLoadout(baseLock, counts, prepared.groups);
    const summary = summarizeBase(
      loadout,
      prepared.enemyAir,
      targetState,
      prepared.inventoryCounts,
      { details: false, combatContext: prepared.combatContext },
    );
    const feasible = prepared.detailed
      ? summary.radius >= prepared.targetRadius
      : isBaseFeasible(summary, prepared.targetRadius);
    if (!feasible) {
      return consumeBudget(budgetState);
    }
    return onCandidate({
      counts: [...counts],
      summary,
      score: scorePlan({
        totalDamagePower: summary.damagePower,
        totalResourceCost: summary.resourceCost,
        worstMargin: summary.marginToTarget,
        scarcityCost: summary.scarcityCost,
        canonicalKey: canonicalBaseCountKey(baseLock, counts, prepared.groups, openSlots),
      }),
    }) !== false;
  }

  return enumerate(0, openSlots, 0);
}

/**
 * Returns an exact damage-only upper bound for one partially enumerated static base.
 * Range and air constraints are intentionally relaxed, while land-recon modifiers
 * still consume a real slot so the bound remains useful without becoming heuristic.
 */
function maximumStaticBaseDamage(
  baseLock,
  counts,
  remainingCounts,
  groups,
  searchOrder,
  orderIndex,
  slotsLeft,
  requiredAir,
  boundContext = null,
  selectedGroupIndices = null,
  combatContext = null,
) {
  const fixedPlanes = baseLock.slots
    .filter((slot) => slot.kind === SLOT_KINDS.LOCKED_ITEM)
    .map((slot) => slot.plane);
  if (selectedGroupIndices) {
    for (const groupIndex of selectedGroupIndices) {
      fixedPlanes.push(groups[groupIndex].representative);
    }
  } else {
    for (let groupIndex = 0; groupIndex < counts.length; groupIndex += 1) {
      for (let count = 0; count < counts[groupIndex]; count += 1) {
        fixedPlanes.push(groups[groupIndex].representative);
      }
    }
  }

  const allowed = searchOrder.slice(orderIndex);
  const requiredRawAir = Math.ceil(requiredAir / 1.18);
  const fixedRawAir = fixedPlanes.reduce(
    (total, plane) => total + calculateSlotAirPower(plane),
    0,
  );
  const rawAirDeficit = Math.max(0, requiredRawAir - fixedRawAir);
  const fixedModifier = landBasedReconDamageModifier(fixedPlanes);
  let maximum = Number.NEGATIVE_INFINITY;
  for (const modifier of STATIC_RECON_DAMAGE_MODIFIERS) {
    if (modifier < fixedModifier) continue;
    const requiredProvider = modifier > fixedModifier ? modifier : null;
    const fixedDamage = fixedPlanes.reduce(
      (total, plane) => total + calculatePlaneSurfaceTargetPowerProxy(
        plane,
        { reconModifier: modifier, combatContext },
      ),
      0,
    );
    let modifierMaximum = Number.POSITIVE_INFINITY;
    for (const airWeight of STATIC_AIR_BOUND_WEIGHTS) {
      const remainingUpper = boundContext
        ? boundContext.maximum(
          orderIndex,
          slotsLeft,
          modifier,
          requiredProvider,
          airWeight,
        )
        : maximumRemainingPlaneDamage(
          allowed,
          slotsLeft,
          modifier,
          counts,
          remainingCounts,
          groups,
          requiredProvider,
          airWeight,
          combatContext,
        );
      if (!Number.isFinite(remainingUpper)) continue;
      modifierMaximum = Math.min(
        modifierMaximum,
        fixedDamage + remainingUpper - airWeight * rawAirDeficit,
      );
    }
    if (Number.isFinite(modifierMaximum)) {
      maximum = Math.max(maximum, modifierMaximum);
    }
  }
  return Number.isFinite(maximum) ? maximum : 0;
}

/** Routes unlimited detailed rank-1 searches through reusable per-base frontiers. */
function optimizeDetailedRankOne(prepared, options) {
  const { solveDetailedExact } = require('./detailed-exact-solver');
  const exact = solveDetailedExact(prepared, {
    isCancelled: options.isCancelled,
    onIncumbent: options.onIncumbent,
    onPhaseChange: options.onPhaseChange,
    onProgress: options.onProgress,
  });
  if (exact.solverStats.stopReason === 'no_full_fulfillment_seed') return null;
  const cancelled = exact.solverStats.status === 'cancelled';
  const status = exact.provenOptimal
    ? exact.plan ? 'optimal' : 'infeasible'
    : cancelled ? 'cancelled' : 'budget_exhausted';
  return {
    messages: cancelled
      ? ['Search cancelled; the current best plan is preserved but is not proven optimal.']
      : exact.provenOptimal ? []
        : ['Search work stopped before optimality was proven.'],
    results: exact.plan ? [exact.plan] : [],
    search: {
      mode: 'branch-and-bound',
      backend: exact.solverStats.backend,
      status,
      nodesExplored: exact.solverStats.nodesExplored,
      budget: prepared.budget,
      simulationSamplesEvaluated: exact.solverStats.simulationSamplesEvaluated,
      candidatesEvaluated: exact.solverStats.candidatesEvaluated ??
        exact.solverStats.combinationsEvaluated,
      damageUpperBoundEvaluations: exact.solverStats.damageUpperBoundEvaluations,
      numericScoreEvaluations: exact.solverStats.numericScoreEvaluations,
      dynamicAirBoundEvaluations: exact.solverStats.dynamicAirBoundEvaluations,
      prefixDamageBoundEvaluations: exact.solverStats.prefixDamageBoundEvaluations,
      simulationBudget: prepared.simulationBudget,
      provenOptimal: exact.provenOptimal,
      solverStats: exact.solverStats,
    },
  };
}

/** Precomputes relaxed suffix contribution tables shared by every static slot prefix. */
function buildStaticSuffixDamageBounds(remainingCounts, groups, searchOrder, combatContext) {
  const tableByKey = new Map();
  const maximumAirCoefficients = Array(searchOrder.length + 1).fill(1);
  const maximumRawAir = Array.from(
    { length: searchOrder.length + 1 },
    () => Array(SLOTS_PER_BASE + 1).fill(0),
  );
  for (let position = searchOrder.length - 1; position >= 0; position -= 1) {
    const groupIndex = searchOrder[position];
    maximumAirCoefficients[position] = Math.max(
      maximumAirCoefficients[position + 1],
      remainingCounts[groupIndex] > 0
        ? landReconCoefficient([groups[groupIndex].representative])
        : 1,
    );
    for (let slots = 0; slots <= SLOTS_PER_BASE; slots += 1) {
      maximumRawAir[position][slots] = maximumRawAir[position + 1][slots];
      const copies = Math.min(slots, remainingCounts[groupIndex]);
      for (let count = 1; count <= copies; count += 1) {
        maximumRawAir[position][slots] = Math.max(
          maximumRawAir[position][slots],
          maximumRawAir[position + 1][slots - count] +
            count * groups[groupIndex].slotAirPower,
        );
      }
    }
  }

  for (const modifier of STATIC_RECON_DAMAGE_MODIFIERS) {
    for (const airWeight of STATIC_AIR_BOUND_WEIGHTS) {
      const rows = Array(searchOrder.length + 1);
      rows[searchOrder.length] = emptyStaticSuffixRow();
      for (let position = searchOrder.length - 1; position >= 0; position -= 1) {
        const groupIndex = searchOrder[position];
        const representative = groups[groupIndex].representative;
        const groupModifier = landBasedReconDamageModifier([representative]);
        const next = rows[position + 1];
        const current = next.map((values) => [...values]);
        if (groupModifier <= modifier) {
          const copies = Math.min(SLOTS_PER_BASE, remainingCounts[groupIndex]);
          const contribution = calculatePlaneSurfaceTargetPowerProxy(
            representative,
            { reconModifier: modifier, combatContext },
          ) + airWeight * groups[groupIndex].slotAirPower;
          for (let selectedCount = 1; selectedCount <= copies; selectedCount += 1) {
            const providesModifier = groupModifier === modifier ? 1 : 0;
            for (let slots = 0; slots + selectedCount <= SLOTS_PER_BASE; slots += 1) {
              for (let hasProvider = 0; hasProvider <= 1; hasProvider += 1) {
                const previous = next[slots][hasProvider];
                if (!Number.isFinite(previous)) continue;
                const nextProvider = hasProvider || providesModifier ? 1 : 0;
                current[slots + selectedCount][nextProvider] = Math.max(
                  current[slots + selectedCount][nextProvider],
                  previous + selectedCount * contribution,
                );
              }
            }
          }
        }
        rows[position] = current;
      }
      tableByKey.set(staticSuffixKey(modifier, airWeight), rows);
    }
  }

  return {
    maximumAirCoefficient(position) {
      return maximumAirCoefficients[position] || 1;
    },
    maximumRawAir(position, slotsLeft) {
      return maximumRawAir[position]?.[slotsLeft] || 0;
    },
    maximum(position, slotsLeft, modifier, requiredProvider, airWeight) {
      const row = tableByKey.get(staticSuffixKey(modifier, airWeight))?.[position];
      if (!row) return Number.NEGATIVE_INFINITY;
      const providerIndex = requiredProvider == null ? null : 1;
      let maximum = Number.NEGATIVE_INFINITY;
      for (let slots = 0; slots <= slotsLeft; slots += 1) {
        maximum = providerIndex == null
          ? Math.max(maximum, row[slots][0], row[slots][1])
          : Math.max(maximum, row[slots][providerIndex]);
      }
      return maximum;
    },
  };
}

function emptyStaticSuffixRow() {
  const row = Array.from(
    { length: SLOTS_PER_BASE + 1 },
    () => [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  );
  row[0][0] = 0;
  return row;
}

function staticSuffixKey(modifier, airWeight) {
  return `${modifier}:${airWeight}`;
}

/** Selects the strongest remaining per-plane damage contributions for one modifier case. */
function maximumRemainingPlaneDamage(
  allowed,
  slotsLeft,
  modifier,
  counts,
  remainingCounts,
  groups,
  requiredProviderModifier = null,
  airWeight = 0,
  combatContext = null,
) {
  if (slotsLeft <= 0) {
    return requiredProviderModifier == null ? 0 : Number.NEGATIVE_INFINITY;
  }
  const impossible = Number.NEGATIVE_INFINITY;
  const best = Array.from(
    { length: slotsLeft + 1 },
    () => [impossible, impossible],
  );
  best[0][0] = 0;
  for (const groupIndex of allowed) {
    const representative = groups[groupIndex].representative;
    const groupModifier = landBasedReconDamageModifier([representative]);
    if (groupModifier > modifier) continue;
    const available = remainingCounts[groupIndex] - counts[groupIndex];
    const copies = Math.min(Math.max(0, available), slotsLeft);
    const damage = calculatePlaneSurfaceTargetPowerProxy(
      representative,
      { reconModifier: modifier, combatContext },
    );
    const weightedContribution = damage + airWeight * groups[groupIndex].slotAirPower;
    const providesModifier = requiredProviderModifier != null &&
      groupModifier === requiredProviderModifier;
    for (let copy = 0; copy < copies; copy += 1) {
      for (let slots = slotsLeft - 1; slots >= 0; slots -= 1) {
        for (let hasProvider = 0; hasProvider <= 1; hasProvider += 1) {
          const current = best[slots][hasProvider];
          if (!Number.isFinite(current)) continue;
          const nextProvider = hasProvider || providesModifier ? 1 : 0;
          best[slots + 1][nextProvider] = Math.max(
            best[slots + 1][nextProvider],
            current + weightedContribution,
          );
        }
      }
    }
  }
  const providerIndex = requiredProviderModifier == null ? null : 1;
  let maximum = impossible;
  for (let slots = 0; slots <= slotsLeft; slots += 1) {
    maximum = providerIndex == null
      ? Math.max(maximum, best[slots][0], best[slots][1])
      : Math.max(maximum, best[slots][providerIndex]);
  }
  return Number.isFinite(maximum) ? maximum : impossible;
}

/** Computes a relaxed base envelope with scalar streaming aggregates. */
function calculateBaseEnvelope(baseLock, remainingCounts, prepared, baseIndex, budgetState) {
  const envelope = {
    feasible: false,
    maxDamage: Number.NEGATIVE_INFINITY,
    maxMargin: Number.NEGATIVE_INFINITY,
    minResource: Number.POSITIVE_INFINITY,
    minScarcity: Number.POSITIVE_INFINITY,
  };
  walkBaseAssignments(
    baseLock,
    remainingCounts,
    prepared,
    baseIndex,
    budgetState,
    'envelope',
    (candidate) => {
      envelope.feasible = true;
      envelope.maxDamage = Math.max(envelope.maxDamage, candidate.summary.damagePower);
      envelope.maxMargin = Math.max(envelope.maxMargin, candidate.summary.marginToTarget);
      envelope.minResource = Math.min(envelope.minResource, candidate.summary.resourceCost);
      envelope.minScarcity = Math.min(envelope.minScarcity, candidate.summary.scarcityCost);
      return true;
    },
  );
  return envelope;
}

/** Orders group branches by the same score used for complete plans. */
function orderedGroupIndices(prepared, baseIndex, requiredAir) {
  if (prepared.detailed) {
    return prepared.groups
      .map((_group, index) => index)
      .sort((left, right) => compareDetailedGroups(
        prepared.groups[left],
        prepared.groups[right],
        requiredAir,
      ));
  }
  const targetState = targetStateForBase(prepared.waveTargets, baseIndex);
  const scores = prepared.groups.map((group) => {
    const summary = summarizeBase(
      [group.representative],
      prepared.enemyAir,
      targetState,
      prepared.inventoryCounts,
      { details: false, combatContext: prepared.combatContext },
    );
    return scorePlan({
      totalDamagePower: summary.damagePower,
      totalResourceCost: summary.resourceCost,
      worstMargin: summary.marginToTarget,
      scarcityCost: summary.scarcityCost,
      canonicalKey: group.key,
    });
  });
  return prepared.groups
    .map((_group, index) => index)
    .sort((left, right) => -comparePlanScores(scores[left], scores[right]));
}

/** Prioritizes target feasibility and range before detailed damage. */
function compareDetailedGroups(left, right, requiredAir) {
  const fields = [
    Math.min(requiredAir, right.slotAirPower) - Math.min(requiredAir, left.slotAirPower),
    (Number(right.representative.radius) || 0) - (Number(left.representative.radius) || 0),
    right.damagePower - left.damagePower,
    (1 / Math.max(1, left.instances.length)) - (1 / Math.max(1, right.instances.length)),
  ];
  return fields.find((value) => value !== 0) || left.key.localeCompare(right.key);
}

/** Tries the smallest count that closes the remaining air deficit before damage-only choices. */
function orderedDetailedCounts(maximum, group, remainingRequiredAir) {
  const resource = Math.max(
    0,
    Number(group.representative.slotSize ?? defaultSlotSizeForPlane(group.representative)) || 0,
  );
  return Array.from({ length: maximum + 1 }, (_unused, count) => count)
    .sort((left, right) => {
      const feasibility = Math.min(remainingRequiredAir, right * group.slotAirPower) -
        Math.min(remainingRequiredAir, left * group.slotAirPower);
      if (feasibility) return feasibility;
      const damage = right * group.damagePower - left * group.damagePower;
      if (damage) return damage;
      const resourceDifference = left * resource - right * resource;
      return resourceDifference || left - right;
    });
}

/** Orders count choices by an optimistic shared-score contribution. */
function orderedCounts(maximum, group, requiredAir) {
  const resource = Math.max(
    0,
    Number(group.representative.slotSize ?? defaultSlotSizeForPlane(group.representative)) || 0,
  );
  const scarcity = 1 / Math.max(1, group.instances.length);
  return Array.from({ length: maximum + 1 }, (_unused, count) => count)
    .sort((left, right) => -comparePlanScores(
      {
        damage: left * group.damagePower,
        resource: -left * resource,
        margin: left * group.slotAirPower - requiredAir,
        scarcity: -left * scarcity,
        canonicalKey: String(left),
      },
      {
        damage: right * group.damagePower,
        resource: -right * resource,
        margin: right * group.slotAirPower - requiredAir,
        scarcity: -right * scarcity,
        canonicalKey: String(right),
      },
    ));
}

/** Creates mutable budget accounting shared by visits and envelope work. */
function createBudgetState(budget, onProgress = null) {
  return {
    budget,
    nodesExplored: 0,
    nodesPruned: 0,
    exhausted: false,
    onProgress,
  };
}

/** Consumes one unit only when work actually exists to explore. */
function consumeBudget(state) {
  if (state.nodesExplored >= state.budget) {
    state.exhausted = true;
    return false;
  }
  state.nodesExplored += 1;
  if (state.nodesExplored % 2048 === 0) state.onProgress?.();
  return true;
}

/** Creates independent detailed-simulation sample accounting. */
function createSimulationBudgetState(budget) {
  return { budget, samplesEvaluated: 0, exhausted: false };
}

/** Checks that a complete detailed plan could consume its full selected sample set. */
function reserveSimulationSamples(state, sampleCount) {
  if (state.samplesEvaluated + sampleCount > state.budget) {
    state.exhausted = true;
    return false;
  }
  return true;
}

/** Records only samples actually evaluated before a full result or exact bound. */
function recordSimulationSamples(state, sampleCount) {
  state.samplesEvaluated += Math.max(0, Number(sampleCount) || 0);
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
  usedCounts = null,
) {
  if (requiredAir <= 0) return true;
  let optimisticRawAir = selectedAirPower;
  const bestRemaining = [];
  for (let index = orderIndex; index < searchOrder.length; index += 1) {
    const groupIndex = searchOrder[index];
    const count = Math.min(
      slotsLeft,
      Math.max(0, remainingCounts[groupIndex] - (usedCounts?.[groupIndex] || 0)),
    );
    for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
      bestRemaining.push(groups[groupIndex].slotAirPower);
    }
  }
  bestRemaining.sort((left, right) => right - left);
  for (let index = 0; index < Math.min(slotsLeft, bestRemaining.length); index += 1) {
    optimisticRawAir += bestRemaining[index];
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

/** Distinguishes relaxed radius impossibility from target-air infeasibility. */
function infeasibleMessage(prepared, remainingCounts) {
  const radiusFeasible = prepared.baseLocks.every((baseLock) =>
    hasRadiusFeasibleAssignment(baseLock, remainingCounts, prepared.groups, prepared.targetRadius));
  if (!radiusFeasible) {
    return `No candidate loadout can reach radius ${prepared.targetRadius}.`;
  }
  return prepared.baseCount === 1
    ? 'No loadout can satisfy the target air state.'
    : 'No loadout can satisfy all range, air, inventory, and lock constraints.';
}

/** Finds one radius-feasible grouped assignment without retaining combinations. */
function hasRadiusFeasibleAssignment(baseLock, remainingCounts, groups, targetRadius) {
  if (targetRadius <= 0) return true;
  const counts = groups.map(() => 0);
  const openSlots = baseLock.slots.filter((slot) => slot.kind === SLOT_KINDS.OPEN).length;

  /** Stops at the first exact loadout whose effective radius reaches the target. */
  function search(groupIndex, slotsLeft) {
    if (groupIndex === groups.length) {
      return calculateEffectiveRadius(
        materializeRepresentativeLoadout(baseLock, counts, groups).filter(Boolean),
      ) >= targetRadius;
    }
    const maximum = Math.min(remainingCounts[groupIndex], slotsLeft);
    for (let count = maximum; count >= 0; count -= 1) {
      counts[groupIndex] = count;
      if (search(groupIndex + 1, slotsLeft - count)) {
        counts[groupIndex] = 0;
        return true;
      }
    }
    counts[groupIndex] = 0;
    return false;
  }

  return search(0, openSlots);
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
function materializeLoadouts(selected, prepared) {
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
  return loadouts;
}

/** Retains a deduplicated Top K without limiting the search itself. */
function retainPlan(plan, retained, retainedByKey, maxResults) {
  const previousRankOne = retained[0];
  const existing = retainedByKey.get(plan.canonicalKey);
  if (existing && comparePlanScores(plan, existing) <= 0) {
    return false;
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
  return retained[0] !== previousRankOne;
}

/** Emits only a target-feasible plan as a useful live incumbent. */
function isTargetFeasibleIncumbent(plan, detailed) {
  return detailed
    ? plan.allWaveTargetFulfillmentProbability > 0
    : plan.fulfilled === true;
}

/** Drops zero-fulfillment detailed plans once a strictly better feasible plan exists. */
function removeZeroFulfillmentPlans(retained, retainedByKey) {
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    if (retained[index].allWaveTargetFulfillmentProbability > 0) continue;
    retainedByKey.delete(retained[index].canonicalKey);
    retained.splice(index, 1);
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
    { details: false, combatContext: prepared.combatContext },
  );
  const feasible = prepared.detailed
    ? summary.radius >= prepared.targetRadius
    : isBaseFeasible(summary, prepared.targetRadius);
  return feasible ? { counts, summary } : null;
}

/** Detects an explicit detailed enemy shape without reinterpreting static totals. */
function isDetailedEnemy(enemy) {
  return enemy?.mode === 'detailed' ||
    (Array.isArray(enemy?.slots) && enemy.slots.length > 0) ||
    Array.isArray(enemy?.enemySlots);
}

/** Validates and normalizes one optimizer detailed enemy input. */
function validateOptimizerEnemy(enemy = {}, enemySlots, pathPrefix) {
  const slots = enemySlots || enemy.slots || enemy.enemySlots || [];
  const validation = validateAndNormalizeDetailedEnemySlots(slots, { pathPrefix });
  return {
    valid: validation.valid,
    errors: validation.errors,
    enemy: {
      ...enemy,
      mode: 'detailed',
      isAirRaidCell: enemy.isAirRaidCell === true,
      slots: validation.slots,
    },
  };
}

/** Calculates the initial detailed enemy air power for traversal ordering only. */
function initialDetailedEnemyAir(enemy = {}) {
  return (enemy.slots || []).reduce(
    (total, slot) => total + Math.floor(slot.sortieAntiAir * Math.sqrt(slot.currentSlot)),
    0,
  );
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
function normalizeBudget(value, fallback = DEFAULT_NODE_BUDGET) {
  if (value === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : Number.POSITIVE_INFINITY;
}

/** Normalizes a nonnegative work budget with an explicit finite default. */
function normalizeWorkBudget(value, fallback) {
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

/** Returns the common invalid-input result shape. */
function invalidResult(mode, budget, message, errors = [], simulationBudget = 0) {
  return {
    messages: [message],
    errors,
    results: [],
    search: {
      mode,
      status: 'invalid_input',
      nodesExplored: 0,
      budget,
      simulationSamplesEvaluated: 0,
      simulationBudget,
      provenOptimal: false,
    },
  };
}

module.exports = {
  SLOT_KINDS,
  buildStaticSeedCandidates,
  generateBaseCandidates,
  normalizeLockedBases,
  normalizeWaveTargets,
  optimizeLoadouts,
  optimisticScoreForPartial,
  prepareSearch,
};
