'use strict';

const AIR_STATES = {
  loss: { key: 'loss', label: 'Loss', rank: 0 },
  denial: { key: 'denial', label: 'Denial', rank: 1 },
  parity: { key: 'parity', label: 'Parity', rank: 2 },
  superiority: { key: 'superiority', label: 'Superiority', rank: 3 },
  supremacy: { key: 'supremacy', label: 'Supremacy', rank: 4 },
};

const FIGHTER_PROFICIENCY_BONUS = [0, 0, 2, 5, 9, 14, 14, 22];
const SEAPLANE_BOMBER_PROFICIENCY_BONUS = [0, 0, 1, 1, 1, 3, 3, 6];
const INTERNAL_PROFICIENCY_BONUS = [0, 1, 2.5, 4, 5.5, 7, 8.5, 12];
const RECON_COEFFICIENTS = new Map([
  [311, 1.15],
  [312, 1.18],
]);
const EXTENDER_MASTER_IDS = new Set([138, 178, 311, 312]);
const DEFAULT_LBAS_SLOT_SIZE = 18;
const RECON_SLOT_SIZE = 4;

function airStateFor(airPower, enemyAir) {
  const enemy = Math.max(0, Number(enemyAir) || 0);
  const value = Math.max(0, Math.floor(Number(airPower) || 0));

  if (enemy === 0) {
    return { ...AIR_STATES.supremacy, threshold: 0, margin: value };
  }
  if (value >= requiredAirForState(enemy, 'supremacy')) {
    return {
      ...AIR_STATES.supremacy,
      threshold: requiredAirForState(enemy, 'supremacy'),
      margin: value - requiredAirForState(enemy, 'supremacy'),
    };
  }
  if (value >= requiredAirForState(enemy, 'superiority')) {
    return {
      ...AIR_STATES.superiority,
      threshold: requiredAirForState(enemy, 'superiority'),
      margin: value - requiredAirForState(enemy, 'superiority'),
    };
  }
  if (value >= requiredAirForState(enemy, 'parity')) {
    return {
      ...AIR_STATES.parity,
      threshold: requiredAirForState(enemy, 'parity'),
      margin: value - requiredAirForState(enemy, 'parity'),
    };
  }
  if (value >= requiredAirForState(enemy, 'denial')) {
    return {
      ...AIR_STATES.denial,
      threshold: requiredAirForState(enemy, 'denial'),
      margin: value - requiredAirForState(enemy, 'denial'),
    };
  }
  return { ...AIR_STATES.loss, threshold: 0, margin: value };
}

function requiredAirForState(enemyAir, stateKey) {
  const enemy = Math.max(0, Number(enemyAir) || 0);

  if (enemy === 0) {
    return 0;
  }
  switch (stateKey) {
    case 'supremacy':
      return enemy * 3;
    case 'superiority':
      return Math.ceil(enemy * 1.5);
    case 'parity':
      return Math.floor(enemy / 1.5) + 1;
    case 'denial':
      return Math.floor(enemy / 3) + 1;
    case 'loss':
      return 0;
    default:
      throw new Error(`Unknown air state: ${stateKey}`);
  }
}

function calculateSlotAirPower(plane, slotSize) {
  const size = Math.max(0, Number(plane.slotSize ?? slotSize ?? defaultSlotSizeForPlane(plane)) || 0);
  const antiAir = Math.max(0, Number(plane.antiAir) || 0);
  const intercept = Math.max(0, Number(plane.intercept) || 0);
  const sortieAntiAir = antiAir + intercept * 1.5;
  const improvedAntiAir = sortieAntiAir + improvementBonus(plane);
  const proficiencyBonus = proficiencyBonusForPlane(plane);

  return Math.floor(improvedAntiAir * Math.sqrt(size) + proficiencyBonus);
}

function calculateBaseAirPower(loadout, slotSize) {
  const rawAirPower = loadout.reduce(
    (total, plane) => total + calculateSlotAirPower(plane, slotSize),
    0,
  );
  return Math.floor(rawAirPower * landReconCoefficient(loadout));
}

function calculateEffectiveRadius(loadout) {
  if (!loadout.length) {
    return 0;
  }

  const combatPlanes = loadout.filter((plane) => !isRangeExtender(plane));
  const radiusSource = combatPlanes.length > 0 ? combatPlanes : loadout;
  const naturalRadius = Math.min(...radiusSource.map((plane) => plane.radius || 0));
  const extenderRadius = Math.max(
    0,
    ...loadout.filter(isRangeExtender).map((plane) => plane.radius || 0),
  );

  if (extenderRadius <= naturalRadius) {
    return naturalRadius;
  }

  const extension = Math.min(
    3,
    Math.max(0, Math.round(Math.sqrt(extenderRadius - naturalRadius))),
  );
  return naturalRadius + extension;
}

function improvementBonus(plane) {
  const level = Math.max(0, Number(plane.improvement) || 0);

  if (isFighterLike(plane)) {
    return level * 0.2;
  }
  if (plane.role === 'attacker' || plane.role === 'bomber') {
    return Math.sqrt(level) * 0.5;
  }
  return 0;
}

function proficiencyBonusForPlane(plane) {
  const level = Math.max(0, Math.min(7, Number(plane.proficiency) || 0));
  const internalBonus = Math.sqrt(INTERNAL_PROFICIENCY_BONUS[level]);
  let visibleBonus = 0;

  if (isFighterLike(plane)) {
    visibleBonus = FIGHTER_PROFICIENCY_BONUS[level];
  } else if (plane.role === 'seaplaneBomber') {
    visibleBonus = SEAPLANE_BOMBER_PROFICIENCY_BONUS[level];
  }
  return visibleBonus + internalBonus;
}

function landReconCoefficient(loadout) {
  return loadout.reduce((best, plane) => {
    const coefficient = RECON_COEFFICIENTS.get(plane.masterId) || 1;
    return Math.max(best, coefficient);
  }, 1);
}

function isFighterLike(plane) {
  return (
    plane.role === 'fighter' ||
    plane.role === 'landFighter' ||
    plane.role === 'interceptor' ||
    plane.role === 'seaplaneFighter'
  );
}

function isRangeExtender(plane) {
  return plane.role === 'recon' || plane.role === 'extender' || EXTENDER_MASTER_IDS.has(plane.masterId);
}

function defaultSlotSizeForPlane(plane) {
  return isRangeExtender(plane) ? RECON_SLOT_SIZE : DEFAULT_LBAS_SLOT_SIZE;
}

module.exports = {
  AIR_STATES,
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  calculateSlotAirPower,
  defaultSlotSizeForPlane,
  isRangeExtender,
  requiredAirForState,
};
