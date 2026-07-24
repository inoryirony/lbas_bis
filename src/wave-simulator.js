'use strict';

const {
  AIR_STATES,
  airStateFor,
  calculateBaseAirPower,
  calculateSlotAirPower,
  defaultSlotSizeForPlane,
  landReconCoefficient,
  requiredAirForState,
} = require('./air-power');
const { aircraftEquivalenceKey, capabilitiesFor } = require('./aircraft');
const {
  calculateBaseDamagePower,
  calculatePlaneSurfaceTargetPowerProxy,
  landBasedReconDamageModifier,
} = require('./damage');
const {
  detailedEnemyValidationError,
  validateAndNormalizeDetailedEnemySlots,
} = require('./enemy-slots');
const { createFixedSampleRandom } = require('./random');
const {
  prepareAttackSequence,
  isLbasCombatAttacker,
  resolveAttackSequence,
  resolvePreparedAttackSequence,
} = require('./combat-resolution');
const { requireSampleCount } = require('./simulation-options');
const { stageTwoShootdownStatus } = require('./enemy-stage2');
const { enemyStageOneLossForDraws } = require('./stage-one-distribution');
const { specialAirstrikeProfile } = require('./enemy-airstrike-rules');
const {
  CONTACT_MULTIPLIERS,
  contactMultiplierAt,
  contactMultiplierIndex,
  createContactState,
  decodeContactState,
  encodeContactState,
  prepareContactProfile,
  resolveContactState,
} = require('./combat-contact');
const { wilsonScoreInterval } = require('./statistics');

const AIRCRAFT_EQUIVALENCE_CACHE = Symbol('aircraftEquivalenceCache');
const PREPARED_WAVE_SEQUENCE = Symbol('preparedWaveSequence');
const COMBAT_DRAW_KINDS = Object.freeze([
  'fleet',
  'target',
  'flagship-protection',
  'flagship-protector',
  'hit',
  'armor',
  'scratch',
]);

const PLAYER_STAGE_ONE_CONSTANTS = Object.freeze({
  supremacy: 1,
  superiority: 3,
  parity: 5,
  denial: 7,
  loss: 10,
});
const ENEMY_STAGE_ONE_CONSTANTS = Object.freeze({
  supremacy: 10,
  superiority: 8,
  parity: 6,
  denial: 4,
  loss: 1,
});
const DETAILED_LIMITATIONS = Object.freeze([
  'ENEMY_STAGE2_OMITTED',
  'JET_STAGE2_OMITTED',
  'PLAYER_STAGE2_OMITTED',
  'DAMAGE_LOSS_RESOURCE_OPTIMISTIC',
]);
const MISSING_COMBAT_DATA_LIMITATION = 'HP_DAMAGE_OMITTED_MISSING_ENEMY_COMBAT_DATA';

/**
 * Calculates player Stage 1 losses with the kc-web state constants and one final floor.
 */
function playerStageOneLoss(stateKey, currentSlot, random = Math.random, plane = {}) {
  if (typeof random !== 'function') {
    const suppliedPlane = random || {};
    random = typeof plane === 'function'
      ? /** @type {() => number} */ (plane)
      : Math.random;
    plane = suppliedPlane;
  }
  const constant = stageOneConstant(PLAYER_STAGE_ONE_CONSTANTS, stateKey);
  const slot = nonNegativeFinite(currentSlot, 0);
  const uniform = unitRandom(random());
  const k = Math.floor(uniform * ((1000 * constant / 3) + 1));
  const a = k / 1000;
  const raw = slot * (a + constant / 4) / 10;
  const capabilities = capabilitiesFor(plane || {});
  const isJet = plane?.isJet === true || capabilities.isJet === true;
  const isAswPatrol = plane?.isAswPatrol === true || capabilities.isAswPatrol === true;
  const isAttacker = plane?.isAttacker === true || capabilities.isAttacker === true;
  const modifier = isJet ? 0.6 : isAswPatrol && !isAttacker ? 0.91 : 1;
  return Math.min(slot, Math.floor(raw * modifier));
}

/** Calculates enemy Stage 1 losses from two independent uniform integer draws. */
function enemyStageOneLoss(stateKey, currentSlot, random = Math.random) {
  const constant = stageOneConstant(ENEMY_STAGE_ONE_CONSTANTS, stateKey);
  const slot = nonNegativeFinite(currentSlot, 0);
  const x = Math.floor(unitRandom(random()) * (constant + 1));
  const y = Math.floor(unitRandom(random()) * (constant + 1));
  return enemyStageOneLossForDraws(stateKey, slot, x, y);
}

/** Recalculates detailed enemy air power from each surviving aircraft slot. */
function calculateEnemyAirPower(enemy) {
  return normalizeEnemyFleet(enemy).slots.reduce(
    (total, slot) => total + Math.floor(slot.sortieAntiAir * Math.sqrt(slot.currentSlot)),
    0,
  );
}

/**
 * Simulates one exact two-wave sequence per base without mutating plans or enemy fleets.
 */
function simulateWaveSequence(options = {}) {
  const dispatchMode = options.dispatchMode === 'separate' ? 'separate' : 'concentrated';
  const prepared = options[PREPARED_WAVE_SEQUENCE];
  const bases = prepared
    ? prepared.bases.map((base) => base.map((plane) => plane ? { ...plane } : null))
    : normalizeBases(options.bases || options.loadouts || []);
  const playerLossKeys = prepared?.playerLossKeys || bases.map(playerLossCoordinates);
  const enemies = prepared
    ? prepared.enemies.map(cloneEnemyFleet)
    : normalizeEnemyInputs(options, dispatchMode);
  const targetStates = prepared?.targetStates ||
    normalizeTargets(options.targetStates, bases.length * 2);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const waves = [];
  const usedSteelByBase = bases.map(() => 0);
  const initialOwnSlots = bases.map((base) => slotsForPlanes(base));
  const limitations = prepared?.limitations || detailedLimitationsFor(enemies);
  const contactProfiles = prepared?.contactProfiles || bases.map(prepareContactProfile);
  const contactStates = enemies.map(() => createContactState());

  bases.forEach((base, baseIndex) => {
    let ownAir = calculateBaseAirPower(base);
    for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
      const waveIndex = baseIndex * 2 + waveInBase;
      const enemyIndex = dispatchMode === 'separate' ? waveInBase : 0;
      const enemy = enemies[enemyIndex];
      const enemySlotsBefore = slotsForEnemy(enemy);
      const enemyAirBefore = airPowerForEnemy(enemy);
      const runJet = !enemy.isAirRaidCell &&
        (dispatchMode === 'separate' || waveInBase === 0);
      const jetAssault = runJet
        ? simulateJetAssault(
          base,
          enemy.stage2Defense,
          waveIndex,
          random,
          playerLossKeys[baseIndex],
        )
        : null;
      if (jetAssault) {
        ownAir = jetAssault.ownAirAfter;
        usedSteelByBase[baseIndex] += jetAssault.usedSteel;
      }

      const ownSlotsBefore = slotsForPlanes(base);
      const ownAirBefore = ownAir;

      const state = airStateFor(
        ownAir,
        enemyAirBefore,
        base.some((plane) => plane?.currentSlot > 0),
      );
      const enemySlotDetails = applyEnemyStageOne(enemy, state.key, waveIndex, random);
      const enemyAirAfter = airPowerForEnemy(enemy);
      const persistPlayerLoss = dispatchMode === 'separate' || waveInBase === 1;
      const playerWave = simulatePlayerWave(
        base,
        enemy.stage2Defense,
        state.key,
        waveIndex,
        random,
        playerLossKeys[baseIndex],
        persistPlayerLoss,
      );
      const ownSlotDetails = playerWave.slotDetails;
      const ownSlotsAfter = slotsForPlanes(playerWave.sortieBase);
      const ownAirAfter = calculateBaseAirPower(playerWave.sortieBase);
      if (persistPlayerLoss) ownAir = ownAirAfter;
      const enemySlotsAfter = slotsForEnemy(enemy);
      const contact = resolveContactState(
        contactProfiles[baseIndex],
        ownSlotsAfter,
        state.key,
        contactStates[enemyIndex],
        random(waveIndex, 'combat-contact', enemyIndex, 0),
      );
      contactStates[enemyIndex] = contact.state;
      const damage = calculateBaseDamagePower(playerWave.sortieBase.filter(Boolean), {
        combatContext: options.combatContext,
        contactMultiplier: contact.multiplier,
      });
      const combat = resolveWaveCombat({
        enemy,
        planes: playerWave.sortieBase,
        waveIndex,
        random,
        combatContext: options.combatContext,
        proficiencyBoundary: options.proficiencyBoundary,
        contactMultiplier: contact.multiplier,
      });
      const targetState = targetStates[waveIndex];

      waves.push({
        waveIndex,
        baseIndex,
        waveInBase,
        targetIndex: enemyIndex,
        targetState,
        fulfilled: state.rank >= (AIR_STATES[targetState]?.rank ?? AIR_STATES.parity.rank),
        state,
        airPower: ownAirBefore,
        stateOwnAir: ownAirBefore,
        ownAirBefore,
        ownAirAfter,
        enemyAirBefore,
        enemyAirAfter,
        ownSlotsBefore,
        ownSlotsAfter,
        enemySlotsBefore,
        enemySlotsAfter,
        ownSlotDetails,
        enemySlotDetails,
        jetAssault,
        damage,
        hpDamage: combat?.totalHpDamage ?? null,
        sunkCount: combat?.sunkThisWave ?? null,
        combat: combat?.result ?? null,
        contactMultiplier: contact.multiplier,
        ownSlotLoss: sumSlots(ownSlotsBefore) - sumSlots(ownSlotsAfter),
        enemySlotLoss: sumSlots(enemySlotsBefore) - sumSlots(enemySlotsAfter),
      });
    }
  });

  const finalOwnSlots = bases.map((base) => slotsForPlanes(base));
  const totalOwnSlotLoss = initialOwnSlots.reduce(
    (total, slots, index) => total + sumSlots(slots) - sumSlots(finalOwnSlots[index]),
    0,
  );
  const totalUsedSteel = usedSteelByBase.reduce((total, value) => total + value, 0);
  const totalSupplyFuel = totalOwnSlotLoss * 3;
  const totalSupplyBauxite = totalOwnSlotLoss * 5;
  const hasCompleteCombatResults = waves.every((wave) => wave.hpDamage != null);
  const combatLimitations = waves.flatMap((wave) => wave.combat?.limitations || []);
  if (!hasCompleteCombatResults) combatLimitations.push(MISSING_COMBAT_DATA_LIMITATION);

  return {
    calculationMode: 'detailed',
    mode: 'detailed',
    dispatchMode,
    waves,
    enemyFleets: enemies.map(cloneEnemyFleet),
    finalBases: bases.map((base) => base.map((plane) => plane ? { ...plane } : null)),
    finalOwnAir: bases.map((base) => calculateBaseAirPower(base)),
    finalEnemyAir: enemies.map((enemy) => airPowerForEnemy(enemy)),
    totalDamage: waves.reduce((total, wave) => total + wave.damage, 0),
    totalAttackPowerProxy: waves.reduce((total, wave) => total + wave.damage, 0),
    totalHpDamage: hasCompleteCombatResults
      ? waves.reduce((total, wave) => total + wave.hpDamage, 0)
      : null,
    totalSunkCount: hasCompleteCombatResults
      ? waves.reduce((total, wave) => total + wave.sunkCount, 0)
      : null,
    totalOwnSlotLoss,
    totalEnemySlotLoss: waves.reduce((total, wave) => total + wave.enemySlotLoss, 0),
    totalUsedSteel,
    totalSupplyFuel,
    totalSupplyBauxite,
    totalResourceCost: totalUsedSteel + totalSupplyFuel + totalSupplyBauxite,
    allWaveTargetsFulfilled: waves.every((wave) => wave.fulfilled),
    limitations: [...new Set([...limitations, ...combatLimitations])],
    limitationNotes: {
      DAMAGE_LOSS_RESOURCE_OPTIMISTIC:
        'Some resource accounting remains omitted, so resource use may be low.',
      [MISSING_COMBAT_DATA_LIMITATION]:
        'Enemy HP or armor is incomplete, so HP damage and sinking are unavailable.',
    },
  };
}

