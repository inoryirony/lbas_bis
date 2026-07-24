'use strict';

const { internalProficiencyBounds } = require('./air-power');
const { capabilitiesFor } = require('./aircraft');
const { calculatePlaneTargetAttackPower } = require('./damage');
const {
  CONTACT_MULTIPLIERS,
  contactMultiplierAt,
  contactMultiplierIndex,
} = require('./combat-contact');
const {
  specialAirstrikeAccuracyMultiplier,
  specialAirstrikeProfile,
} = require('./enemy-airstrike-rules');

const SHIP_TYPES = Object.freeze({
  DD: 2,
  CL: 3,
  CLT: 4,
  CA: 5,
  CAV: 6,
  CVL: 7,
  FBB: 8,
  BB: 9,
  BBV: 10,
  CV: 11,
  BBB: 12,
  AV: 16,
  CVB: 18,
});
const PROFICIENCY_HIT_OFFSETS = Object.freeze([0, 0, 1, 2, 3, 4, 6, 9]);
const PROFICIENCY_CRITICAL_VALUES = Object.freeze([0, 1, 2, 3, 4, 5, 7, 10]);
/** @type {Set<number>} */
const BATTLESHIP_TYPES = new Set([
  SHIP_TYPES.FBB,
  SHIP_TYPES.BB,
  SHIP_TYPES.BBV,
  SHIP_TYPES.BBB,
]);
/** @type {Set<number>} */
const CARRIER_TYPES = new Set([SHIP_TYPES.CVL, SHIP_TYPES.CV, SHIP_TYPES.CVB]);
const COMBAT_FORMULA = Object.freeze({
  formulaVersion: 'lbas-combat-v1',
  confidence: 'established_simulator_assumption',
  source: Object.freeze({
    repository: 'KC3Kai/kancolle-replay',
    revision: 'ec3094c5ba57e289d2716a75ab5f4dee31f1b07f',
    path: 'js/kcsim.js',
  }),
  limitations: Object.freeze([]),
});

/** Returns whether one plane participates in LBAS HP combat under explicit or derived capability data. */
function isLbasCombatAttacker(plane) {
  if (!plane) return false;
  const capabilities = capabilitiesFor(plane);
  return plane.isLbasCombatAttacker === true ||
    plane.isAttacker === true ||
    plane.canAttackSurface === true ||
    plane.canAttackSubmarine === true ||
    capabilities.isLbasCombatAttacker === true;
}

/** Returns versioned empirical hit/critical probabilities for one target. */
function calculateHitAndCriticalProbabilities(plane = {}, target = {}, options = {}) {
  const proficiency = proficiencyCombatTerms(plane, options);
  const isCombined = options.isCombined === true;
  const avoidanceMultiplier = isCombined
    ? Number(plane.masterId) === 459 ? 0.7 : 0.68
    : 0.86;
  const limitationCodes = [];
  if (!isFiniteInput(target.evasion)) limitationCodes.push('TARGET_EVASION_MISSING');
  if (!isFiniteInput(target.luck)) limitationCodes.push('TARGET_LUCK_MISSING');

  const targetAdjustment = targetAccuracyAdjustment(plane, target);
  const ptMultiplier = specialAirstrikeProfile(target)?.id === 'pt'
    ? Number(plane.masterId) === 459 ? 0.85 : 0.95
    : 1;
  const baseAccuracy = (
    0.9 + 0.07 * nonNegativeNumber(plane.accuracy)
  ) * specialAirstrikeAccuracyMultiplier(target) * ptMultiplier + targetAdjustment;
  const evasion = Math.floor(
    nonNegativeNumber(target.evasion) + Math.sqrt(2 * nonNegativeNumber(target.luck)),
  );
  const cappedDodge = evasion > 65
    ? Math.floor(55 + 2 * Math.sqrt(evasion - 65))
    : evasion > 40
      ? Math.floor(40 + 3 * Math.sqrt(evasion - 40))
      : evasion;
  const hitPercent = percentageFloor(baseAccuracy);
  const dodgePercent = percentageFloor(cappedDodge * 0.01 * avoidanceMultiplier);
  let accuracyPercent = Math.min(96, Math.floor(Math.max(hitPercent - dodgePercent, 10)));
  accuracyPercent += proficiency.hitBonus;
  const hitProbability = Math.min(1, Math.max(0, Math.floor(accuracyPercent) / 100));
  const criticalPercent = Math.floor(
    Math.sqrt(Math.max(0, accuracyPercent)) + proficiency.criticalRateBonus,
  );
  const criticalProbability = Math.min(hitProbability, Math.max(0, criticalPercent / 100));

  return {
    formulaVersion: COMBAT_FORMULA.formulaVersion,
    confidence: COMBAT_FORMULA.confidence,
    hitProbability,
    criticalProbability,
    criticalDamageMultiplier: proficiency.criticalDamageMultiplier,
    avoidanceMultiplier,
    baseAccuracy,
    targetAccuracyAdjustment: targetAdjustment,
    cappedDodge,
    proficiencyAssumption: proficiency.assumption,
    internalProficiency: proficiency.internalProficiency,
    limitationCodes,
  };
}

