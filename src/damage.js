'use strict';

const { capabilitiesFor } = require('./aircraft');
const { defaultSlotSizeForPlane } = require('./air-power');
const { equipmentDamageMultiplier } = require('./combat-context');
const { specialAirstrikeProfile } = require('./enemy-airstrike-rules');

const DAMAGE_CAP = 220;
const LAND_BASED_RECON_DAMAGE_COEFFICIENTS = new Map([
  [311, 1.125],
  [312, 1.15],
  [480, 1.125],
]);
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
  AO_2: 15,
  AV: 16,
  CVB: 18,
  CT: 21,
  AO: 22,
});
/** @type {Set<number>} */
const BATTLESHIP_TYPES = new Set([
  SHIP_TYPES.FBB,
  SHIP_TYPES.BB,
  SHIP_TYPES.BBV,
  SHIP_TYPES.BBB,
]);
const TARGET_POWER_FORMULA = Object.freeze({
  formulaVersion: 'lbas-target-power-v1',
  confidence: 'established_simulator_assumption',
  sources: Object.freeze([
    Object.freeze({
      repository: 'noro6/kc-web',
      revision: 'd490a8411c92669ecbd258bb7c47af392402ea99',
      path: 'src/classes/aerialCombat/powerCalculator.ts',
    }),
    Object.freeze({
      repository: 'KC3Kai/kancolle-replay',
      revision: 'ec3094c5ba57e289d2716a75ab5f4dee31f1b07f',
      path: 'js/kcsim.js',
    }),
  ]),
  unresolved: Object.freeze([
    'type53AirstrikeModifier',
    'master484TargetAdjustment',
    'master454CvlBranch',
    'master562BattleshipAdjustment',
  ]),
});

/** Calculates a surface-target attack-power proxy for one LBAS plane. */
function calculatePlaneSurfaceTargetPowerProxy(plane, options = {}) {
  if (!isAttacker(plane)) {
    return 0;
  }

  const slotSize = currentSlotForPlane(plane, options);
  if (slotSize <= 0) {
    return 0;
  }

  const attack = attackParameters(plane, options.target);
  const specialProfile = specialAirstrikeProfile(options.target);
  const reconModifier = finiteNumber(options.reconModifier ?? 1, 1);
  const basePower = (
    attack.typeMultiplier * attack.stat * Math.sqrt(attack.slotAdjustment * slotSize) +
    attack.airstrikeModifier
  );
  const weaknessPreCapMultiplier = specialProfile
    ? 1
    : positiveMultiplier(options.target?.LBWeak);
  const preCapPower = basePower * reconModifier * attack.preCapMultiplier *
    weaknessPreCapMultiplier;
  const postCapPower = softCap(preCapPower, DAMAGE_CAP);
  const equipmentMultiplier = equipmentDamageMultiplier(
    plane,
    options.combatContext,
  );
  const targetPostCapMultiplier = specialProfile
    ? randomizedPostCapMultiplier(specialProfile, options.specialPostCapRoll)
    : isDiveBomber(plane) ? positiveMultiplier(options.target?.divebombWeak) : 1;
  const combinedMultiplier = options.isCombined === true ? 1.1 : 1;
  const contactMultiplier = positiveMultiplier(options.contactMultiplier);

  return Math.floor(
    postCapPower * attack.postCapMultiplier * targetPostCapMultiplier *
    combinedMultiplier * equipmentMultiplier * contactMultiplier,
  );
}

/** Calculates pre-armor attack power after applying established target-type rules. */
function calculatePlaneTargetAttackPower(plane, target, options = {}) {
  if (isSubmarineTarget(target)) {
    return calculatePlaneSubmarineTargetAttackPower(plane, options);
  }
  return calculatePlaneSurfaceTargetPowerProxy(plane, { ...options, target });
}

/** Calculates randomized LBAS anti-submarine attack power for one current slot. */
function calculatePlaneSubmarineTargetAttackPower(plane, options = {}) {
  if (!hasCapability(plane, 'canAttackSubmarine')) return 0;
  const slotSize = currentSlotForPlane(plane, options);
  if (slotSize <= 0) return 0;
  const asw = Math.max(0, Number(plane.asw) || 0);
  const roll = unitRoll(options.aswPowerRoll);
  const randomMultiplier = asw >= 10
    ? 0.7 + 0.3 * roll
    : 0.35 + 0.45 * roll;
  const reconModifier = finiteNumber(options.reconModifier ?? 1, 1);
  const preCapPower = (25 + asw * Math.sqrt(1.8 * slotSize)) *
    randomMultiplier * reconModifier;
  const cappedPower = softCap(preCapPower, DAMAGE_CAP);
  const typeMultiplier = Number(plane.equipType) === 47 ? 1.8 : 1;
  const combinedMultiplier = options.isCombined === true ? 1.1 : 1;
  const equipmentMultiplier = equipmentDamageMultiplier(plane, options.combatContext);
  const contactMultiplier = positiveMultiplier(options.contactMultiplier);
  return Math.floor(
    cappedPower * typeMultiplier * combinedMultiplier * equipmentMultiplier * contactMultiplier,
  );
}

