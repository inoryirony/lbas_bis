'use strict';

const path = require('path');
const { PLANE_TYPES } = require('./aircraft');

function buildEnemyCatalog(poiState = {}, options = {}) {
  const shipsByMasterId = poiState?.const?.$ships || {};
  const shipTypes = poiState?.const?.$shipTypes || {};
  const equips = poiState?.const?.$equips || {};
  const abyssalData = options.abyssalData ?? loadNavyAlbumAbyssal();
  const noroEnemies = new Map((options.noro6Master?.enemies || [])
    .map((enemy) => [Number(enemy.id), enemy]));
  const noroItems = new Map((options.noro6Master?.items || [])
    .map((item) => [Number(item.id), item]));
  const warnings = [];
  const ships = Object.values(shipsByMasterId)
    .filter((ship) => Number(ship?.api_id) >= 1500)
    .map((master) => buildCatalogShip(master, shipTypes, equips, {
      abyssalData,
      noroEnemies,
      noroItems,
    }, warnings))
    .sort((left, right) => left.id - right.id);
  const byId = new Map(ships.map((ship) => [ship.id, ship]));

  return {
    ships,
    byId,
    warnings,
    search(query) {
      const needle = normalizeSearch(query);
      if (!needle) return ships;
      return ships.filter((ship) => [ship.id, ship.name, ship.reading, ship.typeName]
        .some((value) => normalizeSearch(value).includes(needle)));
    },
    slotsForShip(shipId, sourceShipIndex = null) {
      const ship = byId.get(Number(shipId));
      if (!ship) return [];
      return ship.slots.map((slot) => ({
        ...slot,
        ...(sourceShipIndex == null ? {} : {
          sourceShipIndex,
          instanceId: `enemy-fleet-${sourceShipIndex}-ship-${ship.id}-slot-${slot.sourceSlotIndex}`,
        }),
      }));
    },
  };
}

function buildCatalogShip(master, shipTypes, equips, sources, warnings) {
  const id = Number(master.api_id);
  const typeMaster = shipTypes?.[master.api_stype] || shipTypes?.[String(master.api_stype)] || {};
  const base = {
    id,
    name: master.api_name || `Enemy ${id}`,
    reading: master.api_yomi || '',
    typeId: Number(master.api_stype) || 0,
    typeName: typeMaster.api_name || typeMaster.name || '',
  };
  const officialSlots = Array.isArray(master.api_maxeq) ? master.api_maxeq : null;
  const officialEquips = firstArray(
    master.api_default_slot,
    master.api_slotitems,
    master.api_equip,
  );
  const noroEnemy = sources.noroEnemies.get(id);
  const album = sources.abyssalData?.[id] || sources.abyssalData?.[String(id)];
  let slotSizes = null;
  let equipmentIds = null;
  let source = null;
  let itemForId = null;
  if (officialSlots && officialEquips) {
    slotSizes = officialSlots;
    equipmentIds = officialEquips;
    source = 'official';
    itemForId = (equipmentId) => equips?.[equipmentId] || equips?.[String(equipmentId)];
  } else if (Array.isArray(noroEnemy?.slots) && Array.isArray(noroEnemy?.items)) {
    slotSizes = noroEnemy.slots;
    equipmentIds = noroEnemy.items;
    source = 'noro6';
    itemForId = (equipmentId) => sources.noroItems.get(equipmentId);
  } else if (Array.isArray(album?.SLOTS) && Array.isArray(album?.EQUIPS)) {
    slotSizes = album.SLOTS;
    equipmentIds = album.EQUIPS;
    source = 'navy-album';
    itemForId = (equipmentId) => equips?.[equipmentId] || equips?.[String(equipmentId)];
  }
  if (!slotSizes || !equipmentIds) {
    warnings.push({ code: 'MISSING_ENEMY_SLOT_DATA', shipId: id });
    return { ...base, dataStatus: 'missing', slots: [], airPower: 0 };
  }

  const mismatched = slotSizes.length !== equipmentIds.length;
  if (mismatched) {
    warnings.push({
      code: 'MISMATCHED_ENEMY_SLOT_DATA',
      shipId: id,
      slotCount: slotSizes.length,
      equipmentCount: equipmentIds.length,
      source,
    });
  }
  const slots = [];
  const count = Math.min(slotSizes.length, equipmentIds.length);
  for (let index = 0; index < count; index += 1) {
    const equipmentMasterId = Number(equipmentIds[index]) || 0;
    const equipment = itemForId(equipmentMasterId);
    if (!equipment) {
      warnings.push({
        code: 'MISSING_ENEMY_EQUIPMENT_MASTER',
        shipId: id,
        equipmentMasterId,
        sourceSlotIndex: index,
        source,
      });
      continue;
    }
    if (!isAircraftEquipment(equipment)) continue;
    const slotSize = Math.max(0, Number(slotSizes[index]) || 0);
    slots.push({
      instanceId: `enemy-${id}-slot-${index}`,
      name: equipment.api_name || equipment.name || `Enemy equipment ${equipmentMasterId}`,
      sortieAntiAir: Math.max(0, Number(equipment.api_tyku ?? equipment.antiAir) || 0),
      currentSlot: slotSize,
      maxSlot: slotSize,
      equipmentMasterId,
      sourceSlotIndex: index,
      source,
      overridden: false,
    });
  }
  return {
    ...base,
    dataStatus: mismatched ? 'mismatched' : 'complete',
    source,
    slots,
    airPower: slots.reduce(
      (total, slot) => total + Math.floor(slot.sortieAntiAir * Math.sqrt(slot.currentSlot)),
      0,
    ),
  };
}

function isAircraftEquipment(equipment) {
  const type = Number(equipment?.api_type?.[2] ?? equipment?.type ?? equipment?.itype) || 0;
  return type === 0 || PLANE_TYPES.has(type);
}

function firstArray(...values) {
  return values.find(Array.isArray) || null;
}

function loadNavyAlbumAbyssal() {
  const candidates = [
    'poi-plugin-navy-album/assets/abyssal.json',
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'poi', 'plugins', 'node_modules', 'poi-plugin-navy-album', 'assets', 'abyssal.json')
      : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_error) {
      // Try the next runtime location.
    }
  }
  return null;
}

function normalizeSearch(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

module.exports = {
  buildEnemyCatalog,
  loadNavyAlbumAbyssal,
};