/** Resolves confirmed armor randomization and scratch damage against current HP. */
function resolveArmorDamage(options = {}) {
  return resolveArmorDamageInto(options, {});
}

/** Resolves armor damage into a caller-owned record to support allocation-free sampling. */
function resolveArmorDamageInto(options = {}, result = {}) {
  const currentHp = Math.max(0, Math.floor(nonNegativeNumber(options.currentHp)));
  const armor = nonNegativeNumber(options.armor);
  const criticalMultiplier = positiveNumber(options.criticalMultiplier, 1);
  const attackPower = nonNegativeNumber(options.attackPower);
  const power = criticalMultiplier > 1
    ? Math.floor(attackPower * criticalMultiplier)
    : attackPower;
  const armorRandom = Math.floor(clampRoll(options.armorRoll) * Math.floor(armor));
  const armorReduction = 0.7 * armor + 0.6 * armorRandom;
  let rawDamage = Math.floor(power - armorReduction);
  let scratch = false;
  if (rawDamage <= 0 && currentHp > 0) {
    scratch = true;
    rawDamage = Math.floor(
      currentHp * 0.06 + 0.08 * Math.floor(clampRoll(options.scratchRoll) * currentHp),
    );
  }
  rawDamage = Math.max(0, rawDamage);
  const hpDamage = Math.min(currentHp, rawDamage);
  const remainingHp = Math.max(0, currentHp - hpDamage);
  result.attackPower = attackPower;
  result.criticalMultiplier = criticalMultiplier;
  result.powerAfterCritical = power;
  result.armor = armor;
  result.armorRandom = armorRandom;
  result.armorReduction = armorReduction;
  result.rawDamage = rawDamage;
  result.hpDamage = hpDamage;
  result.remainingHp = remainingHp;
  result.scratch = scratch;
  result.sunk = currentHp > 0 && remainingHp === 0;
  return result;
}

/** Precomputes immutable plane-target combat data for repeated attack sequences. */
function prepareAttackSequence(options = {}) {
  const planes = Array.isArray(options.planes) ? options.planes : [];
  const ships = (Array.isArray(options.ships) ? options.ships : []).map((ship, index) => ({
    ...ship,
    sourceShipIndex: ship.sourceShipIndex ?? index,
    maxHp: Math.max(0, Math.floor(nonNegativeNumber(ship.maxHp ?? ship.hp))),
    currentHp: Math.max(0, Math.floor(nonNegativeNumber(
      ship.currentHp ?? ship.hp ?? ship.maxHp,
    ))),
  }));
  const isCombined = options.isCombined === true ||
    ships.some((ship) => ship.fleet === 'escort');
  const profiles = planes.map((plane) => {
    if (!plane) return null;
    const capabilities = capabilitiesFor(plane);
    const canAttackSurface = plane.canAttackSurface === true || plane.isAttacker === true ||
      capabilities.canAttackSurface;
    const canAttackSubmarine = plane.canAttackSubmarine === true ||
      capabilities.canAttackSubmarine;
    const maximumSlot = Math.max(
      0,
      Math.ceil(nonNegativeNumber(plane.currentSlot ?? plane.slotSize)),
    );
    return {
      plane,
      isAttacker: isLbasCombatAttacker(plane),
      canAttackSurface,
      canAttackSubmarine,
      targets: ships.map((target) => {
        if (!canAttackTarget(canAttackSurface, canAttackSubmarine, target)) return null;
        const probabilities = calculateHitAndCriticalProbabilities(
          plane,
          target,
          { ...options, isCombined },
        );
        const specialProfile = specialAirstrikeProfile(target);
        return {
          probabilities,
          hasSpecialPostCap: specialProfile != null,
          attackPowerByContactTier: CONTACT_MULTIPLIERS.map((contactMultiplier) =>
            Array.from({ length: maximumSlot + 1 }, (_unused, currentSlot) =>
              calculatePlaneTargetAttackPower(plane, target, {
                currentSlot,
                combatContext: options.combatContext,
                reconModifier: options.reconModifier,
                isCombined,
                contactMultiplier,
              }))),
        };
      }),
    };
  });
  return {
    planes,
    ships,
    profiles,
    isCombined,
    hasSubmarineTargets: ships.some(isSubmarine),
    hasSpecialTargets: ships.some((ship) => specialAirstrikeProfile(ship) != null),
    formation: Number(options.formation) || 0,
    combatContext: options.combatContext,
    reconModifier: options.reconModifier,
    initialHitPoints: Int32Array.from(ships.map((ship) => ship.currentHp)),
  };
}

