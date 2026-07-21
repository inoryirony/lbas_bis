'use strict';

const { capabilitiesFor } = require('./aircraft');
const { defaultSlotSizeForPlane } = require('./air-power');

const DAMAGE_CAP = 220;
const LAND_BASED_RECON_DAMAGE_COEFFICIENTS = new Map([
  [311, 1.12],
  [312, 1.15],
  [480, 1.12],
]);

/** Estimates normal-target LBAS anti-ship power for one attacking plane. */
function calculatePlaneDamagePower(plane, options = {}) {
  if (!isAttacker(plane)) {
    return 0;
  }

  const slotSize = currentSlotForPlane(plane, options);
  if (slotSize <= 0) {
    return 0;
  }

  const attack = attackParameters(plane);
  if (attack.stat <= 0) {
    return 0;
  }

  const reconModifier = finiteNumber(options.reconModifier ?? 1, 1);
  const basePower = (
    attack.typeMultiplier * attack.stat * Math.sqrt(attack.slotAdjustment * slotSize) +
    attack.airstrikeModifier
  );
  const preCapPower = basePower * reconModifier;
  const postCapPower = softCap(preCapPower, DAMAGE_CAP);

  return Math.floor(postCapPower * attack.postCapMultiplier);
}

/** Sums plane damage using the strongest land-recon damage modifier. */
function calculateBaseDamagePower(loadout, options = {}) {
  const reconModifier = options.reconModifier ?? landBasedReconDamageModifier(loadout);
  return loadout.reduce(
    (total, plane) => total + calculatePlaneDamagePower(plane, { ...options, reconModifier }),
    0,
  );
}

/** Returns attack parameters for the equipment type in LBAS mode. */
function attackParameters(plane) {
  const equipType = Number(plane.equipType) || 0;
  const improvement = Math.max(0, Number(plane.improvement) || 0);

  if (equipType === 47 || equipType === 53) {
    const coefficient = Number(plane.masterId) === 484 ? 0.75 : 0.7;
    return {
      stat: Math.max(0, Number(plane.torpedo) || 0) + coefficient * Math.sqrt(improvement),
      typeMultiplier: 0.8,
      slotAdjustment: 1.8,
      airstrikeModifier: equipType === 47 ? 20 : 25,
      postCapMultiplier: equipType === 47 ? 1.8 : 1,
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
    return defaultAttackParameters(Math.max(0, Number(plane.bombing) || 0));
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
  };
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
  return hasCapability(plane, 'isAttacker');
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

module.exports = {
  calculateBaseDamagePower,
  calculatePlaneDamagePower,
  landBasedReconDamageModifier,
};
