'use strict';

const RECON_MASTER_IDS = new Set([138, 178, 311, 312]);

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
  return (
    (Number(master.api_distance) || 0) > 0 &&
    (RECON_MASTER_IDS.has(masterId) || Number(master.api_tyku) || Number(master.api_raig) || Number(master.api_baku))
  );
}

function classifyRole(master, stats) {
  const masterId = Number(master.api_id) || 0;
  if (RECON_MASTER_IDS.has(masterId)) {
    return 'recon';
  }
  if (stats.torpedo > 0 || stats.bombing > 0) {
    return 'attacker';
  }
  if (stats.antiAir > 0) {
    return 'fighter';
  }
  return 'unknown';
}

module.exports = {
  extractOwnedPlanes,
};