/** Resolves one prepared attack sequence while mutating only the supplied HP vector. */
function resolvePreparedAttackSequence(options = {}) {
  const prepared = options.prepared;
  if (!prepared || !Array.isArray(prepared.profiles)) {
    throw new TypeError('A prepared attack sequence is required.');
  }
  const currentSlots = options.currentSlots || prepared.planes.map((plane) =>
    nonNegativeNumber(plane?.currentSlot ?? plane?.slotSize));
  const hitPoints = options.hitPoints || Int32Array.from(prepared.initialHitPoints);
  const planeOrder = options.planeOrder || prepared.profiles
    .map((profile, index) => profile ? index : null)
    .filter((index) => index != null);
  const random = typeof options.random === 'function'
    ? options.random
    : () => Math.random();
  const collectEvents = options.collectEvents === true;
  const events = collectEvents ? [] : null;
  const scratch = options.scratch || {};
  const damage = scratch.damage || (scratch.damage = {});
  const draws = scratch.draws || (scratch.draws = {});
  const attackOrder = scratch.attackOrder || (scratch.attackOrder = []);
  const contactTierIndex = contactMultiplierIndex(options.contactMultiplier);
  const contactMultiplier = contactMultiplierAt(contactTierIndex);
  attackOrder.length = 0;
  let totalHpDamage = 0;

  for (const planeIndex of planeOrder) {
    if (prepared.profiles[planeIndex]?.isAttacker &&
        nonNegativeNumber(currentSlots[planeIndex]) > 0) attackOrder.push(planeIndex);
  }
  for (let attackIndex = 0; attackIndex < attackOrder.length; attackIndex += 1) {
    const planeIndex = attackOrder[attackIndex];
    const profile = prepared.profiles[planeIndex];
    const plane = profile?.plane;
    const currentSlot = nonNegativeNumber(currentSlots[planeIndex]);
    draws.fleet = clampRoll(random(attackIndex, 'fleet', plane.instanceId));
    draws.target = clampRoll(random(attackIndex, 'target', plane.instanceId));
    draws.flagshipProtection = clampRoll(
      random(attackIndex, 'flagship-protection', plane.instanceId),
    );
    draws.flagshipProtector = clampRoll(
      random(attackIndex, 'flagship-protector', plane.instanceId),
    );
    if (profile.canAttackSubmarine && prepared.hasSubmarineTargets) {
      draws.aswPower = clampRoll(random(attackIndex, 'asw-power', plane.instanceId));
    }
    if (prepared.hasSpecialTargets) {
      draws.specialPostCap = clampRoll(random(attackIndex, 'special-postcap', plane.instanceId));
    }
    draws.hit = clampRoll(random(attackIndex, 'hit', plane.instanceId));
    draws.armor = clampRoll(random(attackIndex, 'armor', plane.instanceId));
    draws.scratch = clampRoll(random(attackIndex, 'scratch', plane.instanceId));
    const selectedTargetIndex = selectPreparedLivingTargetIndex(
      prepared,
      profile,
      hitPoints,
      draws,
    );
    const targetIndex = selectPreparedFlagshipProtectorIndex(
      prepared,
      profile,
      hitPoints,
      selectedTargetIndex,
      draws,
    );
    if (targetIndex < 0) continue;
    const target = prepared.ships[targetIndex];
    const targetProfile = profile.targets[targetIndex];
    const probabilities = targetProfile.probabilities;
    const critical = draws.hit <= probabilities.criticalProbability;
    const hit = critical || draws.hit <= probabilities.hitProbability;
    const slotIndex = Math.max(0, Math.floor(currentSlot));
    const attackPower = isSubmarine(target)
      ? calculatePlaneTargetAttackPower(plane, target, {
        currentSlot,
        combatContext: prepared.combatContext,
        reconModifier: prepared.reconModifier,
        isCombined: prepared.isCombined,
        aswPowerRoll: draws.aswPower,
        contactMultiplier,
      })
      : targetProfile.hasSpecialPostCap
        ?
        calculatePlaneTargetAttackPower(plane, target, {
          currentSlot,
          combatContext: prepared.combatContext,
          reconModifier: prepared.reconModifier,
          isCombined: prepared.isCombined,
          specialPostCapRoll: draws.specialPostCap,
          contactMultiplier,
        })
        : targetProfile.attackPowerByContactTier[contactTierIndex][slotIndex] ??
          calculatePlaneTargetAttackPower(plane, target, {
            currentSlot,
            combatContext: prepared.combatContext,
            reconModifier: prepared.reconModifier,
            isCombined: prepared.isCombined,
            contactMultiplier,
          });

    if (!hit) {
      if (events) events.push({
        attackIndex,
        planeInstanceId: plane.instanceId,
        targetId: target.id,
        targetSourceShipIndex: target.sourceShipIndex,
        hit: false,
        critical: false,
        attackPower,
        hpDamage: 0,
        remainingHp: hitPoints[targetIndex],
        sunk: false,
        probabilities,
      });
      continue;
    }

    resolveArmorDamageInto({
      attackPower,
      criticalMultiplier: critical ? probabilities.criticalDamageMultiplier : 1,
      currentHp: hitPoints[targetIndex],
      armor: target.armor,
      armorRoll: draws.armor,
      scratchRoll: draws.scratch,
    }, damage);
    hitPoints[targetIndex] = damage.remainingHp;
    totalHpDamage += damage.hpDamage;
    if (events) events.push({
      attackIndex,
      planeInstanceId: plane.instanceId,
      targetId: target.id,
      targetSourceShipIndex: target.sourceShipIndex,
      hit: true,
      critical,
      attackPower,
      ...damage,
      probabilities,
    });
  }

  const result = options.output || {};
  result.totalHpDamage = totalHpDamage;
  result.sunkCount = prepared.ships.reduce((count, ship, index) =>
    count + Number(ship.maxHp > 0 && hitPoints[index] === 0), 0);
  if (events) result.events = events;
  return result;
}

