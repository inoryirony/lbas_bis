'use strict';

const RECON_MASTER_IDS = new Set([138, 178, 311, 312]);
const AIRCRAFT_EQUIP_TYPES = new Set([
  6, 7, 8, 9, 10, 11,
  25, 26,
  41, 45, 47, 48, 49,
  53, 54, 56, 57, 58, 59,
]);
const FIGHTER_EQUIP_TYPES = new Set([6, 45, 48]);
const ATTACKER_EQUIP_TYPES = new Set([7, 8, 11, 47, 53, 57, 58, 59]);
const RECON_EQUIP_TYPES = new Set([9, 10, 41, 49]);

function extractOwnedPlanes(poiState) {
  const masterById = getMasterEquipment(poiState);
  const ownedEquips = Object.values(poiState?.info?.equips || {});

  return ownedEquips
    .map((equip) => toPlaneInstance(equip, masterById[equip.api_slotitem_id]))
    .filter(Boolean);
}

function getMasterEquipment(poiState) {
  const constants = poiState?.const || {};
  if (constants.$equips) {
    return constants.$equips;
  }

  const items = constants.api_mst_slotitem || {};
  if (Array.isArray(items)) {
    return Object.fromEntries(items.map((item) => [item.api_id, item]));
  }
  return items;
}

function toPlaneInstance(equip, master) {
  if (!equip || !master || !isLbasCandidateMaster(master)) {
    return null;
  }

  const torpedo = Number(master.api_raig) || 0;
  const bombing = Number(master.api_baku) || 0;
  const antiAir = Number(master.api_tyku) || 0;

  return {
    instanceId: equip.api_id,
    masterId: master.api_id || equip.api_slotitem_id,
    name: master.api_name || `Item ${equip.api_slotitem_id}`,
    antiAir,
    intercept: Number(master.api_houk) || 0,
    antiBomber: Number(master.api_bakk) || 0,
    radius: Number(master.api_distance) || 0,
    improvement: Number(equip.api_level) || 0,
    proficiency: Number(equip.api_alv) || 0,
    role: classifyRole(master, { antiAir, torpedo, bombing }),
    torpedo,
    bombing,
  };
}

function isLbasCandidateMaster(master) {
  const masterId = Number(master.api_id) || 0;
  const equipType = getEquipType(master);
  return (
    (Number(master.api_distance) || 0) > 0 &&
    (RECON_MASTER_IDS.has(masterId) || AIRCRAFT_EQUIP_TYPES.has(equipType))
  );
}

function classifyRole(master, stats) {
  const masterId = Number(master.api_id) || 0;
  const equipType = getEquipType(master);
  if (RECON_MASTER_IDS.has(masterId) || RECON_EQUIP_TYPES.has(equipType)) {
    return 'recon';
  }
  if (ATTACKER_EQUIP_TYPES.has(equipType) || stats.torpedo > 0 || stats.bombing > 0) {
    return 'attacker';
  }
  if (FIGHTER_EQUIP_TYPES.has(equipType) || stats.antiAir > 0) {
    return 'fighter';
  }
  return 'unknown';
}

function getEquipType(master) {
  return Number(master.api_type?.[2]) || 0;
}

module.exports = {
  extractOwnedPlanes,
};
