'use strict';

const AVOIDANCE_CORRECTIONS = Object.freeze({
  0: Object.freeze({ weighted: 1, fleet: 1 }),
  1: Object.freeze({ weighted: 0.6, fleet: 1 }),
  2: Object.freeze({ weighted: 0.6, fleet: 0.7 }),
  3: Object.freeze({ weighted: 0.5, fleet: 0.7 }),
  4: Object.freeze({ weighted: 0.5, fleet: 0.5 }),
  5: Object.freeze({ weighted: 0.4, fleet: 0.4 }),
});

const FORMATION_CORRECTIONS = Object.freeze({
  1: 1,
  2: 1.2,
  3: 1.6,
  4: 1,
  5: 1,
  6: 1.1,
  11: 1,
  12: 1,
  13: 1.5,
  15: 1.1,
});

/** Builds the no-cut-in enemy Stage 2 table used against LBAS attackers. */
function buildEnemyStage2Defense(options = {}) {
  const enemyIds = Array.isArray(options.enemyIds) ? options.enemyIds : [];
  const enemiesById = options.enemiesById instanceof Map ? options.enemiesById : new Map();
  const itemsById = options.itemsById instanceof Map ? options.itemsById : new Map();
  const formation = Number(options.formation) || 1;
  const battleType = Number(options.battleType) || 0;
  const isUnion = battleType === 2;
  const isAirSupportedAsw = battleType === 8;
  const missing = [];
  const ships = enemyIds.flatMap((enemyId, index) => {
    const enemy = enemiesById.get(Number(enemyId));
    if (!enemy) {
      missing.push({ code: 'MISSING_STAGE2_ENEMY', enemyId: Number(enemyId), shipIndex: index });
      return [];
    }
    if (isAirSupportedAsw && !isSubmarine(enemy)) return [];
    const items = (enemy.items || []).flatMap((itemId) => {
      const id = Number(itemId);
      if (!(id > 0)) return [];
      const item = itemsById.get(id);
      if (!item) {
        missing.push({ code: 'MISSING_STAGE2_ITEM', enemyId: Number(enemyId), itemId: id });
        return [];
      }
      return [item];
    });
    return [{
      enemyId: Number(enemyId),
      shipIndex: index,
      isEscort: isUnion && index >= 6,
      bareAntiAir: nonNegative(enemy.aa ?? enemy.antiAir),
      itemAntiAir: items.reduce((total, item) => total + nonNegative(item.antiAir), 0),
      weightedEquipmentAntiAir: items.reduce(
        (total, item) => total + weightedEquipmentAntiAir(item),
        0,
      ),
      fleetAntiAirBonus: Math.floor(items.reduce(
        (total, item) => total + fleetAntiAirBonus(item),
        0,
      )),
    }];
  });

  if (!ships.length || missing.length) {
    return {
      modeled: false,
      source: options.source || 'noro6',
      formation,
      isUnion,
      missing,
      byAvoidance: {},
    };
  }

  const formationCorrection = FORMATION_CORRECTIONS[formation] ?? 1;
  const fleetAntiAirBonusTotal = Math.floor(
    ships.reduce((total, ship) => total + ship.fleetAntiAirBonus, 0),
  );
  const rawFleetAntiAir = fleetAntiAirBonusTotal * formationCorrection;
  const baseFleetAntiAir = Math.floor(rawFleetAntiAir);
  const byAvoidance = {};
  Object.entries(AVOIDANCE_CORRECTIONS).forEach(([avoidance, correction]) => {
    const fleetAntiAir = Math.floor(baseFleetAntiAir * correction.fleet);
    byAvoidance[avoidance] = {
      rateFactors: ships.map((ship) => {
        const weighted = correctedWeightedAntiAir(ship, correction.weighted);
        return 0.02 * 0.25 * weighted * unionFactor(ship, isUnion);
      }),
      fixedLosses: ships.map((ship) => {
        const weighted = correctedWeightedAntiAir(ship, correction.weighted);
        return Math.floor(
          (weighted + fleetAntiAir) * 0.25 * 0.75 * unionFactor(ship, isUnion),
        );
      }),
    };
  });

  return {
    modeled: true,
    source: options.source || 'noro6',
    formation,
    formationCorrection,
    isUnion,
    ships,
    rawFleetAntiAir,
    baseFleetAntiAir,
    missing: [],
    byAvoidance,
  };
}

/** Returns the requested avoidance table, conservatively falling back to no avoidance. */
function stageTwoShootdownStatus(defense, avoidance) {
  const tables = defense?.modeled === true ? defense.byAvoidance : null;
  return tables?.[String(normalizeAvoidance(avoidance))] || tables?.['0'] || {
    rateFactors: [],
    fixedLosses: [],
  };
}

function correctedWeightedAntiAir(ship, correction) {
  return Math.floor((
    Math.floor(Math.sqrt(ship.bareAntiAir + ship.itemAntiAir)) +
    ship.weightedEquipmentAntiAir
  ) * correction);
}

function weightedEquipmentAntiAir(item) {
  const antiAir = nonNegative(item.antiAir);
  const type = Number(item.type) || 0;
  const iconType = Number(item.itype) || 0;
  if (iconType === 16 || type === 36) return antiAir * 2;
  if (type === 21) return antiAir * 3;
  if (type === 12) return antiAir * 1.5;
  if (type === 13) return antiAir * 1.8;
  return 0;
}

function fleetAntiAirBonus(item) {
  const antiAir = nonNegative(item.antiAir);
  const id = Number(item.id) || 0;
  const type = Number(item.type) || 0;
  const iconType = Number(item.itype) || 0;
  if (iconType === 16 || type === 36) return antiAir * 0.35;
  if (type === 18) return antiAir * 0.6;
  if (iconType === 11) return antiAir * 0.4;
  if (id === 9) return antiAir * 0.25;
  return antiAir * 0.2;
}

function unionFactor(ship, isUnion) {
  if (!isUnion) return 1;
  return ship.isEscort ? 0.48 : 0.8;
}

function isSubmarine(enemy) {
  const type = Number(enemy?.type) || 0;
  return type === 13 || type === 14;
}

function normalizeAvoidance(value) {
  const number = Number(value);
  return Object.prototype.hasOwnProperty.call(AVOIDANCE_CORRECTIONS, number) ? number : 0;
}

function shootDownAvoidanceLabelKey(value) {
  return `shootDownAvoidance_${normalizeAvoidance(value)}`;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

module.exports = {
  AVOIDANCE_CORRECTIONS,
  FORMATION_CORRECTIONS,
  buildEnemyStage2Defense,
  shootDownAvoidanceLabelKey,
  stageTwoShootdownStatus,
};