/** Resolves aircraft independently and removes sunk targets before later selections. */
function resolveAttackSequence(options = {}) {
  const prepared = prepareAttackSequence(options);
  const hitPoints = Int32Array.from(prepared.initialHitPoints);
  const resolved = resolvePreparedAttackSequence({
    prepared,
    hitPoints,
    random: options.random,
    collectEvents: true,
    contactMultiplier: options.contactMultiplier,
  });
  return {
    formulaVersion: COMBAT_FORMULA.formulaVersion,
    confidence: COMBAT_FORMULA.confidence,
    ships: prepared.ships.map((ship, index) => ({
      ...ship,
      currentHp: hitPoints[index],
    })),
    events: resolved.events,
    totalHpDamage: resolved.totalHpDamage,
    sunkCount: resolved.sunkCount,
    limitations: [...COMBAT_FORMULA.limitations],
  };
}

/** Resolves visible and internal proficiency contributions to hit and critical terms. */
function proficiencyCombatTerms(plane, options) {
  let visible = Math.max(0, Math.min(7, Math.trunc(nonNegativeNumber(plane.proficiency))));
  const explicit = options.internalProficiency ?? plane.internalProficiency;
  const exact = isFiniteInput(explicit);
  const bounds = internalProficiencyBounds(visible);
  const useUpper = options.proficiencyBoundary === 'upper';
  let internalProficiency = exact
    ? Math.max(0, Math.min(120, Number(explicit)))
    : useUpper ? bounds.upper : bounds.lower;
  if ([25, 26].includes(Number(plane.equipType))) {
    internalProficiency *= 0.825;
    if (visible > 0) visible -= 1;
  }
  const criticalValue = PROFICIENCY_CRITICAL_VALUES[visible];
  const hitBonus = visible === 0
    ? 0
    : Math.sqrt(internalProficiency * 0.1) + PROFICIENCY_HIT_OFFSETS[visible];
  return {
    internalProficiency,
    assumption: exact ? 'exact' : useUpper ? 'visible_upper' : 'visible_lower',
    hitBonus,
    criticalRateBonus: criticalValue * 0.8,
    criticalDamageMultiplier: roundToThousandth(1.5 * (
      1 + Math.floor(Math.sqrt(internalProficiency) + criticalValue) / 100
    )),
  };
}

