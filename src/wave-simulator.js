'use strict';

const {
  AIR_STATES,
  airStateFor,
  calculateBaseAirPower,
  calculateSlotAirPower,
  defaultSlotSizeForPlane,
  landReconCoefficient,
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
const { requireSampleCount } = require('./simulation-options');
const { stageTwoShootdownStatus } = require('./enemy-stage2');

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
  return Math.min(slot, Math.floor(slot * (0.65 * x + 0.35 * y) / 10));
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
  const bases = normalizeBases(options.bases || options.loadouts || []);
  const playerLossKeys = bases.map(playerLossCoordinates);
  const dispatchMode = options.dispatchMode === 'separate' ? 'separate' : 'concentrated';
  const enemies = normalizeEnemyInputs(options, dispatchMode);
  const targetStates = normalizeTargets(options.targetStates, bases.length * 2);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const waves = [];
  const usedSteelByBase = bases.map(() => 0);
  const initialOwnSlots = bases.map((base) => slotsForPlanes(base));
  const limitations = detailedLimitationsFor(enemies);

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
      const damage = calculateBaseDamagePower(playerWave.sortieBase.filter(Boolean), {
        combatContext: options.combatContext,
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
    totalOwnSlotLoss,
    totalEnemySlotLoss: waves.reduce((total, wave) => total + wave.enemySlotLoss, 0),
    totalUsedSteel,
    totalSupplyFuel,
    totalSupplyBauxite,
    totalResourceCost: totalUsedSteel + totalSupplyFuel + totalSupplyBauxite,
    allWaveTargetsFulfilled: waves.every((wave) => wave.fulfilled),
    limitations,
    limitationNotes: {
      DAMAGE_LOSS_RESOURCE_OPTIMISTIC:
        'Some resource accounting remains omitted, so resource use may be low.',
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
  const maximumDamagePerSample = normalizeBases(options.bases || options.loadouts || [])
    .reduce((total, base) => total + 2 * calculateBaseDamagePower(base.filter(Boolean), {
      combatContext: options.combatContext,
    }), 0);
  let accumulator = null;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const result = simulateWaveSequence({
      ...options,
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
    expectedDamage: accumulator.totalDamage / sampleCount,
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
  const enemies = normalizeEnemyInputs(options, dispatchMode).map(prepareNumericEnemy);
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
    targetRanks,
    combatContext: options.combatContext,
    baseCache: new Map(),
    planeCurveCache: new Map(),
    concentratedPrefixTrajectoryCache: createConcentratedSegmentCache(),
    concentratedContinuationTrajectoryCaches: new WeakMap(),
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
  const baseRecords = sourceBases.map((sourceBase, baseIndex) => {
    const suppliedKey = baseCacheKeys[baseIndex];
    const cacheKey = suppliedKey == null
      ? null
      : `${baseIndexOffset + baseIndex}:${suppliedKey}`;
    if (cacheKey != null && context.baseCache.has(cacheKey)) {
      return context.baseCache.get(cacheKey);
    }
    const normalizedBase = normalizeBases([sourceBase])[0];
    const record = {
      numeric: prepareNumericBase(
        normalizedBase,
        options.combatContext,
        context.planeCurveCache,
      ),
      maximumDamage: 2 * calculateBaseDamagePower(normalizedBase.filter(Boolean), {
        combatContext: options.combatContext,
      }),
    };
    if (cacheKey != null) context.baseCache.set(cacheKey, record);
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
  if (canReuseConcentratedPrefixTrajectory({
    bases,
    baseIndexOffset,
    dispatchMode,
    initialEnemySlotsBySample,
    captureFinalEnemySlots: options.captureFinalEnemySlots,
    incumbentScore: options.incumbentScore,
    disableConcentratedSegmentReuse: options.disableConcentratedSegmentReuse,
    stage2Modeled: enemies.some((enemy) => enemy.stage2Defense?.modeled === true),
  })) {
    return evaluateReusableConcentratedSegment({
      base: bases[0],
      context,
      baseIndexOffset,
      initialEnemySlotsBySample,
      captureFinalEnemySlots: options.captureFinalEnemySlots,
    });
  }
  let fulfilledSamples = 0;
  let totalDamage = 0;
  const maximumFinalEnemyAir = enemies.map(() => 0);
  const finalEnemySlotsBySample = options.captureFinalEnemySlots ? [] : null;

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const ownSlots = bases.map((base) => Float64Array.from(base.initialSlots));
    const suppliedEnemySlots = initialEnemySlotsBySample?.[sample];
    const enemySlots = enemies.map((enemy, enemyIndex) => Float64Array.from(
      suppliedEnemySlots?.[enemyIndex] || enemy.initialSlots,
    ));
    let allTargetsFulfilled = true;

    bases.forEach((base, baseIndex) => {
      const slots = ownSlots[baseIndex];
      let ownAir = numericBaseAirPower(base, slots, false);
      for (let waveInBase = 0; waveInBase < 2; waveInBase += 1) {
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
            slots[slotIndex] = Math.max(0, before - numericPlayerLoss(
              'supremacy',
              before,
              fixedRandom(sample, waveIndex, 'jet-player', base.lossKeys[slotIndex], 0),
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
            },
          );
          ownAir = numericBaseAirPower(base, slots, true);
        }

        const enemyAir = numericEnemyAirPower(enemy, currentEnemySlots);
        const stateRank = numericAirStateRank(ownAir, enemyAir, baseHasPlane(base, slots));
        const stateKey = airStateKeyForRank(stateRank);
        if (stateRank < targetRanks[waveIndex]) allTargetsFulfilled = false;

        if (stateKey !== 'none') {
          enemy.sortieAntiAir.forEach((_antiAir, slotIndex) => {
            const before = currentEnemySlots[slotIndex];
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
            currentEnemySlots[slotIndex] = Math.max(0, before - loss);
          });
        }

        const persistPlayerLoss = dispatchMode === 'separate' || waveInBase === 1;
        const attackSlots = persistPlayerLoss ? slots : Float64Array.from(slots);
        if (stateKey !== 'none') {
          base.planes.forEach((plane, slotIndex) => {
            if (!plane) return;
            const before = attackSlots[slotIndex];
            attackSlots[slotIndex] = Math.max(0, before - numericPlayerLoss(
              stateKey,
              before,
              fixedRandom(sample, waveIndex, 'player', base.lossKeys[slotIndex], 0),
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
        );
        if (persistPlayerLoss) ownAir = numericBaseAirPower(base, slots, false);
        totalDamage += numericBaseDamage(base, attackSlots);
      }
    });

    enemies.forEach((enemy, enemyIndex) => {
      maximumFinalEnemyAir[enemyIndex] = Math.max(
        maximumFinalEnemyAir[enemyIndex],
        numericEnemyAirPower(enemy, enemySlots[enemyIndex]),
      );
    });
    if (finalEnemySlotsBySample) {
      finalEnemySlotsBySample.push(enemySlots.map((slots) => Array.from(slots)));
    }
    if (allTargetsFulfilled) fulfilledSamples += 1;
    const samplesEvaluated = sample + 1;
    const remainingSamples = sampleCount - samplesEvaluated;
    const optimisticScore = {
      fulfillment: (fulfilledSamples + remainingSamples) / sampleCount,
      damage: (totalDamage + remainingSamples * maximumDamagePerSample) / sampleCount,
    };
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

  return {
    calculationMode: 'detailed',
    mode: 'detailed',
    seed,
    sampleCount,
    samplesEvaluated: sampleCount,
    allWaveTargetFulfillmentProbability: fulfilledSamples / sampleCount,
    expectedDamage: totalDamage / sampleCount,
    totalDamageAcrossSamples: totalDamage,
    maximumFinalEnemyAir,
    ...(finalEnemySlotsBySample ? { finalEnemySlotsBySample } : {}),
  };
}

/** Reuses exact concentrated two-wave enemy transitions for equal initial air power. */
function evaluateReusableConcentratedSegment({
  base,
  context,
  baseIndexOffset,
  initialEnemySlotsBySample,
  captureFinalEnemySlots,
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
        allWaveTargetFulfillmentProbability: fulfilledSamples / sampleCount,
        finalEnemySlotsBySample,
        maximumFinalEnemyAir: [maximumFinalEnemyAir],
        firstWaveStateKeys: firstWaveStateRanks.map(airStateKeyForRank),
        secondWaveStateKeys,
        damageContributionTotals: new Map(),
      };
      trajectoryCache.byState.set(stateSignature, trajectory);
      enemyTrajectorySimulations = 1;
      enemyTransitionSimulations += 1;
    }
    trajectoryCache.byAir.set(airKey, trajectory);
  }

  let totalDamage = 0;
  let damageContributionSimulations = 0;
  base.planes.forEach((plane, slotIndex) => {
    if (!plane) return;
    const currentSlot = ownSlots[slotIndex];
    const contributionKey = JSON.stringify([
      plane.scoreCacheKey,
      currentSlot,
      base.lossKeys[slotIndex],
    ]);
    let contributionTotal = trajectory.damageContributionTotals.get(contributionKey);
    if (contributionTotal == null) {
      contributionTotal = 0;
      trajectory.secondWaveStateKeys.forEach((secondStateKey, sample) => {
        [trajectory.firstWaveStateKeys[sample], secondStateKey].forEach((stateKey, waveInBase) => {
          const loss = stateKey === 'none' ? 0 : numericPlayerLoss(
            stateKey,
            currentSlot,
            fixedRandom(
              sample,
              baseIndexOffset * 2 + waveInBase,
              'player',
              base.lossKeys[slotIndex],
              0,
            ),
            plane.lossModifier,
          );
          contributionTotal += plane.damageBySlot[currentSlot - loss] || 0;
        });
      });
      trajectory.damageContributionTotals.set(contributionKey, contributionTotal);
      damageContributionSimulations += 1;
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
    allWaveTargetFulfillmentProbability: trajectory.allWaveTargetFulfillmentProbability,
    expectedDamage: totalDamage / sampleCount,
    totalDamageAcrossSamples: totalDamage,
    maximumFinalEnemyAir: trajectory.maximumFinalEnemyAir,
    ...(captureFinalEnemySlots
      ? { finalEnemySlotsBySample: trajectory.finalEnemySlotsBySample }
      : {}),
  };
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
    options.captureFinalEnemySlots === true;
  const isContinuation = options.baseIndexOffset > 0 &&
    options.initialEnemySlotsBySample != null;
  return options.dispatchMode === 'concentrated' &&
    options.stage2Modeled !== true &&
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
) {
  const remainingSamples = sampleCount - samplesEvaluated;
  return {
    fulfillment: (
      accumulator.allWaveTargetsFulfilled + remainingSamples
    ) / sampleCount,
    damage: (
      accumulator.totalDamage + remainingSamples * maximumDamagePerSample
    ) / sampleCount,
  };
}

/** Prunes only on strict fixed-sample lexicographic bounds, never statistical confidence. */
function cannotBeatDetailedIncumbent(optimisticScore, incumbentScore) {
  if (!incumbentScore) return false;
  const incumbentFulfillment = Number(incumbentScore.fulfillment);
  const incumbentDamage = Number(incumbentScore.damage);
  if (!Number.isFinite(incumbentFulfillment) || !Number.isFinite(incumbentDamage)) return false;
  if (optimisticScore.fulfillment !== incumbentFulfillment) {
    return optimisticScore.fulfillment < incumbentFulfillment;
  }
  return optimisticScore.damage < incumbentDamage;
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
  return {
    template,
    waves: template.waves.map(createWaveAccumulator),
    allWaveTargetsFulfilled: 0,
    totalDamage: 0,
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
  };
}

/** Adds one simulation result without retaining the sample object. */
function addSimulationSample(accumulator, sample) {
  accumulator.allWaveTargetsFulfilled += sample.allWaveTargetsFulfilled ? 1 : 0;
  accumulator.totalDamage += sample.totalDamage;
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
    expectedEnemyAirBefore: accumulator.enemyAirBefore / sampleCount,
    expectedEnemyAirAfter: accumulator.enemyAirAfter / sampleCount,
    expectedOwnAirBefore: accumulator.ownAirBefore / sampleCount,
    expectedOwnAirAfter: accumulator.ownAirAfter / sampleCount,
    expectedEnemySlotsBefore: divideNested(accumulator.enemySlotsBefore, sampleCount),
    expectedEnemySlotsAfter: divideNested(accumulator.enemySlotsAfter, sampleCount),
    expectedOwnSlotsBefore: divideNested(accumulator.ownSlotsBefore, sampleCount),
    expectedOwnSlotsAfter: divideNested(accumulator.ownSlotsAfter, sampleCount),
    expectedDamage: accumulator.damage / sampleCount,
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
      : plane && (
        plane.isAttacker === true ||
        capabilities.isAttacker === true ||
        plane.isAswBomber2 === true ||
        capabilities.isAswBomber2 === true
      );
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
    initialSlots: base.map((plane) => plane?.currentSlot || 0),
    lossKeys: playerLossCoordinates(base),
    airCoefficient,
    hasJet: planes.some((plane) => plane?.isJet),
  };
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
  const maximumSlot = Math.max(0, Math.ceil(currentSlotForPlane(plane)));
  const prepared = {
    plane,
    scoreCacheKey: cacheKey,
    isJet,
    isRecon: plane.isRecon === true || capabilities.isRecon === true,
    isStageTwoTarget: isAttacker || plane.isAswBomber2 === true || capabilities.isAswBomber2 === true,
    shootDownAvoidance: Number(plane.shootDownAvoidance) || 0,
    isEscortItem: plane.isEscortItem === true,
    lossModifier: isJet ? 0.6 : isAswPatrol && !isAttacker ? 0.91 : 1,
    airBySlot: Array.from({ length: maximumSlot + 1 }, (_unused, slot) =>
      calculateSlotAirPower({ ...plane, currentSlot: slot })),
    damageBySlot: Array.from({ length: maximumSlot + 1 }, (_unused, slot) =>
      calculatePlaneSurfaceTargetPowerProxy(plane, {
        currentSlot: slot,
        reconModifier: damageCoefficient,
        combatContext,
      })),
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
      key: aircraftEquivalenceKey(plane),
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
function numericBaseDamage(base, slots) {
  return base.planes.reduce((total, plane, slotIndex) =>
    total + (plane?.damageBySlot[Math.max(0, Math.floor(slots[slotIndex]))] || 0), 0);
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
    if (!isEligible || slots[slotIndex] <= 0) return;
    const status = stageTwoShootdownStatus(defense, plane.shootDownAvoidance);
    const shipCount = Math.min(status.rateFactors.length, status.fixedLosses.length);
    if (!shipCount) return;
    const coordinate = base.lossKeys[slotIndex];
    const shipIndex = Math.min(
      shipCount - 1,
      Math.floor(fixedRandom(
        sample,
        waveIndex,
        `${phasePrefix}-ship`,
        coordinate,
        0,
      ) * shipCount),
    );
    let after = slots[slotIndex];
    if (fixedRandom(sample, waveIndex, `${phasePrefix}-rate`, coordinate, 0) >= 0.5) {
      after -= Math.floor(status.rateFactors[shipIndex] * after);
    }
    if (fixedRandom(sample, waveIndex, `${phasePrefix}-fixed`, coordinate, 0) >= 0.5) {
      after -= status.fixedLosses[shipIndex];
    }
    slots[slotIndex] = Math.max(0, after);
  });
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
  };
}

/** Returns a detached enemy fleet copy. */
function cloneEnemyFleet(enemy) {
  return { ...enemy, slots: enemy.slots.map((slot) => ({ ...slot })) };
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
  evaluateDetailedPlanScore,
  maximumDetailedExpectedDamage,
  monteCarloWaveSequence,
  normalizeEnemyFleet,
  playerStageOneLoss,
  simulateWaveSequence,
};