/** Runs coordinate-addressed common-random-number samples and aggregates every wave. */
function monteCarloWaveSequence(options = {}) {
  const sampleCount = requireSampleCount(
    options.sampleCount ?? options.simulationOptions?.sampleCount,
  );
  const seed = options.seed ?? options.simulationOptions?.seed ?? 0;
  const fixedRandom = typeof options.fixedRandom === 'function'
    ? options.fixedRandom
    : createFixedSampleRandom(seed, sampleCount);
  const incumbentScore = options.incumbentScore;
  const dispatchMode = options.dispatchMode === 'separate' ? 'separate' : 'concentrated';
  const combatBounds = combatSampleBounds(options, dispatchMode);
  const preparedBases = prepareMonteCarloBases(options.bases || options.loadouts || []);
  const preparedEnemies = normalizeEnemyInputs(options, dispatchMode);
  const preparedSequence = {
    bases: preparedBases,
    playerLossKeys: preparedBases.map(playerLossCoordinates),
    contactProfiles: preparedBases.map(prepareContactProfile),
    enemies: preparedEnemies,
    targetStates: normalizeTargets(options.targetStates, preparedBases.length * 2),
    limitations: detailedLimitationsFor(preparedEnemies),
  };
  const maximumDamagePerSample = preparedBases
    .reduce((total, base) => total + 2 * calculateBaseDamagePower(base.filter(Boolean), {
      combatContext: options.combatContext,
      contactMultiplier: 1.2,
    }), 0);
  let accumulator = null;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const result = simulateWaveSequence({
      ...options,
      bases: preparedBases,
      loadouts: undefined,
      [PREPARED_WAVE_SEQUENCE]: preparedSequence,
      random: (wave, side, slot, draw) =>
        fixedRandom(sample, wave, side, slot, draw),
    });
    accumulator = accumulator || createSimulationAccumulator(result);
    addSimulationSample(accumulator, result);
    const samplesEvaluated = sample + 1;
    const optimisticScore = optimisticFixedSampleScore(
      accumulator,
      samplesEvaluated,
      sampleCount,
      maximumDamagePerSample,
      combatBounds,
    );
    if (cannotBeatDetailedIncumbent(optimisticScore, incumbentScore)) {
      return {
        calculationMode: 'detailed',
        mode: 'detailed',
        seed,
        sampleCount,
        samplesEvaluated,
        prunedBySimulationBound: true,
        optimisticScore,
      };
    }
  }

  const first = accumulator.template;
  return {
    calculationMode: 'detailed',
    mode: 'detailed',
    dispatchMode: first.dispatchMode,
    seed,
    sampleCount,
    samplesEvaluated: sampleCount,
    waves: accumulator.waves.map((wave) => finalizeWaveAccumulator(wave, sampleCount)),
    allWaveTargetFulfillmentProbability: accumulator.allWaveTargetsFulfilled / sampleCount,
    allWaveTargetFulfillmentConfidence95: wilsonScoreInterval(
      accumulator.allWaveTargetsFulfilled,
      sampleCount,
    ),
    expectedDamage: accumulator.totalDamage / sampleCount,
    attackPowerProxy: accumulator.totalDamage / sampleCount,
    totalAttackPowerProxyAcrossSamples: accumulator.totalDamage,
    expectedHpDamage: accumulator.combatAvailable
      ? accumulator.totalHpDamage / sampleCount
      : null,
    expectedSunkCount: accumulator.combatAvailable
      ? accumulator.totalSunkCount / sampleCount
      : null,
    expectedOwnSlotLoss: accumulator.totalOwnSlotLoss / sampleCount,
    expectedEnemySlotLoss: accumulator.totalEnemySlotLoss / sampleCount,
    expectedUsedSteel: accumulator.totalUsedSteel / sampleCount,
    expectedSupplyFuel: accumulator.totalSupplyFuel / sampleCount,
    expectedSupplyBauxite: accumulator.totalSupplyBauxite / sampleCount,
    expectedResourceCost: accumulator.totalResourceCost / sampleCount,
    expectedFinalOwnSlots: divideNested(accumulator.finalOwnSlots, sampleCount),
    expectedFinalOwnAir: divideNested(accumulator.finalOwnAir, sampleCount),
    expectedFinalEnemySlots: divideNested(accumulator.finalEnemySlots, sampleCount),
    expectedFinalEnemyAir: divideNested(accumulator.finalEnemyAir, sampleCount),
    expectedFinalEnemyHp: accumulator.combatAvailable
      ? divideNested(accumulator.finalEnemyHp, sampleCount)
      : null,
    limitations: first.limitations,
    limitationNotes: first.limitationNotes,
  };
}

/** Creates immutable enemy and sample metadata shared by one detailed search. */
function createDetailedScoreContext(options = {}) {
  const sampleCount = requireSampleCount(
    options.sampleCount ?? options.simulationOptions?.sampleCount,
  );
  const seed = options.seed ?? options.simulationOptions?.seed ?? 0;
  const fixedRandom = typeof options.fixedRandom === 'function'
    ? options.fixedRandom
    : createFixedSampleRandom(seed, sampleCount);
  const dispatchMode = options.dispatchMode === 'separate' ? 'separate' : 'concentrated';
  const combatEnemies = normalizeEnemyInputs(options, dispatchMode);
  const enemies = combatEnemies.map(prepareNumericEnemy);
  const targetCount = Math.max(
    0,
    Math.floor(Number(options.baseCount) || 0) * 2,
    Array.isArray(options.targetStates) ? options.targetStates.length : 0,
  );
  const targetStates = normalizeTargets(options.targetStates, targetCount);
  const targetRanks = targetStates.map((key) => AIR_STATES[key]?.rank ?? AIR_STATES.parity.rank);
  return {
    sampleCount,
    seed,
    fixedRandom,
    dispatchMode,
    enemies,
    combatEnemies,
    targetStates,
    targetRanks,
    combatContext: options.combatContext,
    baseCache: new Map(),
    planeCurveCache: new Map(),
    nextEnemyTrajectoryId: 1,
    concentratedPrefixTrajectoryCache: createConcentratedSegmentCache(),
    concentratedContinuationTrajectoryCaches: new WeakMap(),
    randomVectorCache: new Map(),
    combatDraws: null,
  };
}

/** Creates reusable fixed-sample metadata for strict detailed damage bounds. */
function createDetailedDamageBoundContext(options = {}) {
  const sampleCount = requireSampleCount(
    options.sampleCount ?? options.simulationOptions?.sampleCount,
  );
  const seed = options.seed ?? options.simulationOptions?.seed ?? 0;
  return {
    sampleCount,
    fixedRandom: typeof options.fixedRandom === 'function'
      ? options.fixedRandom
      : createFixedSampleRandom(seed, sampleCount),
    dispatchMode: options.dispatchMode === 'separate' ? 'separate' : 'concentrated',
    combatContext: options.combatContext,
    damageCurveCache: new Map(),
    contributionCache: new Map(),
  };
}

/**
 * Evaluates only the exact fixed-sample score used to reject detailed candidates.
 * @returns {Record<string, any>} A pruned prefix or a complete fixed-sample score.
 */
