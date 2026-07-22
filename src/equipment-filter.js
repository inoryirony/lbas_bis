'use strict';

const CARRIER_AIRCRAFT_TYPES = new Set([6, 7, 8, 9, 56, 57]);
const DEFAULT_BLACKLIST_NAMES = new Set([
  '九六式艦戦',
  '九七式艦攻',
  '九九式艦爆',
  '零式艦戦21型',
  '零式艦戦52型',
  '零式水上偵察機',
  '九六式陸攻',
  '一式戦 隼II型',
]);

/** Filters candidates before grouping while preserving every explicitly locked instance. */
function filterOptimizationEquipment(equipment = [], options = {}) {
  const excludedMasterIds = new Set(
    (options.blacklistedMasterIds || []).map(Number).filter(Number.isFinite),
  );
  const lockedInstanceIds = new Set(
    (options.lockedInstanceIds || []).map((value) => String(value)),
  );
  return equipment.filter((plane) => {
    if (lockedInstanceIds.has(String(plane.instanceId))) return true;
    if (excludedMasterIds.has(Number(plane.masterId))) return false;
    return options.excludeCarrierAircraft !== true || !isCarrierAircraft(plane);
  });
}

/** Resolves the editable initial blacklist against the current master equipment data. */
function defaultBlacklistedMasterIds(equipment = []) {
  return [...new Set(equipment
    .filter((plane) => DEFAULT_BLACKLIST_NAMES.has(String(plane.name || '').trim()))
    .map((plane) => Number(plane.masterId))
    .filter(Number.isFinite))]
    .sort((left, right) => left - right);
}

/** Returns one display record per aircraft master for blacklist selection. */
function uniqueEquipmentMasters(equipment = []) {
  const byMasterId = new Map();
  equipment.forEach((plane) => {
    const masterId = Number(plane.masterId);
    if (!Number.isFinite(masterId) || byMasterId.has(masterId)) return;
    byMasterId.set(masterId, {
      masterId,
      name: plane.name || `#${masterId}`,
      equipType: Number(plane.equipType) || 0,
      isLandBased: plane.isLandBased === true,
    });
  });
  return [...byMasterId.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'ja') || left.masterId - right.masterId);
}

function isCarrierAircraft(plane) {
  return CARRIER_AIRCRAFT_TYPES.has(Number(plane.equipType));
}

module.exports = {
  CARRIER_AIRCRAFT_TYPES,
  DEFAULT_BLACKLIST_NAMES,
  defaultBlacklistedMasterIds,
  filterOptimizationEquipment,
  isCarrierAircraft,
  uniqueEquipmentMasters,
};
