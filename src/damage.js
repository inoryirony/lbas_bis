'use strict';

const DEFAULT_LBAS_SLOT_SIZE = 18;
const DAMAGE_CAP = 220;
const LAND_BASED_RECON_DAMAGE_COEFFICIENTS = new Map([
  [311, 1.125],
  [312, 1.15],
]);

function calculatePlaneDamagePower(plane, options = {}) {
  if (plane.role !== 'attacker') {
    return 0;
  }

  const stat = antiShipAttackStat(plane);
  if (stat <= 0) {
    return 0;
  }

  const slotSize = Number(options.slotSize) || DEFAULT_LBAS_SLOT_SIZE;
  const reconModifier = Number(options.reconModifier) || 1;
  const rawPower = stat * Math.sqrt(1.8 * slotSize) + 25;

  if (plane.isLandBased) {
    return Math.min(DAMAGE_CAP, Math.floor(Math.floor(rawPower * 0.8) * 1.8 * reconModifier));
  }

  return Math.min(DAMAGE_CAP, Math.floor(Math.floor(rawPower) * reconModifier));
}

function calculateBaseDamagePower(loadout, options = {}) {
  const reconModifier = Number(options.reconModifier) || landBasedReconDamageModifier(loadout);
  return loadout.reduce(
    (total, plane) => total + calculatePlaneDamagePower(plane, { ...options, reconModifier }),
    0,
  );
}

function antiShipAttackStat(plane) {
  return Number(plane.torpedo) || Number(plane.bombing) || 0;
}

function landBasedReconDamageModifier(loadout) {
  return loadout.reduce((best, plane) => {
    const modifier = LAND_BASED_RECON_DAMAGE_COEFFICIENTS.get(plane.masterId) || 1;
    return Math.max(best, modifier);
  }, 1);
}

module.exports = {
  calculateBaseDamagePower,
  calculatePlaneDamagePower,
  landBasedReconDamageModifier,
};