/** Returns equipment-specific accuracy adjustments for one target class. */
function targetAccuracyAdjustment(plane, target) {
  const masterId = Number(plane.masterId) || 0;
  const type = Number(target?.type ?? target?.typeId) || 0;
  const land = target?.isLand === true || target?.isInstallation === true ||
    (target?.speed != null && Number(target.speed) === 0);
  if (masterId === 459 && specialAirstrikeProfile(target)?.id === 'pt') return 0;
  if (masterId === 444) {
    if (type === SHIP_TYPES.DD) return -0.07;
    if (includesShipType(type, [SHIP_TYPES.CL, SHIP_TYPES.CLT, SHIP_TYPES.CVL,
      SHIP_TYPES.FBB, SHIP_TYPES.BB, SHIP_TYPES.BBV, SHIP_TYPES.CV])) return 0.07;
  }
  if (masterId === 484) {
    if (type === SHIP_TYPES.DD) return -0.05;
    if (includesShipType(type, [SHIP_TYPES.CL, SHIP_TYPES.CLT, SHIP_TYPES.CA, SHIP_TYPES.CAV,
      SHIP_TYPES.CVL, SHIP_TYPES.FBB, SHIP_TYPES.BB, SHIP_TYPES.BBV,
      SHIP_TYPES.CV])) return 0.05;
  }
  if (masterId === 453 && type === SHIP_TYPES.DD) return 0.07;
  if (masterId === 454) {
    if (type === SHIP_TYPES.DD) return -0.17;
    if (includesShipType(type, [SHIP_TYPES.CL, SHIP_TYPES.CLT])) return 0.07;
    if (includesShipType(type, [SHIP_TYPES.CA, SHIP_TYPES.CAV, SHIP_TYPES.CVL, SHIP_TYPES.FBB,
      SHIP_TYPES.BB, SHIP_TYPES.BBV, SHIP_TYPES.CV])) return 0.05;
  }
  if (masterId === 459) {
    if (land) return -0.09;
    if (type === SHIP_TYPES.DD) return 0.13;
    if (includesShipType(type, [SHIP_TYPES.CL, SHIP_TYPES.CLT, SHIP_TYPES.AV])) return 0.18;
    if (includesShipType(type, [SHIP_TYPES.CA, SHIP_TYPES.CAV])) return 0.22;
    if (BATTLESHIP_TYPES.has(type) || CARRIER_TYPES.has(type)) return 0.31;
  }
  return 0;
}

/**
 * Tests a numeric ship type without narrowing callers to literal unions.
 * @param {number} type
 * @param {number[]} types
 */
function includesShipType(type, types) {
  return types.some((candidate) => candidate === type);
}

/** Selects the same living target as the object resolver without allocating target pools. */
function selectPreparedLivingTargetIndex(prepared, profile, hitPoints, draws) {
  let mainCount = 0;
  let escortCount = 0;
  for (let index = 0; index < prepared.ships.length; index += 1) {
    if (hitPoints[index] <= 0 || !profile.targets[index]) continue;
    if (prepared.ships[index].fleet === 'escort') escortCount += 1;
    else mainCount += 1;
  }
  const useFleetPool = prepared.isCombined && mainCount > 0 && escortCount > 0;
  const useEscort = useFleetPool && draws.fleet >= 0.45;
  let submarineCount = 0;
  if (profile.canAttackSubmarine) {
    for (let index = 0; index < prepared.ships.length; index += 1) {
      if (hitPoints[index] <= 0 || !profile.targets[index]) continue;
      if (useFleetPool && (prepared.ships[index].fleet === 'escort') !== useEscort) continue;
      if (isSubmarine(prepared.ships[index])) submarineCount += 1;
    }
  }
  const preferSubmarines = submarineCount > 0;
  const poolCount = preferSubmarines
    ? submarineCount
    : useFleetPool ? (useEscort ? escortCount : mainCount) : mainCount + escortCount;
  if (!poolCount) return -1;
  let targetOffset = Math.min(poolCount - 1, Math.floor(draws.target * poolCount));
  for (let index = 0; index < prepared.ships.length; index += 1) {
    if (hitPoints[index] <= 0 || !profile.targets[index]) continue;
    if (useFleetPool && (prepared.ships[index].fleet === 'escort') !== useEscort) continue;
    if (preferSubmarines && !isSubmarine(prepared.ships[index])) continue;
    if (targetOffset === 0) return index;
    targetOffset -= 1;
  }
  return -1;
}