function evaluateDetailedPlanScore(options = {}) {
  const sourceBases = options.bases || options.loadouts || [];
  const includeCombat = options.includeCombat === true;
  const baseIndexOffset = Math.max(0, Math.floor(Number(options.baseIndexOffset) || 0));
  const context = options.scoreContext || createDetailedScoreContext({
    ...options,
    baseCount: sourceBases.length,
  });
  const {
    sampleCount,
    seed,
    fixedRandom,
    dispatchMode,
    enemies,
    targetRanks,
  } = context;
  const baseCacheKeys = Array.isArray(options.baseCacheKeys) ? options.baseCacheKeys : [];
  const cacheBaseRecords = options.cacheBaseRecords !== false;
  const baseRecords = sourceBases.map((sourceBase, baseIndex) => {
    const suppliedKey = baseCacheKeys[baseIndex];
    const cacheKey = suppliedKey == null
      ? null
      : `${baseIndexOffset + baseIndex}:${suppliedKey}`;
    if (cacheBaseRecords && cacheKey != null && context.baseCache.has(cacheKey)) {
      const cached = context.baseCache.get(cacheKey);
      if (includeCombat && !cached.combat) {
        cached.combat = prepareNumericCombatSequences(cached.source, context, options);
      }
      return cached;
    }
    const normalizedBase = normalizeBases([sourceBase])[0];
    const record = {
      source: normalizedBase,
      numeric: prepareNumericBase(
        normalizedBase,
        options.combatContext,
        context.planeCurveCache,
      ),
      maximumDamage: 2 * calculateBaseDamagePower(normalizedBase.filter(Boolean), {
        combatContext: options.combatContext,
        contactMultiplier: 1.2,
      }),
      ...(includeCombat ? {
        combat: prepareNumericCombatSequences(normalizedBase, context, options),
      } : {}),
    };
    if (cacheBaseRecords && cacheKey != null) context.baseCache.set(cacheKey, record);
    return record;
  });
  const bases = baseRecords.map((record) => record.numeric);
  const maximumDamagePerSample = baseRecords.reduce(
    (total, record) => total + record.maximumDamage,
    0,
  );
  const initialEnemySlotsBySample = Array.isArray(options.initialEnemySlotsBySample)
    ? options.initialEnemySlotsBySample
    : null;
  const initialEnemyHitPointsBySample = Array.isArray(options.initialEnemyHitPointsBySample)
    ? options.initialEnemyHitPointsBySample
    : null;
  const initialEnemySlotsFlatByFleet = Array.isArray(options.initialEnemySlotsFlatByFleet)
    ? options.initialEnemySlotsFlatByFleet
    : null;
  const initialEnemyHitPointsFlatByFleet =
    Array.isArray(options.initialEnemyHitPointsFlatByFleet)
      ? options.initialEnemyHitPointsFlatByFleet
      : null;
  const initialContactStatesBySample = Array.isArray(options.initialContactStatesBySample)
    ? options.initialContactStatesBySample
    : null;
  const initialContactStatesFlatByFleet = Array.isArray(options.initialContactStatesFlatByFleet)
    ? options.initialContactStatesFlatByFleet
    : null;
  if (canReuseConcentratedPrefixTrajectory({
    bases,
    baseIndexOffset,
    dispatchMode,
    initialEnemySlotsBySample,
    initialEnemySlotsFlatByFleet,
    captureFinalEnemySlots: options.captureFinalEnemySlots,
    incumbentScore: options.incumbentScore,
    disableConcentratedSegmentReuse: includeCombat || options.disableConcentratedSegmentReuse,
  })) {
    return evaluateReusableConcentratedSegment({
      base: bases[0],
      context,
      baseIndexOffset,
      initialEnemySlotsBySample,
      captureFinalEnemySlots: options.captureFinalEnemySlots,
      initialContactStatesBySample,
      initialContactStatesFlatByFleet,
      captureFinalContactStates: options.captureFinalContactStates,
    });
  }
  let fulfilledSamples = 0;
  let totalDamage = 0;
  let totalHpDamage = 0;
  let totalSunkCount = 0;
  let totalOwnSlotLoss = 0;
  let totalResourceCost = 0;
  const totalOwnAirBeforeByWave = new Float64Array(bases.length * 2);
  const totalEnemyAirBeforeByWave = new Float64Array(bases.length * 2);
  const maximumFinalEnemyAir = enemies.map(() => 0);
  const finalEnemySlotsBySample = options.captureFinalEnemySlots ? [] : null;
  const finalEnemyHitPointsBySample = options.captureFinalEnemyHitPoints ? [] : null;
  const finalContactStatesBySample = options.captureFinalContactStates ? [] : null;
  const combatAvailable = includeCombat && baseRecords.every((record) =>
    record.combat?.every(Boolean));
  const captureFinalContinuationsFlat = options.captureFinalContinuationsFlat === true;
  const finalEnemySlotsFlatByFleet = captureFinalContinuationsFlat
    ? enemies.map((enemy) => ({
      width: enemy.initialSlots.length,
      values: new Float64Array(sampleCount * enemy.initialSlots.length),
    }))
    : null;
  const finalEnemyHitPointsFlatByFleet = captureFinalContinuationsFlat && combatAvailable
    ? context.combatEnemies.map((enemy) => ({
      width: enemy.ships.length,
      values: new Int32Array(sampleCount * enemy.ships.length),
    }))
    : null;
  const finalContactStatesFlatByFleet = captureFinalContinuationsFlat
    ? enemies.map(() => ({ width: 2, values: new Uint8Array(sampleCount * 2) }))
    : null;
  if (options.combatTrajectory) {
    if (!combatAvailable) {
      throw new Error('A combat trajectory requires complete enemy combat data.');
    }
    if (Array.isArray(options.initialEnemyHitPointStatesFlatByFleet)) {
      return evaluateCapturedCombatTrajectoryBatch({
        baseIndexOffset,
        baseRecords,
        context,
        initialEnemyHitPointStatesFlatByFleet:
          options.initialEnemyHitPointStatesFlatByFleet,
        diagnostics: options.diagnostics,
        trajectory: options.combatTrajectory,
      });
    }
    return evaluateCapturedCombatTrajectory({
      baseIndexOffset,
      baseRecords,
      context,
      initialEnemyHitPointsBySample,
      initialEnemyHitPointsFlatByFleet,
      captureFinalContinuationsFlat,
      trajectory: options.combatTrajectory,
    });
  }
  const combatBounds = combatAvailable ? combatSampleBounds(options, dispatchMode) : null;
  const combatOutput = {};
  const combatScratch = { damage: {}, draws: {}, attackOrder: [] };
  /** @type {{sample: number, vectors: any}} */
  const combatRandomState = { sample: 0, vectors: null };
  /** Reads one preselected combat draw vector without allocating per-wave closures. */
  const combatRandom = (attackIndex, drawKind) =>
    combatRandomState.vectors[attackIndex][drawKind][combatRandomState.sample];
  const capturedCombatTrajectory = options.captureCombatTrajectory === true
    ? createCapturedCombatTrajectory(bases, sampleCount, baseIndexOffset)
    : null;
  const randomVectors = prepareDetailedRandomVectors(context, bases, baseIndexOffset);
  if (combatAvailable) ensureCombatDraws(context);
  const ownSlots = bases.map((base) => new Float64Array(base.initialSlots.length));
  const attackSlotScratch = bases.map((base) => new Float64Array(base.initialSlots.length));
  const initialOwnSlotTotals = bases.map((base) => sumSlots(base.initialSlots));
  const enemySlots = enemies.map((enemy) => new Float64Array(enemy.initialSlots.length));
  const enemyHitPoints = combatAvailable
    ? context.combatEnemies.map((enemy) => new Int32Array(enemy.ships.length))
    : null;
  const initialEnemyHitPoints = combatAvailable
    ? context.combatEnemies.map((enemy) => Int32Array.from(enemy.ships.map((ship) =>
      Math.max(0, Math.floor(Number(ship.currentHp ?? ship.hp) || 0)))))
    : null;
  const previousSunkCounts = combatAvailable
    ? new Int32Array(context.combatEnemies.length)
    : null;
  const usedSteelByBase = new Float64Array(bases.length);
  const contactStates = Array(enemies.length);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    ownSlots.forEach((slots, baseIndex) => slots.set(bases[baseIndex].initialSlots));
    const suppliedEnemySlots = initialEnemySlotsBySample?.[sample];
    enemies.forEach((enemy, enemyIndex) => {
      const flat = initialEnemySlotsFlatByFleet?.[enemyIndex];
      const flatSample = flat?.values?.subarray(
        sample * flat.width,
        (sample + 1) * flat.width,
      );
      enemySlots[enemyIndex].set(
        suppliedEnemySlots?.[enemyIndex] || flatSample || enemy.initialSlots,
      );
    });
    const suppliedEnemyHitPoints = initialEnemyHitPointsBySample?.[sample];
    for (let enemyIndex = 0; enemyIndex < enemies.length; enemyIndex += 1) {
      contactStates[enemyIndex] = contactStateForSample(
        initialContactStatesBySample,
        initialContactStatesFlatByFleet,
        sample,
        enemyIndex,
      );
    }
    if (combatAvailable) {
      context.combatEnemies.forEach((enemy, enemyIndex) => {
        const flat = initialEnemyHitPointsFlatByFleet?.[enemyIndex];
        const flatSample = flat?.values?.subarray(
          sample * flat.width,
          (sample + 1) * flat.width,
        );
        enemyHitPoints[enemyIndex].set(
          suppliedEnemyHitPoints?.[enemyIndex] || flatSample || initialEnemyHitPoints[enemyIndex],
        );
        previousSunkCounts[enemyIndex] = enemyHitPoints[enemyIndex].reduce(
          (count, hitPointsValue) => count + Number(hitPointsValue === 0),
          0,
        );
      });
    }
    usedSteelByBase.fill(0);
    let allTargetsFulfilled = true;

    bases.forEach((base, baseIndex) => {
      const slots = ownSlots[baseIndex];
      let ownAir = numericBaseAirPower(base, slots, false);
      for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
        const waveRandom = randomVectors[baseIndex][waveInBase];
        const waveIndex = (baseIndexOffset + baseIndex) * 2 + waveInBase;
        const enemyIndex = dispatchMode === 'separate' ? waveInBase : 0;
        const enemy = enemies[enemyIndex];
        const currentEnemySlots = enemySlots[enemyIndex];
        const runJet = !enemy.isAirRaidCell &&
          (dispatchMode === 'separate' || waveInBase === 0);
        if (runJet && base.hasJet) {
          base.planes.forEach((plane, slotIndex) => {
            if (!plane?.isJet || plane.isEscortItem) return;
            const before = slots[slotIndex];
            usedSteelByBase[baseIndex] += plane.jetSteelBySlot[
              Math.max(0, Math.floor(before))
            ] || 0;
            slots[slotIndex] = Math.max(0, before - numericPlayerLoss(
              'supremacy',
              before,
              waveRandom.jetPlayer[slotIndex][sample],
              plane.lossModifier,
            ));
          });
          applyNumericEnemyStageTwo(
            base,
            slots,
            enemy.stage2Defense,
            fixedRandom,
            sample,
            waveIndex,
            {
              phasePrefix: 'jet-stage2',
              isEligible: (plane) => plane?.isJet &&
                plane.isStageTwoTarget &&
                !plane.isEscortItem,
              randomVectors: waveRandom.jetStageTwo,
            },
          );
          ownAir = numericBaseAirPower(base, slots, true);
        }

        const enemyAir = numericEnemyAirPower(enemy, currentEnemySlots);
        const segmentWaveIndex = baseIndex * 2 + waveInBase;
        totalOwnAirBeforeByWave[segmentWaveIndex] += ownAir;
        totalEnemyAirBeforeByWave[segmentWaveIndex] += enemyAir;
        const stateRank = numericAirStateRank(ownAir, enemyAir, baseHasPlane(base, slots));
        const stateKey = airStateKeyForRank(stateRank);
        if (stateRank < targetRanks[waveIndex]) allTargetsFulfilled = false;

        if (stateKey !== 'none') {
          enemy.sortieAntiAir.forEach((_antiAir, slotIndex) => {
            const before = currentEnemySlots[slotIndex];
            const constant = ENEMY_STAGE_ONE_CONSTANTS[stateKey];
            const x = Math.floor(
              waveRandom.enemy[slotIndex][0][sample] *
              (constant + 1),
            );
            const y = Math.floor(
              waveRandom.enemy[slotIndex][1][sample] *
              (constant + 1),
            );
            const loss = Math.min(before, Math.floor(before * (0.65 * x + 0.35 * y) / 10));
            currentEnemySlots[slotIndex] = Math.max(0, before - loss);
          });
        }

        const persistPlayerLoss = dispatchMode === 'separate' || waveInBase === 1;
        const attackSlots = persistPlayerLoss ? slots : attackSlotScratch[baseIndex];
        if (!persistPlayerLoss) attackSlots.set(slots);
        if (stateKey !== 'none') {
          base.planes.forEach((plane, slotIndex) => {
            if (!plane) return;
            const before = attackSlots[slotIndex];
            attackSlots[slotIndex] = Math.max(0, before - numericPlayerLoss(
              stateKey,
              before,
              waveRandom.player[slotIndex][sample],
              plane.lossModifier,
            ));
          });
        }
        applyNumericEnemyStageTwo(
          base,
          attackSlots,
          enemy.stage2Defense,
          fixedRandom,
          sample,
          waveIndex,
          { randomVectors: waveRandom.playerStageTwo },
        );
        const contact = resolveContactState(
          base.contactProfile,
          attackSlots,
          stateKey,
          contactStates[enemyIndex],
          waveRandom.contact[sample],
        );
        contactStates[enemyIndex] = contact.state;
        if (capturedCombatTrajectory) {
          const captured = capturedCombatTrajectory.attackSlots[baseIndex][waveInBase];
          const attackerIndices = capturedCombatTrajectory.attackerIndices[baseIndex];
          const offset = sample * captured.width;
          for (let attackerIndex = 0; attackerIndex < attackerIndices.length; attackerIndex += 1) {
            captured.values[offset + attackerIndex] = attackSlots[attackerIndices[attackerIndex]];
          }
          capturedCombatTrajectory.contactMultiplierIndices[baseIndex][waveInBase][sample] =
            contactMultiplierIndex(contact.multiplier);
        }
        if (persistPlayerLoss) ownAir = numericBaseAirPower(base, slots, false);
        totalDamage += numericBaseDamage(base, attackSlots, contact.multiplier);
        if (combatAvailable) {
          combatRandomState.sample = sample;
          combatRandomState.vectors = context.combatDraws[waveIndex];
          const resolved = resolvePreparedAttackSequence({
            prepared: baseRecords[baseIndex].combat[enemyIndex],
            currentSlots: attackSlots,
            hitPoints: enemyHitPoints[enemyIndex],
            planeOrder: numericCombatPlaneOrder(base, attackSlots),
            random: combatRandom,
            output: combatOutput,
            scratch: combatScratch,
            contactMultiplier: contact.multiplier,
          });
          totalHpDamage += resolved.totalHpDamage;
          totalSunkCount += resolved.sunkCount - previousSunkCounts[enemyIndex];
          previousSunkCounts[enemyIndex] = resolved.sunkCount;
        }
      }
    });

    const sampleOwnSlotLoss = ownSlots.reduce((total, slots, baseIndex) =>
      total + initialOwnSlotTotals[baseIndex] - sumSlots(slots), 0);
    const sampleUsedSteel = usedSteelByBase.reduce((total, value) => total + value, 0);
    totalOwnSlotLoss += sampleOwnSlotLoss;
    totalResourceCost += sampleUsedSteel + 8 * sampleOwnSlotLoss;

    enemies.forEach((enemy, enemyIndex) => {
      maximumFinalEnemyAir[enemyIndex] = Math.max(
        maximumFinalEnemyAir[enemyIndex],
        numericEnemyAirPower(enemy, enemySlots[enemyIndex]),
      );
    });
    if (finalEnemySlotsBySample) {
      finalEnemySlotsBySample.push(enemySlots.map((slots) => Array.from(slots)));
    }
    if (finalEnemyHitPointsBySample && enemyHitPoints) {
      finalEnemyHitPointsBySample.push(
        enemyHitPoints.map((hitPoints) => Array.from(hitPoints)),
      );
    }
    if (finalContactStatesBySample) {
      finalContactStatesBySample.push(contactStates.map((state) => ({ ...state })));
    }
    if (finalEnemySlotsFlatByFleet) {
      finalEnemySlotsFlatByFleet.forEach((flat, enemyIndex) => {
        flat.values.set(enemySlots[enemyIndex], sample * flat.width);
      });
    }
    if (finalEnemyHitPointsFlatByFleet && enemyHitPoints) {
      finalEnemyHitPointsFlatByFleet.forEach((flat, enemyIndex) => {
        flat.values.set(enemyHitPoints[enemyIndex], sample * flat.width);
      });
    }
    if (finalContactStatesFlatByFleet) {
      finalContactStatesFlatByFleet.forEach((flat, enemyIndex) => {
        flat.values.set(encodeContactState(contactStates[enemyIndex]), sample * flat.width);
      });
    }
    if (allTargetsFulfilled) fulfilledSamples += 1;
    const samplesEvaluated = sample + 1;
    const remainingSamples = sampleCount - samplesEvaluated;
    const optimisticScore = {
      fulfillment: (fulfilledSamples + remainingSamples) / sampleCount,
      damage: (totalDamage + remainingSamples * maximumDamagePerSample) / sampleCount,
    };
    if (combatAvailable) {
      const candidateBounds = options.combatSampleUpperBounds;
      const remainingSunk = candidateBounds?.remainingSunk?.[samplesEvaluated];
      const remainingHpDamage = candidateBounds?.remainingHpDamage?.[samplesEvaluated];
      optimisticScore.sunk = (
        totalSunkCount + (Number.isFinite(remainingSunk)
          ? remainingSunk
          : remainingSamples * combatBounds.maximumSunkCount)
      ) / sampleCount;
      optimisticScore.hpDamage = (
        totalHpDamage + (Number.isFinite(remainingHpDamage)
          ? remainingHpDamage
          : remainingSamples * combatBounds.maximumHpDamage)
      ) / sampleCount;
      optimisticScore.loss = -totalOwnSlotLoss / sampleCount;
      optimisticScore.resource = -totalResourceCost / sampleCount;
    }
    if (cannotBeatDetailedIncumbent(optimisticScore, options.incumbentScore)) {
      return {
        calculationMode: 'detailed',
        mode: 'detailed',
        seed,
        sampleCount,
        samplesEvaluated,
        prunedBySimulationBound: true,
        optimisticScore,
      };
    }
  }

  const worstMargin = Math.min(...Array.from(totalOwnAirBeforeByWave, (ownAir, index) =>
    ownAir / sampleCount - requiredAirForState(
      totalEnemyAirBeforeByWave[index] / sampleCount,
      context.targetStates[baseIndexOffset * 2 + index],
    )));
  const result = {
    calculationMode: 'detailed',
    mode: 'detailed',
    seed,
    sampleCount,
    samplesEvaluated: sampleCount,
    allWaveTargetFulfillmentProbability: fulfilledSamples / sampleCount,
    expectedDamage: totalDamage / sampleCount,
    attackPowerProxy: totalDamage / sampleCount,
    totalDamageAcrossSamples: totalDamage,
    totalAttackPowerProxyAcrossSamples: totalDamage,
    expectedOwnSlotLoss: totalOwnSlotLoss / sampleCount,
    expectedResourceCost: totalResourceCost / sampleCount,
    worstMargin,
    ...(combatAvailable ? {
      expectedHpDamage: totalHpDamage / sampleCount,
      expectedSunkCount: totalSunkCount / sampleCount,
    } : {}),
    maximumFinalEnemyAir,
    ...(finalEnemySlotsBySample ? { finalEnemySlotsBySample } : {}),
    ...(finalEnemyHitPointsBySample ? { finalEnemyHitPointsBySample } : {}),
    ...(finalContactStatesBySample ? { finalContactStatesBySample } : {}),
    ...(finalEnemySlotsFlatByFleet ? { finalEnemySlotsFlatByFleet } : {}),
    ...(finalEnemyHitPointsFlatByFleet ? { finalEnemyHitPointsFlatByFleet } : {}),
    ...(finalContactStatesFlatByFleet ? { finalContactStatesFlatByFleet } : {}),
  };
  if (capturedCombatTrajectory) {
    capturedCombatTrajectory.allWaveTargetFulfillmentProbability =
      result.allWaveTargetFulfillmentProbability;
    capturedCombatTrajectory.expectedDamage = result.expectedDamage;
    capturedCombatTrajectory.totalDamageAcrossSamples = result.totalDamageAcrossSamples;
    capturedCombatTrajectory.expectedOwnSlotLoss = totalOwnSlotLoss / sampleCount;
    capturedCombatTrajectory.expectedResourceCost = totalResourceCost / sampleCount;
    capturedCombatTrajectory.worstMargin = worstMargin;
    capturedCombatTrajectory.maximumFinalEnemyAir = result.maximumFinalEnemyAir;
    return { ...result, combatTrajectory: capturedCombatTrajectory };
  }
  return result;
}

/** Scores several HP-only continuations in one shared sample and wave traversal. */
function evaluateDetailedCombatContinuationBatch(options = {}) {
  if (!Array.isArray(options.initialEnemyHitPointStatesFlatByFleet)) {
    throw new TypeError('Flat enemy HP continuation states are required.');
  }
  if (!options.combatTrajectory) {
    throw new TypeError('A captured combat trajectory is required.');
  }
  return evaluateDetailedPlanScore(options);
}

/** Allocates one compact per-wave player-slot trajectory for HP-only continuation reuse. */
function createCapturedCombatTrajectory(bases, sampleCount, baseIndexOffset) {
  const attackerIndices = bases.map((base) => base.planes
    .map((plane, planeIndex) => isLbasCombatAttacker(plane) ? planeIndex : null)
    .filter((planeIndex) => planeIndex != null));
  return {
    sampleCount,
    baseIndexOffset,
    attackerIndices,
    attackSlots: bases.map((_base, baseIndex) => Array.from({ length: 2 }, () => ({
      width: attackerIndices[baseIndex].length,
      values: new Uint16Array(sampleCount * attackerIndices[baseIndex].length),
    }))),
    contactMultiplierIndices: bases.map(() => Array.from(
      { length: 2 },
      () => new Uint8Array(sampleCount),
    )),
  };
}