/** Calculates a base surface-target power proxy with the strongest land-recon modifier. */
function calculateBaseSurfaceTargetPowerProxy(loadout, options = {}) {
  const reconModifier = options.reconModifier ?? landBasedReconDamageModifier(loadout);
  return loadout.reduce(
    (total, plane) => total + calculatePlaneSurfaceTargetPowerProxy(
      plane,
      { ...options, reconModifier },
    ),
    0,
  );
}

const calculatePlaneDamagePower = calculatePlaneSurfaceTargetPowerProxy;
const calculateBaseDamagePower = calculateBaseSurfaceTargetPowerProxy;

/** Returns attack parameters for the equipment type in LBAS mode. */
function attackParameters(plane, target = null) {
  const equipType = Number(plane.equipType) || 0;
  const improvement = Math.max(0, Number(plane.improvement) || 0);

  if (equipType === 47 || equipType === 53) {
    const coefficient = Number(plane.masterId) === 484 ? 0.75 : 0.7;
    const improvementBonus = coefficient * Math.sqrt(improvement);
    const targetTerms = landAttackerTargetTerms(plane, target, improvementBonus);
    return {
      stat: targetTerms.stat,
      typeMultiplier: 0.8,
      slotAdjustment: 1.8,
      airstrikeModifier: equipType === 47 ? 20 : 25,
      postCapMultiplier: equipType === 47 ? 1.8 : 1,
      preCapMultiplier: targetTerms.preCapMultiplier,
    };
  }

  if (equipType === 8) {
    return defaultAttackParameters(
      Math.max(0, Number(plane.torpedo) || 0) + improvement * 0.2,
    );
  }

  if (equipType === 7 || equipType === 11) {
    const improvementBonus = equipType === 11 || !hasCapability(plane, 'isBakusen')
      ? improvement * 0.2
      : 0;
    return defaultAttackParameters(Math.max(0, Number(plane.bombing) || 0) + improvementBonus);
  }

  if (equipType === 26) {
    const stat = Number(plane.masterId) === 491 && targetType(target) === SHIP_TYPES.DD
      ? 30
      : Math.max(0, Number(plane.bombing) || 0);
    return defaultAttackParameters(stat);
  }

  if (equipType === 57) {
    return {
      ...defaultAttackParameters(Math.max(0, Number(plane.bombing) || 0)),
      slotAdjustment: 1,
    };
  }

  return defaultAttackParameters(antiShipAttackStat(plane));
}

/** Returns the common LBAS attack parameters for ordinary aircraft. */
function defaultAttackParameters(stat) {
  return {
    stat,
    typeMultiplier: 1,
    slotAdjustment: 1.8,
    airstrikeModifier: 25,
    postCapMultiplier: 1,
    preCapMultiplier: 1,
  };
}

/** Resolves rules shared by the locked noro6 and KC3 reference revisions. */
function landAttackerTargetTerms(plane, target, improvementBonus) {
  const masterId = Number(plane.masterId) || 0;
  const type = targetType(target);
  const land = isLandTarget(target);
  const rawStat = Math.max(0, Number(land ? plane.bombing : plane.torpedo) || 0);
  let stat = rawStat + improvementBonus;
  let preCapMultiplier = 1;

  if (masterId === 459) {
    preCapMultiplier = b25TargetMultiplier(type, land);
  }
  if (land) return { stat, preCapMultiplier };

  if (masterId === 224 && type === SHIP_TYPES.DD) {
    stat = 25 + improvementBonus;
  } else if (masterId === 405 && type === SHIP_TYPES.DD) {
    stat = rawStat * 1.1 + improvementBonus;
  } else if (masterId === 406 && BATTLESHIP_TYPES.has(type)) {
    stat = rawStat * 1.5 + improvementBonus;
  } else if (masterId === 444) {
    stat = rawStat * guidedTypeAMultiplier(type) + improvementBonus;
  } else if (masterId === 562 && type === SHIP_TYPES.DD) {
    stat = rawStat * 1.25 + improvementBonus;
  }

  return { stat, preCapMultiplier };
}

