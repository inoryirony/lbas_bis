'use strict';

const {
  rankEquipmentMatches,
  sortEquipmentChoices,
} = require('./equipment-search');

const CARRIER_AIRCRAFT_TYPES = new Set([6, 7, 8, 9, 56, 57]);
const EQUIPMENT_TYPE_NAMES = Object.freeze({
  6: '舰上战斗机',
  7: '舰上轰炸机',
  8: '舰上攻击机',
  9: '舰上侦察机',
  10: '水上侦察机',
  11: '水上轰炸机',
  25: '自转旋翼机',
  26: '对潜哨戒机',
  41: '大型飞行艇',
  45: '水上战斗机',
  47: '陆上攻击机',
  48: '局地战斗机',
  49: '陆上侦察机',
  53: '大型陆上机',
  56: '喷气式战斗轰炸机',
  57: '喷气式战斗机',
});
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
  const excludedEquipTypes = new Set(
    (options.blacklistedEquipTypes || []).map(Number).filter(Number.isFinite),
  );
  const lockedInstanceIds = new Set(
    (options.lockedInstanceIds || []).map((value) => String(value)),
  );
  return equipment.filter((plane) => {
    if (lockedInstanceIds.has(String(plane.instanceId))) return true;
    return !isEquipmentExcluded(plane, {
      ...options,
      excludedMasterIds,
      excludedEquipTypes,
    });
  });
}

/** Checks whether an aircraft is unavailable for a new manual or optimized selection. */
function isEquipmentExcluded(plane, options = {}) {
  const excludedMasterIds = options.excludedMasterIds || new Set(
    (options.blacklistedMasterIds || []).map(Number).filter(Number.isFinite),
  );
  const excludedEquipTypes = options.excludedEquipTypes || new Set(
    (options.blacklistedEquipTypes || []).map(Number).filter(Number.isFinite),
  );
  return excludedMasterIds.has(Number(plane?.masterId)) ||
    excludedEquipTypes.has(Number(plane?.equipType)) ||
    (options.excludeCarrierAircraft === true && isCarrierAircraft(plane));
}

/** Builds allowed choices plus a disabled current item when it became blacklisted later. */
function buildEquipmentChoices(equipment = [], currentPlane = null, options = {}) {
  const unique = new Map();
  for (const plane of equipment) unique.set(String(plane.instanceId), plane);
  if (currentPlane) unique.set(String(currentPlane.instanceId), currentPlane);
  const choices = [...unique.values()]
    .map((plane) => ({
      ...plane,
      typeName: equipmentTypeName(plane.equipType),
      current: String(plane.instanceId) === String(currentPlane?.instanceId),
      disabled: isEquipmentExcluded(plane, options),
    }))
    .filter((plane) => !plane.disabled || plane.current);
  const allowed = sortEquipmentChoices(choices.filter((plane) => !plane.disabled));
  const currentBlocked = choices.filter((plane) => plane.disabled && plane.current);
  return [...allowed, ...currentBlocked];
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
      typeName: equipmentTypeName(plane.equipType),
      isLandBased: plane.isLandBased === true,
    });
  });
  return sortEquipmentChoices([...byMasterId.values()]);
}

/** Sorts blacklist choices and hides individual equipment covered by a whole-type blacklist. */
function filterBlacklistChoices(equipment = [], selectedEquipTypes = [], query = '') {
  const excludedTypes = new Set(selectedEquipTypes.map(Number));
  return rankEquipmentMatches(equipment, query)
    .filter((item) => !excludedTypes.has(Number(item.equipType)));
}

function isCarrierAircraft(plane) {
  return CARRIER_AIRCRAFT_TYPES.has(Number(plane.equipType));
}

function equipmentTypeName(equipType) {
  const normalized = Number(equipType) || 0;
  return EQUIPMENT_TYPE_NAMES[normalized] || `装备种类 ${normalized}`;
}

module.exports = {
  CARRIER_AIRCRAFT_TYPES,
  DEFAULT_BLACKLIST_NAMES,
  EQUIPMENT_TYPE_NAMES,
  buildEquipmentChoices,
  defaultBlacklistedMasterIds,
  equipmentTypeName,
  filterBlacklistChoices,
  filterOptimizationEquipment,
  isEquipmentExcluded,
  isCarrierAircraft,
  rankEquipmentMatches,
  sortEquipmentChoices,
  uniqueEquipmentMasters,
};