/** Resolves only HP combat from a previously captured air and player-loss trajectory. */
function evaluateCapturedCombatTrajectory(options) {
  const {
    baseIndexOffset,
    baseRecords,
    context,
    captureFinalContinuationsFlat,
    initialEnemyHitPointsBySample,
    initialEnemyHitPointsFlatByFleet,
    trajectory,
  } = options;
  if (trajectory.sampleCount !== context.sampleCount ||
      trajectory.baseIndexOffset !== baseIndexOffset ||
      trajectory.attackSlots.length !== baseRecords.length) {
    throw new Error('Combat trajectory does not match this score context.');
  }
  ensureCombatDraws(context);
  const enemyHitPoints = context.combatEnemies.map((enemy) =>
    new Int32Array(enemy.ships.length));
  const initialEnemyHitPoints = context.combatEnemies.map((enemy) => Int32Array.from(
    enemy.ships.map((ship) => Math.max(
      0,
      Math.floor(Number(ship.currentHp ?? ship.hp) || 0),
    )),
  ));
  const finalEnemyHitPointsFlatByFleet = captureFinalContinuationsFlat
    ? context.combatEnemies.map((enemy) => ({
      width: enemy.ships.length,
      values: new Int32Array(context.sampleCount * enemy.ships.length),
    }))
    : null;
  const previousSunkCounts = new Int32Array(context.combatEnemies.length);
  const attackSlotsByBase = baseRecords.map((record) =>
    new Float64Array(record.numeric.planes.length));
  const combatOutput = {};
  const combatScratch = { damage: {}, draws: {}, attackOrder: [] };
  /** @type {{sample: number, vectors: any}} */
  const combatRandomState = { sample: 0, vectors: null };
  /** Reads one preselected replay draw vector without allocating per-wave closures. */
  const combatRandom = (attackIndex, drawKind) =>
    combatRandomState.vectors[attackIndex][drawKind][combatRandomState.sample];
  let totalHpDamage = 0;
  let totalSunkCount = 0;

  for (let sample = 0; sample < context.sampleCount; sample += 1) {
    const suppliedEnemyHitPoints = initialEnemyHitPointsBySample?.[sample];
    context.combatEnemies.forEach((enemy, enemyIndex) => {
      const flat = initialEnemyHitPointsFlatByFleet?.[enemyIndex];
      const flatSample = flat?.values?.subarray(
        sample * flat.width,
        (sample + 1) * flat.width,
      );
      enemyHitPoints[enemyIndex].set(
        suppliedEnemyHitPoints?.[enemyIndex] || flatSample || initialEnemyHitPoints[enemyIndex],
      );
      previousSunkCounts[enemyIndex] = enemyHitPoints[enemyIndex].reduce(
        (count, hitPoints) => count + Number(hitPoints === 0),
        0,
      );
    });

    baseRecords.forEach((record, baseIndex) => {
      for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
        const waveIndex = (baseIndexOffset + baseIndex) * 2 + waveInBase;
        const enemyIndex = context.dispatchMode === 'separate' ? waveInBase : 0;
        const captured = trajectory.attackSlots[baseIndex][waveInBase];
        const attackSlots = attackSlotsByBase[baseIndex];
        attackSlots.fill(0);
        const attackerIndices = trajectory.attackerIndices[baseIndex];
        const capturedOffset = sample * captured.width;
        for (let attackerIndex = 0; attackerIndex < attackerIndices.length; attackerIndex += 1) {
          attackSlots[attackerIndices[attackerIndex]] =
            captured.values[capturedOffset + attackerIndex];
        }
        const contactMultiplier = contactMultiplierAt(
          trajectory.contactMultiplierIndices[baseIndex][waveInBase][sample],
        );
        combatRandomState.sample = sample;
        combatRandomState.vectors = context.combatDraws[waveIndex];
        const resolved = resolvePreparedAttackSequence({
          prepared: record.combat[enemyIndex],
          currentSlots: attackSlots,
          hitPoints: enemyHitPoints[enemyIndex],
          planeOrder: numericCombatPlaneOrder(record.numeric, attackSlots),
          random: combatRandom,
          output: combatOutput,
          scratch: combatScratch,
          contactMultiplier,
        });
        totalHpDamage += resolved.totalHpDamage;
        totalSunkCount += resolved.sunkCount - previousSunkCounts[enemyIndex];
        previousSunkCounts[enemyIndex] = resolved.sunkCount;
      }
    });
    finalEnemyHitPointsFlatByFleet?.forEach((flat, enemyIndex) => {
      flat.values.set(enemyHitPoints[enemyIndex], sample * flat.width);
    });
  }

  return {
    calculationMode: 'detailed',
    mode: 'detailed',
    seed: context.seed,
    sampleCount: context.sampleCount,
    samplesEvaluated: context.sampleCount,
    allWaveTargetFulfillmentProbability: trajectory.allWaveTargetFulfillmentProbability,
    expectedDamage: trajectory.expectedDamage,
    attackPowerProxy: trajectory.expectedDamage,
    totalDamageAcrossSamples: trajectory.totalDamageAcrossSamples,
    totalAttackPowerProxyAcrossSamples: trajectory.totalDamageAcrossSamples,
    expectedHpDamage: totalHpDamage / context.sampleCount,
    expectedSunkCount: totalSunkCount / context.sampleCount,
    expectedOwnSlotLoss: trajectory.expectedOwnSlotLoss,
    expectedResourceCost: trajectory.expectedResourceCost,
    worstMargin: trajectory.worstMargin,
    maximumFinalEnemyAir: trajectory.maximumFinalEnemyAir,
    ...(finalEnemyHitPointsFlatByFleet ? { finalEnemyHitPointsFlatByFleet } : {}),
  };
}

/** Resolves a shared combat trajectory for many independent enemy HP states. */
function evaluateCapturedCombatTrajectoryBatch(options) {
  const {
    baseIndexOffset,
    baseRecords,
    context,
    diagnostics = {},
    initialEnemyHitPointStatesFlatByFleet,
    trajectory,
  } = options;
  if (trajectory.sampleCount !== context.sampleCount ||
      trajectory.baseIndexOffset !== baseIndexOffset ||
      trajectory.attackSlots.length !== baseRecords.length) {
    throw new Error('Combat trajectory does not match this score context.');
  }
  ensureCombatDraws(context);
  const stateCount = initialEnemyHitPointStatesFlatByFleet.length;
  const hitPointsByState = Array.from({ length: stateCount }, () =>
    context.combatEnemies.map((enemy) => new Int32Array(enemy.ships.length)));
  const previousSunkByState = Array.from({ length: stateCount }, () =>
    new Int32Array(context.combatEnemies.length));
  const totalHpDamageByState = new Float64Array(stateCount);
  const totalSunkByState = new Float64Array(stateCount);
  const sampleHpDamageByState = new Float64Array(stateCount);
  const sampleSunkByState = new Float64Array(stateCount);
  const groupByState = new Uint16Array(stateCount);
  const representatives = [];
  const groupsByHash = new Map();
  const combatOutputs = Array.from({ length: stateCount }, () => ({}));
  const combatScratches = Array.from({ length: stateCount }, () => ({
    damage: {},
    draws: {},
    attackOrder: [],
  }));
  const attackSlotsByBase = baseRecords.map((record) =>
    new Float64Array(record.numeric.planes.length));

  for (let sample = 0; sample < context.sampleCount; sample += 1) {
    representatives.length = 0;
    groupsByHash.clear();
    sampleHpDamageByState.fill(0);
    sampleSunkByState.fill(0);
    for (let stateIndex = 0; stateIndex < stateCount; stateIndex += 1) {
      const flatByFleet = initialEnemyHitPointStatesFlatByFleet[stateIndex];
      let sampleHash = 2166136261 >>> 0;
      for (const flat of flatByFleet || []) {
        const offset = sample * flat.width;
        sampleHash = Math.imul(sampleHash ^ flat.width, 16777619) >>> 0;
        for (let valueIndex = 0; valueIndex < flat.width; valueIndex += 1) {
          sampleHash = Math.imul(
            sampleHash ^ (Number(flat.values[offset + valueIndex]) >>> 0),
            16777619,
          ) >>> 0;
        }
      }
      let groupIndex = groupsByHash.get(sampleHash);
      if (groupIndex != null && flatContinuationSamplesEqual(
        flatByFleet,
        initialEnemyHitPointStatesFlatByFleet[representatives[groupIndex]],
        sample,
      )) {
        groupByState[stateIndex] = groupIndex;
        continue;
      }
      if (groupIndex != null) {
        groupIndex = representatives.findIndex((representative) =>
          flatContinuationSamplesEqual(
            flatByFleet,
            initialEnemyHitPointStatesFlatByFleet[representative],
            sample,
          ));
        if (groupIndex >= 0) {
          groupByState[stateIndex] = groupIndex;
          continue;
        }
      }
      groupIndex = representatives.length;
      if (!groupsByHash.has(sampleHash)) groupsByHash.set(sampleHash, groupIndex);
      representatives.push(stateIndex);
      groupByState[stateIndex] = groupIndex;
      context.combatEnemies.forEach((enemy, enemyIndex) => {
        const flat = flatByFleet?.[enemyIndex];
        const supplied = flat?.values?.subarray(
          sample * flat.width,
          (sample + 1) * flat.width,
        );
        const hitPoints = hitPointsByState[stateIndex][enemyIndex];
        hitPoints.set(supplied || enemy.ships.map((ship) =>
          Math.max(0, Math.floor(Number(ship.currentHp ?? ship.hp) || 0))));
        previousSunkByState[stateIndex][enemyIndex] = hitPoints.reduce(
          (count, value) => count + Number(value === 0),
          0,
        );
      });
    }

    baseRecords.forEach((record, baseIndex) => {
      for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
        const waveIndex = (baseIndexOffset + baseIndex) * 2 + waveInBase;
        const enemyIndex = context.dispatchMode === 'separate' ? waveInBase : 0;
        const captured = trajectory.attackSlots[baseIndex][waveInBase];
        const attackSlots = attackSlotsByBase[baseIndex];
        attackSlots.fill(0);
        const attackerIndices = trajectory.attackerIndices[baseIndex];
        const capturedOffset = sample * captured.width;
        for (let attackerIndex = 0; attackerIndex < attackerIndices.length; attackerIndex += 1) {
          attackSlots[attackerIndices[attackerIndex]] =
            captured.values[capturedOffset + attackerIndex];
        }
        const planeOrder = numericCombatPlaneOrder(record.numeric, attackSlots);
        const contactMultiplier = contactMultiplierAt(
          trajectory.contactMultiplierIndices[baseIndex][waveInBase][sample],
        );
        /** Reads the fixed combat draw assigned to this wave, attack, and sample. */
        const random = (attackIndex, drawKind) =>
          context.combatDraws[waveIndex][attackIndex][drawKind][sample];
        for (const stateIndex of representatives) {
          const resolved = resolvePreparedAttackSequence({
            prepared: record.combat[enemyIndex],
            currentSlots: attackSlots,
            hitPoints: hitPointsByState[stateIndex][enemyIndex],
            planeOrder,
            random,
            output: combatOutputs[stateIndex],
            scratch: combatScratches[stateIndex],
            contactMultiplier,
          });
          sampleHpDamageByState[stateIndex] += resolved.totalHpDamage;
          sampleSunkByState[stateIndex] += resolved.sunkCount -
            previousSunkByState[stateIndex][enemyIndex];
          previousSunkByState[stateIndex][enemyIndex] = resolved.sunkCount;
        }
      }
    });
    for (let stateIndex = 0; stateIndex < stateCount; stateIndex += 1) {
      const representative = representatives[groupByState[stateIndex]];
      totalHpDamageByState[stateIndex] += sampleHpDamageByState[representative];
      totalSunkByState[stateIndex] += sampleSunkByState[representative];
    }
    diagnostics.hpVectorStates = (diagnostics.hpVectorStates || 0) + stateCount;
    diagnostics.hpVectorsResolved = (diagnostics.hpVectorsResolved || 0) +
      representatives.length;
    diagnostics.hpVectorCacheHits = (diagnostics.hpVectorCacheHits || 0) +
      stateCount - representatives.length;
  }

  return Array.from({ length: stateCount }, (_unused, stateIndex) => ({
    calculationMode: 'detailed',
    mode: 'detailed',
    seed: context.seed,
    sampleCount: context.sampleCount,
    samplesEvaluated: context.sampleCount,
    allWaveTargetFulfillmentProbability: trajectory.allWaveTargetFulfillmentProbability,
    expectedDamage: trajectory.expectedDamage,
    attackPowerProxy: trajectory.expectedDamage,
    totalDamageAcrossSamples: trajectory.totalDamageAcrossSamples,
    totalAttackPowerProxyAcrossSamples: trajectory.totalDamageAcrossSamples,
    expectedHpDamage: totalHpDamageByState[stateIndex] / context.sampleCount,
    expectedSunkCount: totalSunkByState[stateIndex] / context.sampleCount,
    expectedOwnSlotLoss: trajectory.expectedOwnSlotLoss,
    expectedResourceCost: trajectory.expectedResourceCost,
    worstMargin: trajectory.worstMargin,
    maximumFinalEnemyAir: trajectory.maximumFinalEnemyAir,
  }));
}

/** Verifies two flat continuation states at one fixed-sample coordinate. */
function flatContinuationSamplesEqual(left, right, sample) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  for (let fleetIndex = 0; fleetIndex < left.length; fleetIndex += 1) {
    const leftFleet = left[fleetIndex];
    const rightFleet = right[fleetIndex];
    if (leftFleet.width !== rightFleet.width) return false;
    const offset = sample * leftFleet.width;
    for (let valueIndex = 0; valueIndex < leftFleet.width; valueIndex += 1) {
      if (leftFleet.values[offset + valueIndex] !== rightFleet.values[offset + valueIndex]) {
        return false;
      }
    }
  }
  return true;
}