/** Returns the B-25 target-class pre-cap multiplier. */
function b25TargetMultiplier(type, land) {
  if (land) return 0.9;
  if (type === SHIP_TYPES.DD) return 1.9;
  if ([SHIP_TYPES.CL, SHIP_TYPES.CLT, SHIP_TYPES.CT, SHIP_TYPES.AV].includes(type)) return 1.75;
  if ([SHIP_TYPES.CA, SHIP_TYPES.CAV].includes(type)) return 1.6;
  if (type === SHIP_TYPES.CVL || BATTLESHIP_TYPES.has(type) ||
      type === SHIP_TYPES.AO || type === SHIP_TYPES.AO_2) return 1.3;
  return 1;
}

/** Returns the guided Type-A target-class attack-stat multiplier. */
function guidedTypeAMultiplier(type) {
  if ([SHIP_TYPES.DD, SHIP_TYPES.CL, SHIP_TYPES.CLT, SHIP_TYPES.CA, SHIP_TYPES.CAV]
    .includes(type)) return 1.15;
  if ([SHIP_TYPES.CVL, SHIP_TYPES.CV, SHIP_TYPES.CVB].includes(type) ||
      BATTLESHIP_TYPES.has(type)) return 1.13;
  return 1;
}

/** Reads one normalized or API enemy ship type. */
function targetType(target) {
  const type = Number(target?.type ?? target?.typeId);
  return Number.isFinite(type) ? type : 0;
}

/** Identifies explicit installations and zero-speed land targets. */
function isLandTarget(target) {
  return target?.isLand === true ||
    target?.isInstallation === true ||
    (target?.speed != null && Number(target.speed) === 0);
}

/** Identifies explicit and API-type submarine targets. */
function isSubmarineTarget(target) {
  return target?.isSubmarine === true || [13, 14].includes(targetType(target));
}

/** Resolves one high/low special-enemy branch from a deterministic coordinate. */
function randomizedPostCapMultiplier(profile, roll) {
  return unitRoll(roll) < profile.probability
    ? profile.highMultiplier
    : profile.lowMultiplier;
}

/** Identifies dive bombers for explicit ordinary-target weakness metadata. */
function isDiveBomber(plane) {
  return plane?.isDiveBomber === true || [7, 11, 26, 57].includes(Number(plane?.equipType));
}

/** Normalizes optional positive weakness multipliers to one. */
function positiveMultiplier(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

/** Resolves explicit zero-valued current slots before using the plane default. */
function currentSlotForPlane(plane, options) {
  const value = (
    options.currentSlot ??
    options.slotSize ??
    plane.currentSlot ??
    plane.slotSize ??
    defaultSlotSizeForPlane(plane)
  );
  return Math.max(0, finiteNumber(value, 0));
}

/** Applies the square-root soft cap used by kc-web. */
function softCap(power, cap) {
  return Math.floor(power > cap ? cap + Math.sqrt(power - cap) : power);
}

/** Returns the stronger raw anti-ship stat for compatibility fixtures. */
function antiShipAttackStat(plane) {
  return Math.max(Number(plane.torpedo) || 0, Number(plane.bombing) || 0);
}

/** Returns the strongest land-recon damage coefficient in a loadout. */
function landBasedReconDamageModifier(loadout) {
  return loadout.reduce((best, plane) => {
    const modifier = LAND_BASED_RECON_DAMAGE_COEFFICIENTS.get(Number(plane.masterId)) || 1;
    return Math.max(best, modifier);
  }, 1);
}

/** Checks attack capability without consulting the compatibility role field. */
function isAttacker(plane) {
  return hasCapability(plane, 'canAttackSurface') || hasCapability(plane, 'isAttacker');
}

/** Checks an explicit capability or derives it from API equipment data. */
function hasCapability(plane, capability) {
  return plane?.[capability] === true || capabilitiesFor(plane)[capability] === true;
}

/** Converts a finite numeric input or returns the supplied fallback. */
function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Clamps one deterministic formula draw to the unit interval. */
function unitRoll(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

module.exports = {
  TARGET_POWER_FORMULA,
  calculateBaseDamagePower,
  calculateBaseSurfaceTargetPowerProxy,
  calculatePlaneDamagePower,
  calculatePlaneSurfaceTargetPowerProxy,
  calculatePlaneTargetAttackPower,
  landBasedReconDamageModifier,
};
