'use strict';

const { requiredAirForState } = require('./air-power');
const { PLANE_TYPES } = require('./aircraft');

/** @param {{cells?: Record<string, any>, master?: Record<string, any>}} [input] */
function buildMapCatalog({ cells = {}, master = {} } = {}) {
  const patterns = Array.isArray(cells.patterns) ? cells.patterns : [];
  const mapsByArea = new Map((master.maps || []).map((map) => [Number(map.area), map]));
  const worldsById = new Map((master.worlds || []).map((world) => [Number(world.world), world]));
  const enemiesById = new Map((master.enemies || []).map((enemy) => [Number(enemy.id), enemy]));
  const itemsById = new Map((master.items || []).map((item) => [Number(item.id), item]));
  const patternAreas = new Set(patterns.map((pattern) => Number(pattern.a)));
  const areas = [...patternAreas]
    .map((area) => {
      const map = mapsByArea.get(area) || {};
      const worldId = Math.floor(area / 10);
      return {
        area,
        worldId,
        worldName: worldsById.get(worldId)?.name || '',
        name: map.name || `${Math.floor(area / 10)}-${area % 10}`,
        bossNodes: Array.isArray(map.boss) ? map.boss : [],
      };
    })
    .sort((left, right) => left.area - right.area);

  return {
    areas,
    nodes(area) {
      const areaNumber = Number(area);
      const map = mapsByArea.get(areaNumber) || {};
      const names = [...new Set(patterns
        .filter((pattern) => Number(pattern.a) === areaNumber)
        .map((pattern) => String(pattern.n)))];
      return names.map((node) => ({
        node,
        isBoss: Array.isArray(map.boss) && map.boss.includes(node),
      }));
    },
    difficulties(area, node) {
      return [...new Set(patterns
        .filter((pattern) => Number(pattern.a) === Number(area) && String(pattern.n) === String(node))
        .map((pattern) => Number(pattern.l) || 0))]
        .sort((left, right) => right - left);
    },
    formations(area, node, difficulty) {
      return patterns
        .map((pattern, sourceIndex) => ({ pattern, sourceIndex }))
        .filter(({ pattern }) =>
          Number(pattern.a) === Number(area) &&
          String(pattern.n) === String(node) &&
          (Number(pattern.l) || 0) === (Number(difficulty) || 0))
        .map(({ pattern, sourceIndex }, index) => normalizeFormation(
          pattern,
          sourceIndex,
          index,
          enemiesById,
          itemsById,
        ));
    },
  };
}

function normalizeFormation(pattern, sourceIndex, formationIndex, enemiesById, itemsById) {
  const enemyIds = (pattern.e || []).map((value) => Number(value) + 1500);
  const warnings = [];
  const ships = enemyIds.map((enemyId, sourceShipIndex) => {
    const master = enemiesById.get(enemyId);
    if (!master) {
      warnings.push({ code: 'MISSING_NORO6_ENEMY_MASTER', enemyId, sourceShipIndex });
      return {
        id: enemyId,
        name: `Enemy ${enemyId}`,
        airPower: 0,
        dataStatus: 'missing',
        source: 'noro6',
        slots: [],
      };
    }
    const count = Math.min(master.slots?.length || 0, master.items?.length || 0);
    const slots = [];
    for (let sourceSlotIndex = 0; sourceSlotIndex < count; sourceSlotIndex += 1) {
      const slotSize = Number(master.slots[sourceSlotIndex]);
      if (!(slotSize > 0)) continue;
      const equipmentMasterId = Number(master.items[sourceSlotIndex]);
      const item = itemsById.get(equipmentMasterId);
      if (!item) {
        warnings.push({
          code: 'MISSING_NORO6_ITEM_MASTER',
          enemyId,
          equipmentMasterId,
          sourceShipIndex,
          sourceSlotIndex,
        });
        continue;
      }
      if (!isAircraftEquipment(item)) continue;
      slots.push({
        instanceId: `map-${pattern.a}-${pattern.n}-${sourceIndex}-${sourceShipIndex}-${sourceSlotIndex}`,
        name: item.name || `Enemy item ${equipmentMasterId}`,
        sortieAntiAir: Math.max(0, Number(item.antiAir) || 0),
        currentSlot: slotSize,
        maxSlot: slotSize,
        equipmentMasterId,
        sourceShipIndex,
        sourceSlotIndex,
        source: 'noro6',
        overridden: false,
      });
    }
    return {
      id: enemyId,
      name: master.name || `Enemy ${enemyId}`,
      airPower: airPowerForSlots(slots),
      dataStatus: warnings.some((warning) => warning.enemyId === enemyId)
        ? 'missing'
        : 'complete',
      source: 'noro6',
      slots,
    };
  });
  const enemySlots = ships.flatMap((ship) => ship.slots);
  const enemyAir = airPowerForSlots(enemySlots);
  return {
    id: `${pattern.a}:${pattern.n}:${pattern.l || 0}:${sourceIndex}`,
    index: formationIndex,
    area: Number(pattern.a),
    node: String(pattern.n),
    detail: pattern.d || '',
    difficulty: Number(pattern.l) || 0,
    battleType: Number(pattern.t) || 0,
    formation: Number(pattern.f) || 0,
    radius: Array.isArray(pattern.r) ? pattern.r.map(Number) : [],
    enemyIds,
    ships,
    enemySlots,
    enemyAir,
    thresholds: {
      supremacy: requiredAirForState(enemyAir, 'supremacy'),
      superiority: requiredAirForState(enemyAir, 'superiority'),
      parity: requiredAirForState(enemyAir, 'parity'),
      denial: requiredAirForState(enemyAir, 'denial'),
    },
    warnings,
    source: 'noro6',
  };
}

function isAircraftEquipment(item) {
  const type = Number(item?.api_type?.[2] ?? item?.type ?? item?.itype) || 0;
  return type === 0 || PLANE_TYPES.has(type);
}

function airPowerForSlots(slots) {
  return slots.reduce(
    (total, slot) => total + Math.floor(slot.sortieAntiAir * Math.sqrt(slot.currentSlot)),
    0,
  );
}

module.exports = { buildMapCatalog };