/** Reuses exact concentrated two-wave enemy transitions for equal initial air power. */
function evaluateReusableConcentratedSegment({
  base,
  context,
  baseIndexOffset,
  initialEnemySlotsBySample,
  captureFinalEnemySlots,
  initialContactStatesBySample,
  initialContactStatesFlatByFleet,
  captureFinalContactStates,
}) {
  const {
    sampleCount,
    seed,
    fixedRandom,
    enemies,
    targetRanks,
    concentratedPrefixTrajectoryCache,
    concentratedContinuationTrajectoryCaches,
  } = context;
  const ownSlots = base.initialSlots;
  const ownAir = numericBaseAirPower(base, ownSlots, false);
  const hasPlane = baseHasPlane(base, ownSlots);
  const airKey = `${baseIndexOffset}:${ownAir}:${hasPlane ? 1 : 0}`;
  let trajectoryCache = concentratedPrefixTrajectoryCache;
  if (initialEnemySlotsBySample) {
    trajectoryCache = concentratedContinuationTrajectoryCaches.get(initialEnemySlotsBySample);
    if (!trajectoryCache) {
      trajectoryCache = createConcentratedSegmentCache();
      concentratedContinuationTrajectoryCaches.set(initialEnemySlotsBySample, trajectoryCache);
    }
  }
  let trajectory = trajectoryCache.byAir.get(airKey);
  let enemyTrajectorySimulations = 0;
  let enemyTransitionSimulations = 0;
  let stateSignatureProbes = 0;

  if (!trajectory) {
    const enemy = enemies[0];
    const firstWaveIndex = baseIndexOffset * 2;
    const secondWaveIndex = firstWaveIndex + 1;
    const firstWaveStateRanks = Array(sampleCount);
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const enemySlots = Float64Array.from(
        initialEnemySlotsBySample?.[sample]?.[0] || enemy.initialSlots,
      );
      firstWaveStateRanks[sample] = numericAirStateRank(
        ownAir,
        numericEnemyAirPower(enemy, enemySlots),
        hasPlane,
      );
    }
    stateSignatureProbes = 1;
    const firstWaveSignature = `${baseIndexOffset}:${firstWaveStateRanks.join(',')}`;
    let firstWaveSlotsBySample = trajectoryCache.afterFirstWave.get(firstWaveSignature);
    if (!firstWaveSlotsBySample) {
      firstWaveSlotsBySample = firstWaveStateRanks.map((stateRank, sample) => {
        const enemySlots = Float64Array.from(
          initialEnemySlotsBySample?.[sample]?.[0] || enemy.initialSlots,
        );
        applyNumericEnemyStageOne(
          enemy,
          enemySlots,
          airStateKeyForRank(stateRank),
          fixedRandom,
          sample,
          firstWaveIndex,
        );
        return Array.from(enemySlots);
      });
      trajectoryCache.afterFirstWave.set(firstWaveSignature, firstWaveSlotsBySample);
      enemyTransitionSimulations += 1;
    }

    const secondWaveStateRanks = firstWaveSlotsBySample.map((slots) =>
      numericAirStateRank(
        ownAir,
        numericEnemyAirPower(enemy, slots),
        hasPlane,
      ));
    const stateSignature = `${firstWaveSignature};${secondWaveStateRanks.join(',')}`;
    trajectory = trajectoryCache.byState.get(stateSignature);
    if (!trajectory) {
      const finalEnemySlotsBySample = [];
      const secondWaveStateKeys = Array(sampleCount);
      let fulfilledSamples = 0;
      let maximumFinalEnemyAir = 0;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const enemySlots = Float64Array.from(firstWaveSlotsBySample[sample]);
        const secondWaveStateKey = airStateKeyForRank(secondWaveStateRanks[sample]);
        secondWaveStateKeys[sample] = secondWaveStateKey;
        applyNumericEnemyStageOne(
          enemy,
          enemySlots,
          secondWaveStateKey,
          fixedRandom,
          sample,
          secondWaveIndex,
        );
        maximumFinalEnemyAir = Math.max(
          maximumFinalEnemyAir,
          numericEnemyAirPower(enemy, enemySlots),
        );
        finalEnemySlotsBySample.push([Array.from(enemySlots)]);
        if (firstWaveStateRanks[sample] >= targetRanks[firstWaveIndex] &&
            secondWaveStateRanks[sample] >= targetRanks[secondWaveIndex]) {
          fulfilledSamples += 1;
        }
      }
      trajectory = {
        enemyTrajectoryId: context.nextEnemyTrajectoryId++,
        allWaveTargetFulfillmentProbability: fulfilledSamples / sampleCount,
        finalEnemySlotsBySample,
        maximumFinalEnemyAir: [maximumFinalEnemyAir],
        firstWaveStateKeys: firstWaveStateRanks.map(airStateKeyForRank),
        secondWaveStateKeys,
        damageContributionTotals: new Map(),
        lossSlotHistograms: new Map(),
      };
      trajectoryCache.byState.set(stateSignature, trajectory);
      enemyTrajectorySimulations = 1;
      enemyTransitionSimulations += 1;
    }
    trajectoryCache.byAir.set(airKey, trajectory);
  }

  let damageContributionSimulations = 0;
  const lossSlotTrajectories = base.planes.map((plane, slotIndex) => {
    if (!plane) return null;
    const currentSlot = ownSlots[slotIndex];
    const lossKey = JSON.stringify([
      currentSlot,
      base.lossKeys[slotIndex],
      plane.lossModifier,
      plane.isStageTwoTarget,
      plane.shootDownAvoidance,
    ]);
    let values = trajectory.lossSlotHistograms.get(lossKey);
    if (values) return values;
    values = new Uint16Array(sampleCount * 2);
    trajectory.secondWaveStateKeys.forEach((secondStateKey, sample) => {
      [trajectory.firstWaveStateKeys[sample], secondStateKey].forEach((stateKey, waveInBase) => {
        const waveIndex = baseIndexOffset * 2 + waveInBase;
        const loss = stateKey === 'none' ? 0 : numericPlayerLoss(
          stateKey,
          currentSlot,
          fixedRandom(sample, waveIndex, 'player', base.lossKeys[slotIndex], 0),
          plane.lossModifier,
        );
        values[sample * 2 + waveInBase] = numericEnemyStageTwoAfter(
          plane,
          currentSlot - loss,
          enemies[0].stage2Defense,
          fixedRandom,
          sample,
          waveIndex,
          base.lossKeys[slotIndex],
        );
      });
    });
    trajectory.lossSlotHistograms.set(lossKey, values);
    damageContributionSimulations += 1;
    return values;
  });
  const contactTrajectory = resolveConcentratedContactTrajectory({
    base,
    baseIndexOffset,
    fixedRandom,
    initialContactStatesBySample,
    initialContactStatesFlatByFleet,
    lossSlotTrajectories,
    sampleCount,
    trajectory,
  });
  const contactHash = compactContactTrajectoryHash(contactTrajectory.multiplierIndices);
  let totalDamage = 0;
  base.planes.forEach((plane, slotIndex) => {
    if (!plane) return;
    const contributionKey = JSON.stringify([
      plane.scoreCacheKey,
      ownSlots[slotIndex],
      base.lossKeys[slotIndex],
      contactHash,
    ]);
    let contributionTotal = trajectory.damageContributionTotals.get(contributionKey);
    if (contributionTotal == null) {
      const slots = lossSlotTrajectories[slotIndex];
      contributionTotal = 0;
      for (let index = 0; index < slots.length; index += 1) {
        contributionTotal += plane.damageByContactTier[
          contactTrajectory.multiplierIndices[index]
        ][slots[index]] || 0;
      }
      trajectory.damageContributionTotals.set(contributionKey, contributionTotal);
    }
    totalDamage += contributionTotal;
  });

  return {
    calculationMode: 'detailed',
    mode: 'detailed',
    seed,
    sampleCount,
    samplesEvaluated: sampleCount,
    simulationWorkSamples:
      (stateSignatureProbes + enemyTransitionSimulations +
        damageContributionSimulations) * sampleCount,
    enemyTrajectorySimulations,
    stateSignatureProbes,
    damageContributionSimulations,
    enemyTrajectoryId: trajectory.enemyTrajectoryId,
    allWaveTargetFulfillmentProbability: trajectory.allWaveTargetFulfillmentProbability,
    expectedDamage: totalDamage / sampleCount,
    attackPowerProxy: totalDamage / sampleCount,
    totalDamageAcrossSamples: totalDamage,
    totalAttackPowerProxyAcrossSamples: totalDamage,
    maximumFinalEnemyAir: trajectory.maximumFinalEnemyAir,
    ...(captureFinalEnemySlots
      ? { finalEnemySlotsBySample: trajectory.finalEnemySlotsBySample }
      : {}),
    ...(captureFinalContactStates
      ? { finalContactStatesBySample: contactTrajectory.finalStatesBySample }
      : {}),
  };
}

/** Resolves exact contact tiers from cached per-plane concentrated loss trajectories. */
function resolveConcentratedContactTrajectory(options) {
  const {
    base,
    baseIndexOffset,
    fixedRandom,
    initialContactStatesBySample,
    initialContactStatesFlatByFleet,
    lossSlotTrajectories,
    sampleCount,
    trajectory,
  } = options;
  const multiplierIndices = new Uint8Array(sampleCount * 2);
  const finalStatesBySample = [];
  const slots = new Float64Array(base.planes.length);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    let state = contactStateForSample(
      initialContactStatesBySample,
      initialContactStatesFlatByFleet,
      sample,
      0,
    );
    for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
      const index = sample * 2 + waveInBase;
      lossSlotTrajectories.forEach((values, slotIndex) => {
        slots[slotIndex] = values?.[index] || 0;
      });
      const waveIndex = baseIndexOffset * 2 + waveInBase;
      const stateKey = waveInBase === 0
        ? trajectory.firstWaveStateKeys[sample]
        : trajectory.secondWaveStateKeys[sample];
      const contact = resolveContactState(
        base.contactProfile,
        slots,
        stateKey,
        state,
        fixedRandom(sample, waveIndex, 'combat-contact', 0, 0),
      );
      state = contact.state;
      multiplierIndices[index] = contactMultiplierIndex(contact.multiplier);
    }
    finalStatesBySample.push([{ ...state }]);
  }
  return { multiplierIndices, finalStatesBySample };
}

/** Hashes one compact contact multiplier trajectory for exact contribution reuse. */
function compactContactTrajectoryHash(values) {
  let hash = 2166136261 >>> 0;
  for (const value of values) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash.toString(16);
}

function createConcentratedSegmentCache() {
  return {
    byAir: new Map(),
    byState: new Map(),
    afterFirstWave: new Map(),
  };
}

function applyNumericEnemyStageOne(enemy, slots, stateKey, fixedRandom, sample, waveIndex) {
  if (stateKey === 'none') return;
  enemy.sortieAntiAir.forEach((_antiAir, slotIndex) => {
    const before = slots[slotIndex];
    const constant = ENEMY_STAGE_ONE_CONSTANTS[stateKey];
    const x = Math.floor(
      fixedRandom(sample, waveIndex, 'enemy', enemy.instanceIds[slotIndex], 0) *
      (constant + 1),
    );
    const y = Math.floor(
      fixedRandom(sample, waveIndex, 'enemy', enemy.instanceIds[slotIndex], 1) *
      (constant + 1),
    );
    const loss = Math.min(before, Math.floor(before * (0.65 * x + 0.35 * y) / 10));
    slots[slotIndex] = Math.max(0, before - loss);
  });
}

function canReuseConcentratedPrefixTrajectory(options) {
  const isCapturedPrefix = options.baseIndexOffset === 0 &&
    options.initialEnemySlotsBySample == null &&
    options.initialEnemySlotsFlatByFleet == null &&
    options.captureFinalEnemySlots === true;
  const isContinuation = options.baseIndexOffset > 0 &&
    options.initialEnemySlotsBySample != null;
  return options.dispatchMode === 'concentrated' &&
    options.disableConcentratedSegmentReuse !== true &&
    options.bases.length === 1 &&
    options.bases[0].hasJet === false &&
    (isCapturedPrefix || isContinuation) &&
    options.incumbentScore == null;
}

/**
 * Returns a fixed-sample damage upper bound by ignoring jet losses and applying
 * ordinary player losses with the best possible air state.
 */
function maximumDetailedExpectedDamage(options = {}) {
  const context = options.damageBoundContext || createDetailedDamageBoundContext(options);
  const baseIndexOffset = Math.max(0, Math.floor(Number(options.baseIndexOffset) || 0));
  const bases = normalizeBases(options.bases || options.loadouts || []);
  let totalDamage = 0;

  bases.forEach((base, baseIndex) => {
    const lossKeys = playerLossCoordinates(base);
    const reconModifier = landBasedReconDamageModifier(base.filter(Boolean));
    base.forEach((plane, slotIndex) => {
      if (!plane) return;
      totalDamage += maximumPlaneDamageContribution(
        context,
        plane,
        lossKeys[slotIndex],
        baseIndexOffset + baseIndex,
        reconModifier,
      );
    });
  });

  return totalDamage / context.sampleCount;
}

/** Returns one plane's cached integer damage total across all fixed samples. */
function maximumPlaneDamageContribution(
  context,
  plane,
  lossCoordinate,
  baseIndex,
  reconModifier,
) {
  const planeKey = aircraftEquivalenceKey(plane);
  const contributionKey = JSON.stringify([
    planeKey,
    reconModifier,
    lossCoordinate,
    baseIndex,
  ]);
  const cached = context.contributionCache.get(contributionKey);
  if (cached != null) return cached;

  const curve = detailedDamageCurve(context, plane, planeKey, reconModifier);
  let total = 0;
  for (let sample = 0; sample < context.sampleCount; sample += 1) {
    let currentSlot = curve.initialSlot;
    for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
      const waveIndex = baseIndex * 2 + waveInBase;
      const before = context.dispatchMode === 'concentrated' ? curve.initialSlot : currentSlot;
      const after = Math.max(0, before - numericPlayerLoss(
        'supremacy',
        before,
        context.fixedRandom(sample, waveIndex, 'player', lossCoordinate, 0),
        curve.lossModifier,
      ));
      if (context.dispatchMode === 'separate') currentSlot = after;
      total += curve.damageBySlot[after] || 0;
    }
  }
  context.contributionCache.set(contributionKey, total);
  return total;
}

/** Returns a cached slot-to-damage curve for one plane and base recon modifier. */
function detailedDamageCurve(context, plane, planeKey, reconModifier) {
  const cacheKey = JSON.stringify([planeKey, reconModifier]);
  const cached = context.damageCurveCache.get(cacheKey);
  if (cached) return cached;

  const capabilities = capabilitiesFor(plane);
  const isJet = plane.isJet === true || capabilities.isJet === true;
  const isAswPatrol = plane.isAswPatrol === true || capabilities.isAswPatrol === true;
  const isAttacker = plane.isAttacker === true || capabilities.isAttacker === true;
  const initialSlot = Math.max(0, Math.ceil(currentSlotForPlane(plane)));
  const curve = {
    initialSlot,
    lossModifier: isJet ? 0.6 : isAswPatrol && !isAttacker ? 0.91 : 1,
    damageBySlot: Array.from({ length: initialSlot + 1 }, (_unused, currentSlot) =>
      calculatePlaneSurfaceTargetPowerProxy(plane, {
        currentSlot,
        reconModifier,
        combatContext: context.combatContext,
        contactMultiplier: 1.2,
      })),
  };
  context.damageCurveCache.set(cacheKey, curve);
  return curve;
}

