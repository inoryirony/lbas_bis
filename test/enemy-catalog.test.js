import { describe, expect, test } from 'vitest';
import catalogModule from '../src/enemy-catalog.js';

const { buildEnemyCatalog } = catalogModule;

describe('enemy ship catalog', () => {
  test('searches Poi enemy masters and builds aircraft slots from Navy Album data', () => {
    const catalog = buildEnemyCatalog(samplePoiState(), {
      abyssalData: {
        1764: {
          SLOTS: [32, 30, 28],
          EQUIPS: [1619, 1620, 1621],
        },
      },
    });

    expect(catalog.search('空母棲姫')).toEqual([
      expect.objectContaining({ id: 1764, name: '空母棲姫', typeName: '正規空母' }),
    ]);
    expect(catalog.search('1764')).toHaveLength(1);
    expect(catalog.search('くうぼ')).toHaveLength(1);
    expect(catalog.slotsForShip(1764)).toEqual([
      expect.objectContaining({
        equipmentMasterId: 1619,
        name: '深海猫艦戦',
        sortieAntiAir: 10,
        currentSlot: 32,
        maxSlot: 32,
        sourceSlotIndex: 0,
      }),
      expect.objectContaining({ currentSlot: 30, sourceSlotIndex: 1 }),
      expect.objectContaining({ currentSlot: 28, sourceSlotIndex: 2 }),
    ]);
    expect(catalog.byId.get(1764).airPower).toBe(
      Math.floor(10 * Math.sqrt(32)) +
      Math.floor(8 * Math.sqrt(30)) +
      Math.floor(6 * Math.sqrt(28)),
    );
  });

  test('marks missing and mismatched album data without fabricating slots', () => {
    const catalog = buildEnemyCatalog(samplePoiState(), {
      abyssalData: {
        1764: { SLOTS: [32, 30], EQUIPS: [1619] },
      },
    });

    expect(catalog.byId.get(1764).dataStatus).toBe('mismatched');
    expect(catalog.slotsForShip(1764)).toHaveLength(1);
    expect(catalog.byId.get(1776).dataStatus).toBe('missing');
    expect(catalog.slotsForShip(1776)).toEqual([]);
    expect(catalog.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISMATCHED_ENEMY_SLOT_DATA', shipId: 1764 }),
      expect.objectContaining({ code: 'MISSING_ENEMY_SLOT_DATA', shipId: 1776 }),
    ]));
  });

  test('prefers official slot data, then noro6, before Navy Album fallback', () => {
    const poiState = samplePoiState();
    poiState.const.$ships[1764] = {
      ...poiState.const.$ships[1764],
      api_maxeq: [1],
      api_default_slot: [1619],
    };
    const official = buildEnemyCatalog(poiState, {
      noro6Master: {
        enemies: [{ id: 1764, slots: [20], items: [1620] }],
        items: [{ id: 1620, name: 'noro item', antiAir: 8 }],
      },
      abyssalData: { 1764: { SLOTS: [32], EQUIPS: [1621] } },
    });
    delete poiState.const.$ships[1764].api_maxeq;
    delete poiState.const.$ships[1764].api_default_slot;
    const noro6 = buildEnemyCatalog(poiState, {
      noro6Master: {
        enemies: [{ id: 1764, slots: [20], items: [1620] }],
        items: [{ id: 1620, name: 'noro item', antiAir: 8 }],
      },
      abyssalData: { 1764: { SLOTS: [32], EQUIPS: [1621] } },
    });

    expect(official.slotsForShip(1764)[0]).toMatchObject({ source: 'official', currentSlot: 1 });
    expect(noro6.slotsForShip(1764)[0]).toMatchObject({ source: 'noro6', currentSlot: 20 });
  });

  test('does not expose positive non-aircraft equipment slots as enemy aircraft', () => {
    const poiState = samplePoiState();
    poiState.const.$ships[1764] = {
      ...poiState.const.$ships[1764],
      api_maxeq: [18, 4],
      api_default_slot: [1619, 1699],
    };
    poiState.const.$equips[1619].api_type = [0, 0, 6, 0];
    poiState.const.$equips[1699] = {
      api_id: 1699,
      api_name: 'enemy gun',
      api_tyku: 8,
      api_type: [0, 0, 2, 0],
    };

    const catalog = buildEnemyCatalog(poiState, { abyssalData: {} });

    expect(catalog.slotsForShip(1764).map((slot) => slot.equipmentMasterId)).toEqual([1619]);
    expect(catalog.byId.get(1764).airPower).toBe(Math.floor(10 * Math.sqrt(18)));
  });

  test('gives repeated copies of the same enemy ship unique aircraft slot IDs', () => {
    const catalog = buildEnemyCatalog(samplePoiState(), {
      abyssalData: { 1764: { SLOTS: [18], EQUIPS: [1619] } },
    });

    const first = catalog.slotsForShip(1764, 0);
    const second = catalog.slotsForShip(1764, 1);

    expect(first[0].instanceId).not.toBe(second[0].instanceId);
    expect(new Set([...first, ...second].map((slot) => slot.instanceId)).size).toBe(2);
  });

  test('uses official combat stats and fills absent fields from noro6 master data', () => {
    const poiState = samplePoiState();
    poiState.const.$ships[1764] = {
      ...poiState.const.$ships[1764],
      api_taik: [500, 500],
      api_souk: [180, 180],
      api_soku: 0,
    };
    const catalog = buildEnemyCatalog(poiState, {
      noro6Master: {
        enemies: [
          { id: 1764, type: 99, hp: 499, armor: 179, speed: 1, slots: [], items: [] },
          { id: 1776, type: 3, hp: 220, armor: 110, speed: 1, slots: [], items: [] },
        ],
        items: [],
      },
      abyssalData: {},
    });

    expect(catalog.byId.get(1764)).toMatchObject({
      type: 11,
      hp: 500,
      armor: 180,
      speed: 0,
    });
    expect(catalog.byId.get(1776)).toMatchObject({
      type: 3,
      hp: 220,
      armor: 110,
      speed: 1,
    });
  });
});

function samplePoiState() {
  return {
    const: {
      $ships: {
        1764: { api_id: 1764, api_name: '空母棲姫', api_yomi: 'くうぼせいき', api_stype: 11 },
        1776: { api_id: 1776, api_name: '軽巡ツ級', api_yomi: 'けいじゅんつきゅう', api_stype: 3 },
      },
      $shipTypes: {
        11: { api_name: '正規空母' },
        3: { api_name: '軽巡洋艦' },
      },
      $equips: {
        1619: { api_id: 1619, api_name: '深海猫艦戦', api_tyku: 10 },
        1620: { api_id: 1620, api_name: '深海地獄艦爆', api_tyku: 8 },
        1621: { api_id: 1621, api_name: '深海復讐艦攻', api_tyku: 6 },
      },
    },
  };
}