/** Redirects an attack on a main-fleet flagship to one healthy eligible protector. */
function selectPreparedFlagshipProtectorIndex(
  prepared,
  profile,
  hitPoints,
  targetIndex,
  draws,
) {
  if (targetIndex < 0) return targetIndex;
  const target = prepared.ships[targetIndex];
  if (target.isFlagship !== true || target.fleet === 'escort' || isInstallation(target)) {
    return targetIndex;
  }
  const formationRates = [0, 0.45, 0.6, 0.75, 0.6, 0.6, 0.75];
  const protectionRate = formationRates[prepared.formation] || 0.6;
  if (draws.flagshipProtection >= protectionRate) return targetIndex;

  let protectorCount = 0;
  for (let index = 0; index < prepared.ships.length; index += 1) {
    if (isEligibleFlagshipProtector(prepared, profile, hitPoints, targetIndex, index)) {
      protectorCount += 1;
    }
  }
  if (!protectorCount) return targetIndex;
  let protectorOffset = Math.min(
    protectorCount - 1,
    Math.floor(draws.flagshipProtector * protectorCount),
  );
  for (let index = 0; index < prepared.ships.length; index += 1) {
    if (!isEligibleFlagshipProtector(prepared, profile, hitPoints, targetIndex, index)) continue;
    if (protectorOffset === 0) return index;
    protectorOffset -= 1;
  }
  return targetIndex;
}

/** Tests the KC3 flagship-protector HP, target, and installation requirements. */
function isEligibleFlagshipProtector(prepared, profile, hitPoints, targetIndex, index) {
  if (index === targetIndex || hitPoints[index] <= 0 || !profile.targets[index]) return false;
  const ship = prepared.ships[index];
  const target = prepared.ships[targetIndex];
  return ship.fleet === target.fleet && isSubmarine(ship) === isSubmarine(target) &&
    !isInstallation(ship) && hitPoints[index] / ship.maxHp > 0.75;
}

/** Identifies enemy installations from normalized map or custom-enemy fields. */
function isInstallation(ship) {
  return ship?.isLand === true || ship?.isInstallation === true ||
    (ship?.speed != null && Number(ship.speed) === 0);
}

/** Selects one living target for the allocating object-based resolver. */
function selectLivingTarget(ships, plane, draws, isCombined) {
  const living = ships.filter((ship) => ship.currentHp > 0 && canAttackTarget(plane, ship));
  if (!living.length) return null;
  let pool = living;
  if (isCombined) {
    const main = living.filter((ship) => ship.fleet !== 'escort');
    const escort = living.filter((ship) => ship.fleet === 'escort');
    if (main.length && escort.length) pool = draws.fleet < 0.45 ? main : escort;
  }
  return pool[Math.min(pool.length - 1, Math.floor(draws.target * pool.length))];
}

/** Checks whether one prepared attack profile can attack the target domain. */
function canAttackTarget(canAttackSurface, canAttackSubmarine, target) {
  return isSubmarine(target) ? canAttackSubmarine : canAttackSurface;
}

/** Identifies explicit and API-type submarine ships. */
function isSubmarine(target) {
  return target?.isSubmarine === true || [13, 14].includes(Number(target?.type));
}

/** Converts a unit ratio to the formula's floored percentage scale. */
function percentageFloor(ratio) {
  return Math.floor(Math.round(nonNegativeNumber(ratio) * 1000000) / 10000);
}

/** Clamps an arbitrary random value to the half-open unit interval. */
function clampRoll(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1 - Number.EPSILON, number));
}

/** Normalizes finite nonnegative formula inputs to zero. */
function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/** Returns a finite positive input or the supplied formula fallback. */
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Distinguishes an explicit finite numeric input from a missing value. */
function isFiniteInput(value) {
  return value != null && Number.isFinite(Number(value));
}

/** Rounds published formula metadata to three decimal places. */
function roundToThousandth(value) {
  return Math.round(value * 1000) / 1000;
}

module.exports = {
  COMBAT_FORMULA,
  calculateHitAndCriticalProbabilities,
  isLbasCombatAttacker,
  prepareAttackSequence,
  resolveArmorDamage,
  resolveAttackSequence,
  resolvePreparedAttackSequence,
};