/** Returns the best fulfillment and damage averages still reachable by this sample prefix. */
function optimisticFixedSampleScore(
  accumulator,
  samplesEvaluated,
  sampleCount,
  maximumDamagePerSample,
  combatBounds = null,
) {
  const remainingSamples = sampleCount - samplesEvaluated;
  const score = {
    fulfillment: (
      accumulator.allWaveTargetsFulfilled + remainingSamples
    ) / sampleCount,
    damage: (
      accumulator.totalDamage + remainingSamples * maximumDamagePerSample
    ) / sampleCount,
  };
  if (accumulator.combatAvailable && combatBounds) {
    score.sunk = (
      accumulator.totalSunkCount + remainingSamples * combatBounds.maximumSunkCount
    ) / sampleCount;
    score.hpDamage = (
      accumulator.totalHpDamage + remainingSamples * combatBounds.maximumHpDamage
    ) / sampleCount;
    score.loss = -accumulator.totalOwnSlotLoss / sampleCount;
    score.resource = -accumulator.totalResourceCost / sampleCount;
  }
  return score;
}

/** Prunes only on strict fixed-sample lexicographic bounds, never statistical confidence. */
function cannotBeatDetailedIncumbent(optimisticScore, incumbentScore) {
  if (!incumbentScore) return false;
  const combatFields = ['sunk', 'hpDamage'];
  const combat = combatFields.every((field) =>
    Number.isFinite(Number(optimisticScore[field])) &&
    Number.isFinite(Number(incumbentScore[field])));
  if (combat) {
    for (const field of ['fulfillment', 'sunk', 'hpDamage', 'damage', 'loss', 'resource']) {
      const optimistic = Number(optimisticScore[field]);
      const incumbent = Number(incumbentScore[field]);
      if (!Number.isFinite(optimistic) || !Number.isFinite(incumbent)) return false;
      if (optimistic !== incumbent) return optimistic < incumbent;
    }
    return false;
  }
  const incumbentFulfillment = Number(incumbentScore.fulfillment);
  const incumbentDamage = Number(incumbentScore.damage);
  if (!Number.isFinite(incumbentFulfillment) || !Number.isFinite(incumbentDamage)) return false;
  if (optimisticScore.fulfillment !== incumbentFulfillment) {
    return optimisticScore.fulfillment < incumbentFulfillment;
  }
  return optimisticScore.damage < incumbentDamage;
}

/** Returns per-sample fleet-wide sink and HP ceilings for safe combat pruning. */
function combatSampleBounds(options, dispatchMode) {
  const enemies = normalizeEnemyInputs(options, dispatchMode);
  let maximumSunkCount = 0;
  let maximumHpDamage = 0;
  for (const enemy of enemies) {
    const ships = completeCombatShips(enemy.ships);
    if (!ships) return null;
    maximumSunkCount += ships.length;
    maximumHpDamage += ships.reduce(
      (total, ship) => total + Number(ship.maxHp ?? ship.hp),
      0,
    );
  }
  return { maximumSunkCount, maximumHpDamage };
}

/** Applies one ordinary player Stage 1 draw to each current base slot. */
function applyPlayerStageOne(
  base,
  stateKey,
  waveIndex,
  random,
  lossKeys = playerLossCoordinates(base),
) {
  if (stateKey === 'none') return unchangedOwnSlotDetails(base);
  return base.map((plane, slotIndex) => {
    if (!plane) return { slotIndex, before: 0, loss: 0, after: 0 };
    const before = plane.currentSlot;
    const loss = playerStageOneLoss(
      stateKey,
      before,
      () => random(waveIndex, 'player', lossKeys[slotIndex], 0),
      plane,
    );
    plane.currentSlot = Math.max(0, before - loss);
    return { slotIndex, before, loss, after: plane.currentSlot };
  });
}

/** Applies two independent enemy Stage 1 draws to each detailed enemy slot. */
function applyEnemyStageOne(enemy, stateKey, waveIndex, random) {
  if (stateKey === 'none') {
    return enemy.slots.map((slot, slotIndex) => ({
      slotIndex,
      instanceId: slot.instanceId,
      before: slot.currentSlot,
      loss: 0,
      after: slot.currentSlot,
    }));
  }
  return enemy.slots.map((slot, slotIndex) => {
    const before = slot.currentSlot;
    let draw = 0;
    const loss = enemyStageOneLoss(
      stateKey,
      before,
      () => random(waveIndex, 'enemy', slot.instanceId ?? slotIndex, draw++),
    );
    slot.currentSlot = Math.max(0, before - loss);
    return { slotIndex, instanceId: slot.instanceId, before, loss, after: slot.currentSlot };
  });
}

/** Runs the kc-web jet Stage 1, enemy Stage 2, and steel-cost phase. */
function simulateJetAssault(
  base,
  stage2Defense,
  waveIndex,
  random,
  lossKeys = playerLossCoordinates(base),
) {
  if (!base.some((plane) => hasCapability(plane, 'isJet'))) return null;
  const ownSlotsBefore = slotsForPlanes(base);
  let usedSteel = 0;
  const stageOne = base.map((plane, slotIndex) => {
    if (!plane) return { slotIndex, before: 0, loss: 0, after: 0 };
    const before = plane.currentSlot;
    if (!hasCapability(plane, 'isJet') || plane.isEscortItem) {
      return { slotIndex, before, loss: 0, after: before };
    }
    usedSteel += Math.round(
      before * nonNegativeFinite(plane.cost, 0) * 0.2 *
      (hasCapability(plane, 'isHeavyJet') ? 1.2 : 1),
    );
    const loss = playerStageOneLoss(
      'supremacy',
      before,
      () => random(waveIndex, 'jet-player', lossKeys[slotIndex], 0),
      { ...plane, isJet: true },
    );
    plane.currentSlot = Math.max(0, before - loss);
    return { slotIndex, before, loss, after: plane.currentSlot };
  });
  const stageTwo = applyEnemyStageTwo(
    base,
    stage2Defense,
    waveIndex,
    random,
    lossKeys,
    {
      phasePrefix: 'jet-stage2',
      isEligible: (plane, capabilities) => Boolean(
        plane &&
        !plane.isEscortItem &&
        (plane.isJet === true || capabilities.isJet === true) &&
        !(plane.isFighter === true || capabilities.isFighter === true),
      ),
    },
  );
  const slotDetails = stageOne.map((detail, slotIndex) => ({
    slotIndex,
    before: detail.before,
    stageOneLoss: detail.loss,
    afterStageOne: detail.after,
    stageTwoLoss: stageTwo[slotIndex].loss,
    loss: detail.loss + stageTwo[slotIndex].loss,
    after: stageTwo[slotIndex].after,
  }));
  const rawAir = base.reduce((total, plane) => {
    if (!plane || hasCapability(plane, 'isRecon')) return total;
    return total + calculateSlotAirPower(plane);
  }, 0);
  return {
    phase: 'jetAssault',
    ownAirBefore: calculateBaseAirPower(base.map((plane, index) => plane ? {
      ...plane,
      currentSlot: ownSlotsBefore[index],
    } : null)),
    ownAirAfter: Math.floor(rawAir * landReconCoefficient(base.filter(Boolean))),
    ownSlotsBefore,
    ownSlotsAfter: slotsForPlanes(base),
    slotDetails,
    usedSteel,
    stage2Modeled: stage2Defense?.modeled === true,
  };
}

/** Creates scalar and nested-array accumulators from the first sample shape. */
function createSimulationAccumulator(template) {
  const combatAvailable = template.totalHpDamage != null;
  return {
    template,
    waves: template.waves.map(createWaveAccumulator),
    allWaveTargetsFulfilled: 0,
    totalDamage: 0,
    combatAvailable,
    totalHpDamage: 0,
    totalSunkCount: 0,
    totalOwnSlotLoss: 0,
    totalEnemySlotLoss: 0,
    totalUsedSteel: 0,
    totalSupplyFuel: 0,
    totalSupplyBauxite: 0,
    totalResourceCost: 0,
    finalOwnSlots: zeroNested(template.finalBases.map((base) => slotsForPlanes(base))),
    finalOwnAir: zeroNested(template.finalOwnAir),
    finalEnemySlots: zeroNested(template.enemyFleets.map((enemy) => slotsForEnemy(enemy))),
    finalEnemyAir: zeroNested(template.finalEnemyAir),
    finalEnemyHp: combatAvailable
      ? zeroNested(template.enemyFleets.map(enemyHpForFleet))
      : null,
  };
}

/** Adds one simulation result without retaining the sample object. */
function addSimulationSample(accumulator, sample) {
  accumulator.allWaveTargetsFulfilled += sample.allWaveTargetsFulfilled ? 1 : 0;
  accumulator.totalDamage += sample.totalDamage;
  if (accumulator.combatAvailable) {
    accumulator.totalHpDamage += sample.totalHpDamage;
    accumulator.totalSunkCount += sample.totalSunkCount;
  }
  accumulator.totalOwnSlotLoss += sample.totalOwnSlotLoss;
  accumulator.totalEnemySlotLoss += sample.totalEnemySlotLoss;
  accumulator.totalUsedSteel += sample.totalUsedSteel;
  accumulator.totalSupplyFuel += sample.totalSupplyFuel;
  accumulator.totalSupplyBauxite += sample.totalSupplyBauxite;
  accumulator.totalResourceCost += sample.totalResourceCost;
  addNested(accumulator.finalOwnSlots, sample.finalBases.map((base) => slotsForPlanes(base)));
  addNested(accumulator.finalOwnAir, sample.finalOwnAir);
  addNested(accumulator.finalEnemySlots, sample.enemyFleets.map((enemy) => slotsForEnemy(enemy)));
  addNested(accumulator.finalEnemyAir, sample.finalEnemyAir);
  if (accumulator.combatAvailable) {
    addNested(accumulator.finalEnemyHp, sample.enemyFleets.map(enemyHpForFleet));
  }
  sample.waves.forEach((wave, index) => addWaveSample(accumulator.waves[index], wave));
}

/** Creates one online wave accumulator. */
function createWaveAccumulator(template) {
  return {
    template,
    stateCounts: Object.fromEntries(Object.keys(AIR_STATES).map((key) => [key, 0])),
    fulfilled: 0,
    enemyAirBefore: 0,
    enemyAirAfter: 0,
    ownAirBefore: 0,
    ownAirAfter: 0,
    enemySlotsBefore: zeroNested(template.enemySlotsBefore),
    enemySlotsAfter: zeroNested(template.enemySlotsAfter),
    ownSlotsBefore: zeroNested(template.ownSlotsBefore),
    ownSlotsAfter: zeroNested(template.ownSlotsAfter),
    damage: 0,
    combatAvailable: template.hpDamage != null,
    hpDamage: 0,
    sunkCount: 0,
    ownSlotLoss: 0,
    enemySlotLoss: 0,
  };
}

/** Adds one exact wave result to its online accumulator. */
function addWaveSample(accumulator, wave) {
  accumulator.stateCounts[wave.state.key] += 1;
  accumulator.fulfilled += wave.fulfilled ? 1 : 0;
  accumulator.enemyAirBefore += wave.enemyAirBefore;
  accumulator.enemyAirAfter += wave.enemyAirAfter;
  accumulator.ownAirBefore += wave.ownAirBefore;
  accumulator.ownAirAfter += wave.ownAirAfter;
  addNested(accumulator.enemySlotsBefore, wave.enemySlotsBefore);
  addNested(accumulator.enemySlotsAfter, wave.enemySlotsAfter);
  addNested(accumulator.ownSlotsBefore, wave.ownSlotsBefore);
  addNested(accumulator.ownSlotsAfter, wave.ownSlotsAfter);
  accumulator.damage += wave.damage;
  if (accumulator.combatAvailable) {
    accumulator.hpDamage += wave.hpDamage;
    accumulator.sunkCount += wave.sunkCount;
  }
  accumulator.ownSlotLoss += wave.ownSlotLoss;
  accumulator.enemySlotLoss += wave.enemySlotLoss;
}

/** Finalizes one wave accumulator to the public Monte Carlo summary shape. */
function finalizeWaveAccumulator(accumulator, sampleCount) {
  const template = accumulator.template;
  return {
    waveIndex: template.waveIndex,
    baseIndex: template.baseIndex,
    waveInBase: template.waveInBase,
    targetIndex: template.targetIndex,
    targetState: template.targetState,
    stateProbabilities: Object.fromEntries(
      Object.entries(accumulator.stateCounts)
        .map(([key, count]) => [key, count / sampleCount]),
    ),
    targetFulfillmentProbability: accumulator.fulfilled / sampleCount,
    targetFulfillmentConfidence95: wilsonScoreInterval(accumulator.fulfilled, sampleCount),
    expectedEnemyAirBefore: accumulator.enemyAirBefore / sampleCount,
    expectedEnemyAirAfter: accumulator.enemyAirAfter / sampleCount,
    expectedOwnAirBefore: accumulator.ownAirBefore / sampleCount,
    expectedOwnAirAfter: accumulator.ownAirAfter / sampleCount,
    expectedEnemySlotsBefore: divideNested(accumulator.enemySlotsBefore, sampleCount),
    expectedEnemySlotsAfter: divideNested(accumulator.enemySlotsAfter, sampleCount),
    expectedOwnSlotsBefore: divideNested(accumulator.ownSlotsBefore, sampleCount),
    expectedOwnSlotsAfter: divideNested(accumulator.ownSlotsAfter, sampleCount),
    expectedDamage: accumulator.damage / sampleCount,
    attackPowerProxy: accumulator.damage / sampleCount,
    expectedHpDamage: accumulator.combatAvailable
      ? accumulator.hpDamage / sampleCount
      : null,
    expectedSunkCount: accumulator.combatAvailable
      ? accumulator.sunkCount / sampleCount
      : null,
    expectedOwnSlotLoss: accumulator.ownSlotLoss / sampleCount,
    expectedEnemySlotLoss: accumulator.enemySlotLoss / sampleCount,
  };
}

