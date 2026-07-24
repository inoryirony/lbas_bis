'use strict';

const PLANE_TYPES = new Set([6, 7, 8, 9, 10, 11, 25, 26, 41, 45, 47, 48, 49, 53, 56, 57, 94]);
const FIGHTER_TYPES = new Set([6, 45, 48, 56]);
const ATTACKER_TYPES = new Set([7, 8, 11, 47, 53, 57]);
const RECON_TYPES = new Set([9, 10, 41, 49, 94]);
const CONTACT_TYPES = new Set([8, 9, 10, 41, 49, 94]);
const LAND_ATTACKER_TYPES = new Set([47, 53]);
const ASW_PATROL_TYPES = new Set([25, 26]);
const BAKUSEN_MASTER_IDS = new Set([60, 154, 219, 447, 487]);

/** Derives independent aircraft capabilities from master equipment data. */
function capabilitiesFor(plane = {}) {
  const masterId = Number(plane.masterId) || 0;
  const equipType = Number(plane.equipType) || 0;
  const iconType = Number(plane.iconType) || 0;
  const bombing = Number(plane.bombing) || 0;
  const asw = Number(plane.asw) || 0;
  const isAutoGyro = equipType === 25;
  const isAswPatrol = ASW_PATROL_TYPES.has(equipType);
  const isAswBomber1 = equipType === 26 && bombing >= 4;
  const isAswBomber2 = equipType === 26 && bombing > 0 && bombing < 4;
  const isPlane = PLANE_TYPES.has(equipType);
  const canAttackSurface = ATTACKER_TYPES.has(equipType) ||
    (isAswPatrol && bombing > 0);
  const canAttackSubmarine = isPlane && asw >= 7;

  return {
    isPlane,
    isFighter: FIGHTER_TYPES.has(equipType),
    isAttacker: canAttackSurface,
    canAttackSurface,
    canAttackSubmarine,
    isLbasCombatAttacker: canAttackSurface || canAttackSubmarine,
    isLandAttacker: LAND_ATTACKER_TYPES.has(equipType),
    isHeavyLandAttacker: equipType === 53,
    isRecon: RECON_TYPES.has(equipType),
    isLandRecon: equipType === 49,
    canContact: CONTACT_TYPES.has(equipType),
    isBakusen: BAKUSEN_MASTER_IDS.has(masterId),
    isAutoGyro,
    isAswPatrol,
    isAswBomber1,
    isAswBomber2,
    blocksRangeExtension: isAswPatrol && !isAswBomber1 && !isAswBomber2,
    isJet: iconType === 60 || equipType === 57,
    isHeavyJet: iconType === 59,
  };
}

/** Returns a plane copy decorated with master-derived capabilities. */
function applyAircraftCapabilities(plane) {
  return {
    ...plane,
    ...capabilitiesFor(plane),
  };
}

/** Builds a stable grouping key from every property that affects search results. */
function aircraftEquivalenceKey(plane) {
  const derived = capabilitiesFor(plane);
  const normalized = {
    ...plane,
    ...derived,
  };
  Object.keys(derived).forEach((capability) => {
    normalized[capability] = plane?.[capability] === true || derived[capability] === true;
  });
  normalized.canAttackSurface = normalized.canAttackSurface || normalized.isAttacker;
  normalized.isLbasCombatAttacker = normalized.isLbasCombatAttacker ||
    normalized.canAttackSurface || normalized.canAttackSubmarine;
  return JSON.stringify([
    normalized.masterId,
    normalized.equipType,
    normalized.iconType,
    normalized.antiAir,
    normalized.intercept,
    normalized.antiBomber,
    normalized.radius,
    normalized.torpedo,
    normalized.bombing,
    normalized.asw,
    normalized.scout,
    normalized.accuracy,
    normalized.improvement,
    normalized.proficiency,
    internalProficiencyKey(normalized.internalProficiency),
    Number(normalized.cost) || 0,
    Number(normalized.shootDownAvoidance) || 0,
    normalized.isEscortItem === true,
    slotSizeKey(normalized.slotSize),
    currentSlotKey(normalized.currentSlot),
    normalized.isLandBased,
    normalized.role,
    normalized.available,
    normalized.missing,
    normalized.isPlane,
    normalized.isFighter,
    normalized.isAttacker,
    normalized.canAttackSurface,
    normalized.canAttackSubmarine,
    normalized.isLbasCombatAttacker,
    normalized.isLandAttacker,
    normalized.isHeavyLandAttacker,
    normalized.isRecon,
    normalized.isLandRecon,
    normalized.canContact,
    normalized.isBakusen,
    normalized.isAutoGyro,
    normalized.isAswPatrol,
    normalized.isAswBomber1,
    normalized.isAswBomber2,
    normalized.blocksRangeExtension,
    normalized.isJet,
    normalized.isHeavyJet,
  ]);
}

/** Canonicalizes exact proficiency while preserving the visible-only fallback. */
function internalProficiencyKey(value) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) {
    return 'unknown';
  }
  return Math.max(0, Math.min(120, number));
}

/** Canonicalizes slot size according to the air-power and damage formulas. */
function slotSizeKey(value) {
  if (value == null) {
    return 'missing';
  }
  const number = Number(value);
  return number === Number.POSITIVE_INFINITY ? 'infinity' : Math.max(0, number || 0);
}

/** Canonicalizes current slot according to the damage formula. */
function currentSlotKey(value) {
  if (value == null) {
    return 'missing';
  }
  const number = Number(value);
  return Math.max(0, Number.isFinite(number) ? number : 0);
}

module.exports = {
  ASW_PATROL_TYPES,
  ATTACKER_TYPES,
  BAKUSEN_MASTER_IDS,
  CONTACT_TYPES,
  FIGHTER_TYPES,
  LAND_ATTACKER_TYPES,
  PLANE_TYPES,
  RECON_TYPES,
  aircraftEquivalenceKey,
  applyAircraftCapabilities,
  capabilitiesFor,
};
