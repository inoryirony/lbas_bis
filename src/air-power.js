'use strict';

const { capabilitiesFor } = require('./aircraft');

const AIR_STATES = {
  none: { key: 'none', label: 'None', rank: -1 },
  loss: { key: 'loss', label: 'Loss', rank: 0 },
  denial: { key: 'denial', label: 'Denial', rank: 1 },
  parity: { key: 'parity', label: 'Parity', rank: 2 },
  superiority: { key: 'superiority', label: 'Superiority', rank: 3 },
  supremacy: { key: 'supremacy', label: 'Supremacy', rank: 4 },
};

const INTERNAL_PROFICIENCY_BORDERS = [0, 10, 25, 40, 55, 70, 85, 100, 121];
const DEFAULT_LBAS_SLOT_SIZE = 18;
const HEAVY_LAND_ATTACKER_SLOT_SIZE = 9;
const RECON_SLOT_SIZE = 4;

/** Classifies the air state at the KanColle threshold borders. */
function airStateFor(airPower, enemyAir, hasPlane = true) {
  const enemy = Math.max(0, Number(enemyAir) || 0);
  const value = Math.max(0, Math.floor(Number(airPower) || 0));

  if (enemy === 0 && value === 0 && !hasPlane) {
    return { ...AIR_STATES.none, threshold: 0, margin: 0 };
  }
  if (enemy === 0) {
    return { ...AIR_STATES.supremacy, threshold: 0, margin: value };
  }
  if (value >= requiredAirForState(enemy, 'supremacy')) {
    return stateResult(AIR_STATES.supremacy, value, requiredAirForState(enemy, 'supremacy'));
  }
  if (value >= requiredAirForState(enemy, 'superiority')) {
    return stateResult(AIR_STATES.superiority, value, requiredAirForState(enemy, 'superiority'));
  }
  if (value >= requiredAirForState(enemy, 'parity')) {
    return stateResult(AIR_STATES.parity, value, requiredAirForState(enemy, 'parity'));
  }
  if (value >= requiredAirForState(enemy, 'denial')) {
    return stateResult(AIR_STATES.denial, value, requiredAirForState(enemy, 'denial'));
  }
  return { ...AIR_STATES.loss, threshold: 0, margin: value };
}

/** Adds threshold and margin data to an air-state descriptor. */
function stateResult(state, value, threshold) {
  return { ...state, threshold, margin: value - threshold };
}

/** Returns the minimum player air power for a requested state. */
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
    case 'none':
      return 0;
    default:
      throw new Error(`Unknown air state: ${stateKey}`);
  }
}

/** Converts visible proficiency into its possible internal range. */
function internalProficiencyBounds(visibleProficiency) {
  const visible = Math.max(0, Math.min(7, Math.trunc(Number(visibleProficiency) || 0)));
  return {
    lower: INTERNAL_PROFICIENCY_BORDERS[visible],
    upper: INTERNAL_PROFICIENCY_BORDERS[visible + 1] - 1,
  };
}

/** Calculates slot air power using exact internal proficiency or its lower bound. */
function calculateSlotAirPower(plane, slotSize) {
  return calculateSlotAirPowerBounds(plane, slotSize).lower;
}

/** Calculates lower and upper slot air power for the known proficiency data. */
function calculateSlotAirPowerBounds(plane, slotSize) {
  const bounds = proficiencyBoundsForPlane(plane);
  return {
    lower: calculateSlotAirPowerAtProficiency(plane, slotSize, bounds.lower),
    upper: calculateSlotAirPowerAtProficiency(plane, slotSize, bounds.upper),
  };
}

/** Returns an exact internal proficiency or the range implied by visible proficiency. */
function proficiencyBoundsForPlane(plane) {
  if (plane.internalProficiency != null) {
    const value = Math.max(0, Math.min(120, Number(plane.internalProficiency) || 0));
    return { lower: value, upper: value };
  }
  return internalProficiencyBounds(plane.proficiency);
}

/** Calculates one slot's air power at an exact internal proficiency value. */
function calculateSlotAirPowerAtProficiency(plane, slotSize, internalProficiency) {
  const size = Math.max(0, Number(plane.slotSize ?? slotSize ?? defaultSlotSizeForPlane(plane)) || 0);
  if (size === 0) {
    return 0;
  }

  const antiAir = Math.max(0, Number(plane.antiAir) || 0);
  const intercept = Math.max(0, Number(plane.intercept) || 0);
  const sortieAntiAir = antiAir + intercept * 1.5;
  const improvedAntiAir = sortieAntiAir + improvementBonus(plane);
  const proficiencyBonus = proficiencyBonusForPlane(plane, internalProficiency);

  return Math.floor(improvedAntiAir * Math.sqrt(size) + proficiencyBonus);
}