/** Resolves one LBAS sortie without leaking first-wave losses into concentrated wave two. */
function simulatePlayerWave(
  base,
  stage2Defense,
  stateKey,
  waveIndex,
  random,
  lossKeys,
  persist,
) {
  const sortieBase = persist
    ? base
    : base.map((plane) => plane ? { ...plane } : null);
  const stageOne = applyPlayerStageOne(
    sortieBase,
    stateKey,
    waveIndex,
    random,
    lossKeys,
  );
  const stageTwo = applyEnemyStageTwo(
    sortieBase,
    stage2Defense,
    waveIndex,
    random,
    lossKeys,
  );
  return {
    sortieBase,
    slotDetails: stageOne.map((detail, slotIndex) => ({
      slotIndex,
      before: detail.before,
      stageOneLoss: detail.loss,
      afterStageOne: detail.after,
      stageTwoLoss: stageTwo[slotIndex].loss,
      loss: detail.loss + stageTwo[slotIndex].loss,
      after: stageTwo[slotIndex].after,
    })),
  };
}

/** Applies enemy no-cut-in Stage 2 to attack-capable aircraft only. */
function applyEnemyStageTwo(base, defense, waveIndex, random, lossKeys, options = {}) {
  const phasePrefix = options.phasePrefix || 'player-stage2';
  return base.map((plane, slotIndex) => {
    const before = plane?.currentSlot || 0;
    const capabilities = capabilitiesFor(plane || {});
    const isStageTwoTarget = typeof options.isEligible === 'function'
      ? options.isEligible(plane, capabilities)
      : isLbasCombatAttacker(plane);
    if (!isStageTwoTarget || defense?.modeled !== true || before <= 0) {
      return { slotIndex, before, loss: 0, after: before };
    }
    const status = stageTwoShootdownStatus(defense, plane.shootDownAvoidance);
    const shipCount = Math.min(status.rateFactors.length, status.fixedLosses.length);
    if (!shipCount) return { slotIndex, before, loss: 0, after: before };
    const coordinate = lossKeys[slotIndex];
    const shipIndex = Math.min(
      shipCount - 1,
      Math.floor(unitRandom(random(waveIndex, `${phasePrefix}-ship`, coordinate, 0)) * shipCount),
    );
    let after = before;
    if (unitRandom(random(waveIndex, `${phasePrefix}-rate`, coordinate, 0)) >= 0.5) {
      after -= Math.floor(status.rateFactors[shipIndex] * after);
    }
    if (unitRandom(random(waveIndex, `${phasePrefix}-fixed`, coordinate, 0)) >= 0.5) {
      after -= status.fixedLosses[shipIndex];
    }
    after = Math.max(0, after);
    plane.currentSlot = after;
    return { slotIndex, before, loss: before - after, after };
  });
}

/** Precomputes slot-indexed air, damage, and loss metadata for numeric scoring. */
function prepareNumericBase(base, combatContext, planeCurveCache = null) {
  const sourcePlanes = base.filter(Boolean);
  const airCoefficient = landReconCoefficient(sourcePlanes);
  const damageCoefficient = landBasedReconDamageModifier(sourcePlanes);
  const planes = base.map((plane) => prepareNumericPlane(
    plane,
    damageCoefficient,
    combatContext,
    planeCurveCache,
  ));
  return {
    planes,
    contactProfile: prepareContactProfile(base),
    initialSlots: base.map((plane) => plane?.currentSlot || 0),
    lossKeys: playerLossCoordinates(base),
    airCoefficient,
    hasJet: planes.some((plane) => plane?.isJet),
  };
}

/** Prepares one immutable combat sequence per enemy fleet for a numeric base. */
function prepareNumericCombatSequences(base, context, options) {
  const reconModifier = landBasedReconDamageModifier(base.filter(Boolean));
  return context.combatEnemies.map((enemy) => {
    const ships = completeCombatShips(enemy.ships);
    if (!ships) return null;
    return prepareAttackSequence({
      planes: base,
      ships,
      reconModifier,
      combatContext: options.combatContext,
      proficiencyBoundary: options.proficiencyBoundary,
      formation: enemy.formation,
      isCombined: Number(enemy.battleType) === 2 ||
        ships.some((ship) => ship.fleet === 'escort'),
    });
  });
}

/** Materializes every combat draw coordinate once for allocation-free sample scoring. */
function ensureCombatDraws(context) {
  if (context.combatDraws) return context.combatDraws;
  const drawKinds = [...COMBAT_DRAW_KINDS];
  if (context.combatEnemies.some((enemy) =>
    enemy.ships.some((ship) => ship.isSubmarine === true ||
      [13, 14].includes(Number(ship.type))))) {
    drawKinds.push('asw-power');
  }
  if (context.combatEnemies.some((enemy) =>
    enemy.ships.some((ship) => specialAirstrikeProfile(ship) != null))) {
    drawKinds.push('special-postcap');
  }
  context.combatDraws = Array.from({ length: context.targetRanks.length }, (_, waveIndex) =>
    Array.from({ length: 4 }, (_, attackIndex) => {
      const draws = {};
      drawKinds.forEach((drawKind) => {
        draws[drawKind] = fixedRandomValues(
          context,
          waveIndex,
          `combat-${drawKind}`,
          attackIndex,
          0,
        );
      });
      return draws;
    }));
  return context.combatDraws;
}

/** Prepares direct fixed-random vectors for Stage 1 scoring without per-sample map lookups. */
function prepareDetailedRandomVectors(context, bases, baseIndexOffset) {
  return bases.map((base, baseIndex) => Array.from({ length: 2 }, (_, waveInBase) => {
    const waveIndex = (baseIndexOffset + baseIndex) * 2 + waveInBase;
    const enemyIndex = context.dispatchMode === 'separate' ? waveInBase : 0;
    const enemy = context.enemies[enemyIndex];
    return {
      contact: fixedRandomValues(context, waveIndex, 'combat-contact', enemyIndex, 0),
      enemy: enemy.instanceIds.map((instanceId) => [
        fixedRandomValues(context, waveIndex, 'enemy', instanceId, 0),
        fixedRandomValues(context, waveIndex, 'enemy', instanceId, 1),
      ]),
      player: base.planes.map((plane, slotIndex) => plane
        ? fixedRandomValues(context, waveIndex, 'player', base.lossKeys[slotIndex], 0)
        : null),
      jetPlayer: base.planes.map((plane, slotIndex) => plane?.isJet
        ? fixedRandomValues(context, waveIndex, 'jet-player', base.lossKeys[slotIndex], 0)
        : null),
      playerStageTwo: prepareStageTwoRandomVectors(
        context,
        base,
        waveIndex,
        'player-stage2',
        (plane) => plane?.isStageTwoTarget,
      ),
      jetStageTwo: prepareStageTwoRandomVectors(
        context,
        base,
        waveIndex,
        'jet-stage2',
        (plane) => plane?.isJet && plane.isStageTwoTarget && !plane.isEscortItem,
      ),
    };
  }));
}

/** Prepares direct enemy Stage 2 draw vectors for eligible aircraft. */
function prepareStageTwoRandomVectors(context, base, waveIndex, phasePrefix, isEligible) {
  return base.planes.map((plane, slotIndex) => isEligible(plane) ? {
    ship: fixedRandomValues(
      context,
      waveIndex,
      `${phasePrefix}-ship`,
      base.lossKeys[slotIndex],
      0,
    ),
    rate: fixedRandomValues(
      context,
      waveIndex,
      `${phasePrefix}-rate`,
      base.lossKeys[slotIndex],
      0,
    ),
    fixed: fixedRandomValues(
      context,
      waveIndex,
      `${phasePrefix}-fixed`,
      base.lossKeys[slotIndex],
      0,
    ),
  } : null);
}

/** Returns a cached vector for one fixed-random coordinate. */
function fixedRandomValues(context, wave, side, slot, draw) {
  if (typeof context.fixedRandom.valuesFor === 'function') {
    return context.fixedRandom.valuesFor(wave, side, slot, draw);
  }
  const key = JSON.stringify([wave, side, slot, draw]);
  const cached = context.randomVectorCache.get(key);
  if (cached) return cached;
  const values = new Float64Array(context.sampleCount);
  for (let sample = 0; sample < context.sampleCount; sample += 1) {
    values[sample] = context.fixedRandom(sample, wave, side, slot, draw);
  }
  context.randomVectorCache.set(key, values);
  return values;
}

/** Returns canonical combat positions for one numeric base at its current slots. */
function numericCombatPlaneOrder(base, slots) {
  const order = [];
  base.planes.forEach((plane, planeIndex) => {
    if (plane) order.push(planeIndex);
  });
  order.sort((leftIndex, rightIndex) => {
    const left = base.planes[leftIndex];
    const right = base.planes[rightIndex];
    const leftSlot = Math.max(0, Math.floor(slots[leftIndex]));
    const rightSlot = Math.max(0, Math.floor(slots[rightIndex]));
    return left.combatKeysBySlot[leftSlot].localeCompare(right.combatKeysBySlot[rightSlot]) ||
      leftIndex - rightIndex;
  });
  return order;
}

/** Reuses one aircraft's slot curves across every candidate with the same recon modifier. */
function prepareNumericPlane(plane, damageCoefficient, combatContext, cache) {
  if (!plane) return null;
  const cacheKey = JSON.stringify([aircraftEquivalenceKey(plane), damageCoefficient]);
  const cached = cache?.get(cacheKey);
  if (cached) return cached;
  const capabilities = capabilitiesFor(plane);
  const isJet = plane.isJet === true || capabilities.isJet === true;
  const isAswPatrol = plane.isAswPatrol === true || capabilities.isAswPatrol === true;
  const isAttacker = plane.isAttacker === true || capabilities.isAttacker === true;
  const isHeavyJet = plane.isHeavyJet === true || capabilities.isHeavyJet === true;
  const maximumSlot = Math.max(0, Math.ceil(currentSlotForPlane(plane)));
  const prepared = {
    plane,
    scoreCacheKey: cacheKey,
    isJet,
    isAttacker,
    isLbasCombatAttacker: isLbasCombatAttacker(plane),
    isRecon: plane.isRecon === true || capabilities.isRecon === true,
    isStageTwoTarget: isLbasCombatAttacker(plane),
    shootDownAvoidance: Number(plane.shootDownAvoidance) || 0,
    isEscortItem: plane.isEscortItem === true,
    lossModifier: isJet ? 0.6 : isAswPatrol && !isAttacker ? 0.91 : 1,
    jetSteelBySlot: Array.from({ length: maximumSlot + 1 }, (_unused, slot) => Math.round(
      slot * nonNegativeFinite(plane.cost, 0) * 0.2 * (isHeavyJet ? 1.2 : 1),
    )),
    combatKeysBySlot: Array.from({ length: maximumSlot + 1 }, (_unused, slot) =>
      aircraftEquivalenceKey({ ...plane, currentSlot: slot })),
    airBySlot: Array.from({ length: maximumSlot + 1 }, (_unused, slot) =>
      calculateSlotAirPower({ ...plane, currentSlot: slot })),
    damageByContactTier: CONTACT_MULTIPLIERS.map((contactMultiplier) =>
      Array.from({ length: maximumSlot + 1 }, (_unused, slot) =>
        calculatePlaneSurfaceTargetPowerProxy(plane, {
          currentSlot: slot,
          reconModifier: damageCoefficient,
          combatContext,
          contactMultiplier,
        }))),
  };
  cache?.set(cacheKey, prepared);
  return prepared;
}

/** Assigns common-random-number coordinates by canonical plane order, not UI slot order. */
function playerLossCoordinates(base) {
  const coordinates = Array(base.length).fill(null);
  base
    .map((plane, slotIndex) => plane ? {
      slotIndex,
      key: cachedAircraftEquivalenceKey(plane),
    } : null)
    .filter(Boolean)
    .sort((left, right) => left.key.localeCompare(right.key) || left.slotIndex - right.slotIndex)
    .forEach((entry, coordinate) => {
      coordinates[entry.slotIndex] = coordinate;
    });
  return coordinates;
}

/** Prepares immutable detailed-enemy coefficients for numeric scoring. */
function prepareNumericEnemy(enemy) {
  return {
    isAirRaidCell: enemy.isAirRaidCell === true,
    sortieAntiAir: enemy.slots.map((slot) => slot.sortieAntiAir),
    initialSlots: enemy.slots.map((slot) => slot.currentSlot),
    instanceIds: enemy.slots.map((slot, index) => slot.instanceId ?? index),
    stage2Defense: enemy.stage2Defense?.modeled === true ? enemy.stage2Defense : null,
  };
}

/** Calculates current base air power from slot lookup tables. */
function numericBaseAirPower(base, slots, excludeRecon) {
  let rawAir = 0;
  base.planes.forEach((plane, slotIndex) => {
    if (!plane || (excludeRecon && plane.isRecon)) return;
    rawAir += plane.airBySlot[Math.max(0, Math.floor(slots[slotIndex]))] || 0;
  });
  return Math.floor(rawAir * base.airCoefficient);
}

/** Calculates current base damage from slot lookup tables. */
function numericBaseDamage(base, slots, contactMultiplier) {
  const tierIndex = contactMultiplierIndex(contactMultiplier);
  return base.planes.reduce((total, plane, slotIndex) =>
    total + (
      plane?.damageByContactTier[tierIndex][Math.max(0, Math.floor(slots[slotIndex]))] || 0
    ), 0);
}

/** Calculates detailed enemy air power from numeric slots. */
function numericEnemyAirPower(enemy, slots) {
  return enemy.sortieAntiAir.reduce(
    (total, antiAir, index) => total + Math.floor(antiAir * Math.sqrt(slots[index])),
    0,
  );
}

/** Returns the numeric air-state rank without allocating a descriptor object. */
function numericAirStateRank(ownAir, enemyAir, hasPlane) {
  if (enemyAir === 0 && ownAir === 0 && !hasPlane) return AIR_STATES.none.rank;
  if (enemyAir === 0 || ownAir >= enemyAir * 3) return AIR_STATES.supremacy.rank;
  if (ownAir >= Math.ceil(enemyAir * 1.5)) return AIR_STATES.superiority.rank;
  if (ownAir >= Math.floor(enemyAir / 1.5) + 1) return AIR_STATES.parity.rank;
  if (ownAir >= Math.floor(enemyAir / 3) + 1) return AIR_STATES.denial.rank;
  return AIR_STATES.loss.rank;
}

