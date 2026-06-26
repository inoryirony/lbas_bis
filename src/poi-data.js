'use strict';

const RECON_MASTER_IDS = new Set([138, 178, 311, 312]);
const LAND_BASED_API_TYPE_ROOTS = new Set([17, 21, 22, 25, 26]);
const AIRCRAFT_EQUIP_TYPES = new Set([
  6, 7, 8, 9, 10, 11,
  25, 26,
  41, 45, 47, 48, 49,
  53, 54, 56, 57, 58, 59,
]);
const FIGHTER_EQUIP_TYPES = new Set([6, 45, 48]);
const ATTACKER_EQUIP_TYPES = new Set([7, 8, 11, 47, 53, 57, 58, 59]);
const RECON_EQUIP_TYPES = new Set([9, 10, 41, 49]);
const SEAPLANE_BOMBER_EQUIP_TYPES = new Set([11]);

function extractOwnedPlanes(poiState) {
  const masterById = getMasterEquipment(poiState);
  const ownedEquips = Object.values(poiState?.info?.equips || {});

  return ownedEquips
    .map((equip) => toPlaneInstance(equip, masterById[equip.api_slotitem_id]))
    .filter(Boolean);
}

function extractOptimizationPlanes(poiState, options = {}) {
  const includeMissing = options.includeMissing === true;
  const maxCopiesPerMaster = Math.max(1, Number(options.maxCopiesPerMaster) || 4);
  const missingProficiency = Math.max(0, Math.min(7, Number(options.missingProficiency ?? 7) || 0));
  const masterById = getMasterEquipment(poiState);
  const ownedPlanes = extractOwnedPlanes(poiState).map((plane) => ({
    ...plane,
    available: true,
    missing: false,
  }));

  if (!includeMissing) {
    return ownedPlanes;
  }

  const ownedCounts = new Map();

  for (const plane of ownedPlanes) {
    ownedCounts.set(plane.masterId, (ownedCounts.get(plane.masterId) || 0) + 1);
  }

  const theoreticalPlanes = Object.values(masterById)
    .filter(isLbasCandidateMaster)
    .flatMap((master) => {
      const masterId = Number(master.api_id) || 0;
      const ownedCount = ownedCounts.get(masterId) || 0;
      const missingCount = Math.max(0, maxCopiesPerMaster - ownedCount);
      return Array.from({ length: missingCount }, (_, index) =>
        toPlaneInstance(
          {
            api_id: `missing-${masterId}-${index + 1}`,
            api_slotitem_id: masterId,
            api_level: 0,
            api_alv: missingProficiency,
          },
          master,
          {
            available: false,
            missing: true,
            copyIndex: index + 1,
          },
        ),
      );
    })
    .filter(Boolean);

  return [...ownedPlanes, ...theoreticalPlanes];
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

function toPlaneInstance(equip, master, overrides = {}) {
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
    isLandBased: isLandBasedMaster(master),
    torpedo,
    bombing,
    available: true,
    missing: false,
    ...overrides,
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
  if (SEAPLANE_BOMBER_EQUIP_TYPES.has(equipType)) {
    return 'seaplaneBomber';
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

function isLandBasedMaster(master) {
  return LAND_BASED_API_TYPE_ROOTS.has(Number(master.api_type?.[0]) || 0);
}

module.exports = {
  extractOptimizationPlanes,
  extractOwnedPlanes,
};