/** Calculates total base air power including the best land-recon coefficient. */
function calculateBaseAirPower(loadout, slotSize) {
  const rawAirPower = loadout.reduce(
    (total, plane) => total + calculateSlotAirPower(plane, slotSize),
    0,
  );
  return Math.floor(rawAirPower * landReconCoefficient(loadout));
}

/** Calculates range from every plane and applies only valid recon extension. */
function calculateEffectiveRadius(loadout) {
  const planes = loadout.filter(Boolean);
  if (!planes.length) {
    return 0;
  }

  const naturalRadius = Math.min(...planes.map((plane) => Number(plane.radius) || 0));
  if (planes.some((plane) => hasCapability(plane, 'blocksRangeExtension'))) {
    return naturalRadius;
  }

  const reconRadius = Math.max(
    0,
    ...planes
      .filter((plane) => hasCapability(plane, 'isRecon'))
      .map((plane) => Number(plane.radius) || 0),
  );
  if (reconRadius <= naturalRadius) {
    return naturalRadius;
  }

  return Math.round(naturalRadius + Math.min(Math.sqrt(reconRadius - naturalRadius), 3));
}

/** Returns the kc-web anti-air improvement bonus for an aircraft. */
function improvementBonus(plane) {
  const level = Math.max(0, Number(plane.improvement) || 0);
  const masterId = Number(plane.masterId) || 0;
  const equipType = Number(plane.equipType) || 0;

  if (masterId === 486 || masterId === 487) {
    return level * 0.3;
  }
  if (hasCapability(plane, 'isFighter')) {
    return level * 0.2;
  }
  if (equipType === 7 && hasCapability(plane, 'isBakusen')) {
    return level * 0.25;
  }
  if (hasCapability(plane, 'isLandAttacker')) {
    return Math.sqrt(level) * 0.5;
  }
  if (equipType === 49) {
    return level * 0.2;
  }
  if (equipType === 41) {
    return level * 0.15;
  }
  return 0;
}

/** Returns the fixed and internal proficiency air-power bonus. */
function proficiencyBonusForPlane(plane, internalProficiency) {
  const level = Math.max(0, Math.min(120, Number(internalProficiency) || 0));
  const equipType = Number(plane.equipType) || 0;
  const isAswPatrol = hasCapability(plane, 'isAswPatrol');

  if (isAswPatrol && !(Number(plane.antiAir) || 0)) {
    return 0;
  }

  let fixedBonus = 0;
  if (hasCapability(plane, 'isFighter') || isAswPatrol) {
    fixedBonus = fighterProficiencyBonus(level);
  } else if (equipType === 11) {
    fixedBonus = seaplaneBomberProficiencyBonus(level);
  }
  return fixedBonus + Math.sqrt(level / 10);
}

/** Returns the fixed fighter or ASW-patrol bonus for internal proficiency. */
function fighterProficiencyBonus(level) {
  if (level >= 100) return 22;
  if (level >= 70) return 14;
  if (level >= 55) return 9;
  if (level >= 40) return 5;
  if (level >= 25) return 2;
  return 0;
}

/** Returns the fixed seaplane-bomber bonus for internal proficiency. */
function seaplaneBomberProficiencyBonus(level) {
  if (level >= 100) return 6;
  if (level >= 70) return 3;
  if (level >= 25) return 1;
  return 0;
}

/** Returns the strongest sortie air-power coefficient from land recon. */
function landReconCoefficient(loadout) {
  return loadout.reduce((best, plane) => {
    if (!hasCapability(plane, 'isLandRecon')) {
      return best;
    }
    const scout = Number(plane.scout) || 0;
    const coefficient = scout === 9 ? 1.18 : scout === 8 ? 1.15 : 1;
    return Math.max(best, coefficient);
  }, 1);
}

/** Checks an explicit capability or derives it from API equipment data. */
function hasCapability(plane, capability) {
  return plane?.[capability] === true || capabilitiesFor(plane)[capability] === true;
}

/** Reports whether a plane can extend LBAS range. */
function isRangeExtender(plane) {
  return hasCapability(plane, 'isRecon');
}

/** Returns the default LBAS slot size for an aircraft capability set. */
function defaultSlotSizeForPlane(plane) {
  if (hasCapability(plane, 'isHeavyLandAttacker')) {
    return HEAVY_LAND_ATTACKER_SLOT_SIZE;
  }
  if (hasCapability(plane, 'isRecon')) {
    return RECON_SLOT_SIZE;
  }
  return DEFAULT_LBAS_SLOT_SIZE;
}

module.exports = {
  AIR_STATES,
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  calculateSlotAirPower,
  calculateSlotAirPowerBounds,
  defaultSlotSizeForPlane,
  internalProficiencyBounds,
  isRangeExtender,
  requiredAirForState,
};