/** Maps numeric ranks back to the Stage 1 constant key. */
function airStateKeyForRank(rank) {
  if (rank === AIR_STATES.none.rank) return 'none';
  if (rank === AIR_STATES.supremacy.rank) return 'supremacy';
  if (rank === AIR_STATES.superiority.rank) return 'superiority';
  if (rank === AIR_STATES.parity.rank) return 'parity';
  if (rank === AIR_STATES.denial.rank) return 'denial';
  return 'loss';
}

/** Applies the player Stage 1 formula with a precomputed aircraft modifier. */
function numericPlayerLoss(stateKey, currentSlot, random, modifier) {
  const constant = PLAYER_STAGE_ONE_CONSTANTS[stateKey];
  const k = Math.floor(random * ((1000 * constant / 3) + 1));
  const raw = currentSlot * ((k / 1000) + constant / 4) / 10;
  return Math.min(currentSlot, Math.floor(raw * modifier));
}

function applyNumericEnemyStageTwo(
  base,
  slots,
  defense,
  fixedRandom,
  sample,
  waveIndex,
  options = {},
) {
  if (defense?.modeled !== true) return;
  const phasePrefix = options.phasePrefix || 'player-stage2';
  base.planes.forEach((plane, slotIndex) => {
    const isEligible = typeof options.isEligible === 'function'
      ? options.isEligible(plane)
      : plane?.isStageTwoTarget;
    if (!isEligible) return;
    slots[slotIndex] = numericEnemyStageTwoAfter(
      plane,
      slots[slotIndex],
      defense,
      fixedRandom,
      sample,
      waveIndex,
      base.lossKeys[slotIndex],
      phasePrefix,
      options.randomVectors?.[slotIndex],
    );
  });
}

function numericEnemyStageTwoAfter(
  plane,
  currentSlot,
  defense,
  fixedRandom,
  sample,
  waveIndex,
  coordinate,
  phasePrefix = 'player-stage2',
  randomVectors = null,
) {
  if (!plane?.isStageTwoTarget || defense?.modeled !== true || currentSlot <= 0) {
    return currentSlot;
  }
  const status = stageTwoShootdownStatus(defense, plane.shootDownAvoidance);
  const shipCount = Math.min(status.rateFactors.length, status.fixedLosses.length);
  if (!shipCount) return currentSlot;
  const shipIndex = Math.min(
    shipCount - 1,
    Math.floor((randomVectors?.ship?.[sample] ?? fixedRandom(
      sample, waveIndex, `${phasePrefix}-ship`, coordinate, 0,
    )) * shipCount),
  );
  let after = currentSlot;
  if ((randomVectors?.rate?.[sample] ?? fixedRandom(
    sample, waveIndex, `${phasePrefix}-rate`, coordinate, 0,
  )) >= 0.5) {
    after -= Math.floor(status.rateFactors[shipIndex] * after);
  }
  if ((randomVectors?.fixed?.[sample] ?? fixedRandom(
    sample, waveIndex, `${phasePrefix}-fixed`, coordinate, 0,
  )) >= 0.5) {
    after -= status.fixedLosses[shipIndex];
  }
  return Math.max(0, after);
}

/** Returns whether any physical plane in the base still has aircraft. */
function baseHasPlane(base, slots) {
  return base.planes.some((plane, index) => plane && slots[index] > 0);
}

/** Converts base summaries, loadouts, or simulator slots to cloned current-slot planes. */
function normalizeBases(bases) {
  return (bases || []).map((base) => {
    const source = Array.isArray(base)
      ? base
      : base?.loadout || base?.slots?.map((slot) =>
        slot && Object.prototype.hasOwnProperty.call(slot, 'plane') ? slot.plane : slot) || [];
    return source.map((plane) => plane ? {
      ...plane,
      currentSlot: currentSlotForPlane(plane),
    } : null);
  });
}

/** Normalizes one or two enemy inputs and enforces real separate targets. */
function normalizeEnemyInputs(options, dispatchMode) {
  const source = options.enemyFleets || options.targets || (options.enemy ? [options.enemy] : []);
  if (dispatchMode === 'separate') {
    if (!Array.isArray(source) || source.length !== 2 || source[0] === source[1]) {
      throw new RangeError(
        'Separate dispatch requires exactly two independent enemy fleets or targets.',
      );
    }
    return source.map(normalizeEnemyFleet);
  }
  if (!source.length) {
    throw new Error('Detailed wave simulation requires an enemy fleet.');
  }
  return [normalizeEnemyFleet(source[0])];
}

/** Safely normalizes the required detailed enemy slot fields. */
function normalizeEnemyFleet(enemy = {}) {
  const slots = enemy.slots ?? enemy.enemySlots ?? [];
  const validation = validateAndNormalizeDetailedEnemySlots(slots);
  if (!validation.valid) throw detailedEnemyValidationError(validation.errors);
  return {
    ...enemy,
    mode: 'detailed',
    isAirRaidCell: enemy.isAirRaidCell === true,
    stage2Defense: enemy.stage2Defense?.modeled === true ? enemy.stage2Defense : null,
    slots: validation.slots,
    ships: Array.isArray(enemy.ships)
      ? enemy.ships.map(normalizeEnemyShipHitPoints)
      : [],
  };
}

/** Canonicalizes maximum and current HP once for simulation and proof consumers. */
function normalizeEnemyShipHitPoints(ship = {}) {
  if (ship.maxHp == null && ship.hp == null) return { ...ship };
  const maxHp = Math.max(0, Math.floor(Number(ship.maxHp ?? ship.hp) || 0));
  const currentHp = Math.max(
    0,
    Math.floor(Number(ship.currentHp ?? ship.hp ?? maxHp) || 0),
  );
  return { ...ship, maxHp, currentHp };
}

/** Returns a detached enemy fleet copy. */
function cloneEnemyFleet(enemy) {
  return {
    ...enemy,
    slots: enemy.slots.map((slot) => ({ ...slot })),
    ships: enemy.ships.map((ship) => ({ ...ship })),
  };
}

/** Resolves one wave's attacks when every real enemy ship has HP and armor. */
function resolveWaveCombat(options) {
  const ships = completeCombatShips(options.enemy.ships);
  if (!ships) return null;
  const planes = canonicalCombatPlanes(options.planes);
  const reconModifier = landBasedReconDamageModifier(planes);
  const sunkBefore = countSunkShips(ships);
  const result = resolveAttackSequence({
    planes,
    ships,
    combatContext: options.combatContext,
    reconModifier,
    proficiencyBoundary: options.proficiencyBoundary,
    formation: options.enemy.formation,
    isCombined: Number(options.enemy.battleType) === 2,
    contactMultiplier: options.contactMultiplier,
    random: (attackIndex, drawKind) => options.random(
      options.waveIndex,
      `combat-${drawKind}`,
      attackIndex,
      0,
    ),
  });
  options.enemy.ships = result.ships.map((ship) => ({ ...ship }));
  return {
    result,
    totalHpDamage: result.totalHpDamage,
    sunkThisWave: result.sunkCount - sunkBefore,
  };
}

/** Returns detached meaningful ships only when combat fields are complete. */
function completeCombatShips(ships) {
  const meaningful = (Array.isArray(ships) ? ships : [])
    .filter((ship) => ship && (
      ship.id != null || ship.name || ship.hp != null || ship.maxHp != null
    ));
  if (!meaningful.length || meaningful.some((ship) => {
    const hp = Number(ship.maxHp ?? ship.hp);
    const armor = Number(ship.armor);
    return !Number.isFinite(hp) || hp <= 0 || !Number.isFinite(armor) || armor < 0;
  })) return null;
  return meaningful.map((ship) => ({ ...ship }));
}

/** Orders aircraft by formula-relevant properties for stable common random numbers. */
function canonicalCombatPlanes(planes) {
  return (Array.isArray(planes) ? planes : [])
    .filter(Boolean)
    .sort((left, right) =>
      cachedAircraftEquivalenceKey(left).localeCompare(cachedAircraftEquivalenceKey(right)));
}

/** Clones one candidate once and derives immutable combat metadata shared by every sample. */
function prepareMonteCarloBases(bases) {
  const prepared = normalizeBases(bases);
  prepared.forEach((base) => base.forEach((plane) => {
    if (!plane) return;
    plane.isAttacker = plane.isAttacker === true || capabilitiesFor(plane).isAttacker === true;
    if (plane[AIRCRAFT_EQUIVALENCE_CACHE]) return;
    Object.defineProperty(plane, AIRCRAFT_EQUIVALENCE_CACHE, {
      value: new Map(),
      enumerable: true,
    });
  }));
  return prepared;
}

/** Reuses the exact full equivalence key for one immutable plane at one current slot. */
function cachedAircraftEquivalenceKey(plane) {
  const cache = plane?.[AIRCRAFT_EQUIVALENCE_CACHE];
  if (!cache) return aircraftEquivalenceKey(plane);
  const currentSlot = Number(plane.currentSlot);
  const slotKey = Number.isFinite(currentSlot) ? Math.max(0, currentSlot) : 'missing';
  let key = cache.get(slotKey);
  if (key == null) {
    key = aircraftEquivalenceKey(plane);
    cache.set(slotKey, key);
  }
  return key;
}

/** Counts ships already reduced to zero HP. */
function countSunkShips(ships) {
  return ships.filter((ship) => {
    const maximum = Number(ship.maxHp ?? ship.hp);
    const current = Number(ship.currentHp ?? ship.hp);
    return maximum > 0 && current === 0;
  }).length;
}

/** Returns current enemy HP in stable fleet order. */
function enemyHpForFleet(enemy) {
  return enemy.ships.map((ship) => Number(ship.currentHp ?? ship.hp) || 0);
}

function detailedLimitationsFor(enemies) {
  const limitations = [...DETAILED_LIMITATIONS];
  if (enemies.length && enemies.every((enemy) => enemy.stage2Defense?.modeled === true)) {
    return limitations.filter((code) =>
      code !== 'PLAYER_STAGE2_OMITTED' && code !== 'JET_STAGE2_OMITTED');
  }
  return limitations;
}

/** Returns normal base air power from current slots. */
function currentSlotForPlane(plane) {
  const value = plane.currentSlot ?? plane.slotSize ?? defaultSlotSizeForPlane(plane);
  return nonNegativeFinite(value, 0);
}

/** Returns an unchanged detail record for waves that defer player losses. */
function unchangedOwnSlotDetails(base) {
  return base.map((plane, slotIndex) => ({
    slotIndex,
    before: plane?.currentSlot || 0,
    loss: 0,
    after: plane?.currentSlot || 0,
  }));
}

/** Returns the current slots for a normalized player base. */
function slotsForPlanes(base) {
  return base.map((plane) => plane?.currentSlot || 0);
}

/** Returns the current slots for a normalized enemy fleet. */
function slotsForEnemy(enemy) {
  return enemy.slots.map((slot) => slot.currentSlot);
}

/** Calculates enemy air without renormalizing its mutable simulation copy. */
function airPowerForEnemy(enemy) {
  return enemy.slots.reduce(
    (total, slot) => total + Math.floor(slot.sortieAntiAir * Math.sqrt(slot.currentSlot)),
    0,
  );
}

/** Restores one target's compact or nested contact continuation for a sample. */
function contactStateForSample(nestedStates, flatStates, sample, enemyIndex) {
  const nested = nestedStates?.[sample]?.[enemyIndex];
  if (nested) return createContactState(nested);
  const flat = flatStates?.[enemyIndex];
  if (!flat || flat.width < 2) return createContactState();
  const offset = sample * flat.width;
  return decodeContactState(flat.values.subarray(offset, offset + 2));
}

/** Normalizes requested wave targets while retaining legacy parity defaults. */
function normalizeTargets(targetStates, count) {
  const source = Array.isArray(targetStates) ? targetStates : [];
  const fallback = AIR_STATES[source[0]] ? source[0] : 'parity';
  return Array.from({ length: count }, (_, index) =>
    AIR_STATES[source[index]] ? source[index] : fallback);
}

/** Reads a state-keyed Stage 1 constant and rejects NONE explicitly. */
function stageOneConstant(map, stateKey) {
  if (stateKey === 'none') throw new Error('NONE must not be passed to Stage 1 formulas.');
  const constant = map[stateKey];
  if (constant == null) throw new Error(`Unknown air state: ${stateKey}`);
  return constant;
}

/** Checks explicit and derived aircraft capabilities. */
function hasCapability(plane, capability) {
  return Boolean(plane) &&
    (plane[capability] === true || capabilitiesFor(plane)[capability] === true);
}

/** Clamps arbitrary RNG output to the half-open unit interval. */
function unitRandom(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(number, 1 - Number.EPSILON);
}

/** Converts numeric input to a finite nonnegative value. */
function nonNegativeFinite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/** Sums one slot vector. */
function sumSlots(slots) {
  return slots.reduce((total, slot) => total + slot, 0);
}

/** Creates a zero-filled numeric structure with the same nested array shape. */
function zeroNested(values) {
  return values.map((value) => Array.isArray(value) ? zeroNested(value) : 0);
}

/** Adds one nested numeric structure into another in place. */
function addNested(total, values) {
  values.forEach((value, index) => {
    if (Array.isArray(value)) addNested(total[index], value);
    else total[index] += value;
  });
}

/** Divides a nested numeric accumulator without mutating it. */
function divideNested(total, divisor) {
  return total.map((value) => Array.isArray(value)
    ? divideNested(value, divisor)
    : value / divisor);
}

module.exports = {
  DETAILED_LIMITATIONS,
  calculateEnemyAirPower,
  createDetailedDamageBoundContext,
  createDetailedScoreContext,
  enemyStageOneLoss,
  evaluateDetailedCombatContinuationBatch,
  evaluateDetailedPlanScore,
  maximumDetailedExpectedDamage,
  monteCarloWaveSequence,
  normalizeEnemyFleet,
  normalizeEnemyShipHitPoints,
  playerStageOneLoss,
  simulateWaveSequence,
};
