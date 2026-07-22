import { describe, expect, test } from 'vitest';
import mapCatalogModule from '../src/map-catalog.js';

const { buildMapCatalog } = mapCatalogModule;

describe('noro6-compatible map catalog', () => {
  test('parses real 6-4, 6-5, and 2026 E-3 A1 formations with matching air power', () => {
    const catalog = buildMapCatalog(realSubset());
    const case64 = catalog.formations(64, 'N', 0)[0];
    const case65 = catalog.formations(65, 'M', 0)[0];
    const eventA1 = catalog.formations(623, 'A1', 4)[0];

    expect(case64).toMatchObject({ enemyAir: 112, radius: [5] });
    expect(case65).toMatchObject({
      enemyAir: 318,
      radius: [5],
      thresholds: { supremacy: 954, superiority: 477, parity: 213, denial: 107 },
    });
    expect(eventA1).toMatchObject({
      enemyAir: 219,
      radius: [4, 7],
      enemyIds: [1535, 1535, 1532, 1764, 1776],
      thresholds: { supremacy: 657, superiority: 329, parity: 147, denial: 74 },
    });
    expect(eventA1.enemySlots.every((slot) => slot.source === 'noro6')).toBe(true);
  });

  test('exposes cascading area, node, difficulty, and formation options', () => {
    const catalog = buildMapCatalog(realSubset());

    expect(catalog.areas.map((area) => area.area)).toEqual([64, 65, 623]);
    expect(catalog.nodes(623)).toEqual([expect.objectContaining({ node: 'A1' })]);
    expect(catalog.difficulties(623, 'A1')).toEqual([4]);
    expect(catalog.formations(623, 'A1', 4)).toHaveLength(1);
  });

  test('excludes non-aircraft equipment from land-base enemy air power', () => {
    const catalog = buildMapCatalog({
      cells: { patterns: [{ a: 65, n: 'M', l: 0, r: [5], e: [1] }] },
      master: {
        maps: [{ area: 65, name: '6-5', boss: ['M'] }],
        worlds: [{ world: 6, name: 'world 6' }],
        enemies: [enemy(1501, [18, 18, 4], [1601, 1602, 1603])],
        items: [
          { id: 1601, name: 'fighter', type: 6, antiAir: 10 },
          { id: 1602, name: 'gun', type: 2, antiAir: 8 },
          { id: 1603, name: 'recon', type: 10, antiAir: 1 },
        ],
      },
    });

    const formation = catalog.formations(65, 'M', 0)[0];
    expect(formation.enemySlots.map((slot) => slot.equipmentMasterId)).toEqual([1601, 1603]);
    expect(formation.enemyAir).toBe(
      Math.floor(10 * Math.sqrt(18)) + Math.floor(Math.sqrt(4)),
    );
  });

  test('attaches enemy Stage 2 defense from full ship equipment and formation data', () => {
    const catalog = buildMapCatalog({
      cells: { patterns: [{ a: 65, n: 'M', l: 0, t: 1, f: 1, r: [5], e: [1] }] },
      master: {
        maps: [{ area: 65, name: '6-5', boss: ['M'] }],
        worlds: [{ world: 6, name: 'world 6' }],
        enemies: [{ id: 1501, name: 'AA cruiser', aa: 100, slots: [-1], items: [1601] }],
        items: [{ id: 1601, name: 'AA gun', type: 21, itype: 15, antiAir: 10 }],
      },
    });

    expect(catalog.formations(65, 'M', 0)[0].stage2Defense)
      .toMatchObject({ modeled: true, formation: 1, isUnion: false });
  });
});

function realSubset() {
  return {
    cells: {
      patterns: [
        { a: 64, n: 'N', d: '', l: 0, t: 1, f: 1, r: [5], e: [171, 167, 166, 165, 153, 58] },
        { a: 65, n: 'M', d: '', l: 0, t: 2, f: 13, r: [5], e: [86, 115, 115, 92, 78, 78, 55, 27, 27, 77, 76, 76] },
        { a: 623, n: 'A1', d: '', l: 4, t: 8, f: 4, r: [4, 7], e: [35, 35, 32, 264, 276] },
      ],
    },
    master: {
      worlds: [
        { world: 6, name: '中部海域' },
        { world: 62, name: '2026夏' },
      ],
      maps: [
        { area: 64, name: '中部北海域ピーコック島沖', boss: ['N'] },
        { area: 65, name: 'KW環礁沖海域', boss: ['M'] },
        { area: 623, name: 'E-3', boss: ['Z'] },
      ],
      enemies: enemyMasters(),
      items: itemMasters(),
    },
  };
}

function enemyMasters() {
  return [
    enemy(1532, [-1, -1, -1], [1515, 1513, 1513]),
    enemy(1535, [-1, -1, -1], [1515, 1515, 1514]),
    enemy(1555, [2, 2, 2, 2], [1506, 1525, 1542, 1543]),
    enemy(1558, [-1, -1, -1], [1506, 1504, 1504]),
    enemy(1653, [12, 12, 8, 4], [1561, 1561, 1561, 1561]),
    enemy(1665, [-1, -1, -1, -1], [1565, 1565, 1539, 1567]),
    enemy(1666, [-1, -1, -1, -1], [1565, 1540, 1539, 1567]),
    enemy(1667, [-1, -1, -1, -1], [1565, 1553, 1539, 1567]),
    enemy(1671, [-1, -1, 32, 32], [1565, 1565, 1566, 1566]),
    enemy(1527, [4, 4, 4, 4], [1505, 1506, 1515, 1525]),
    enemy(1576, [-1, -1, -1], [1502, 1545, 1542]),
    enemy(1577, [-1, -1, -1], [1502, 1515, 1542]),
    enemy(1578, [-1, -1, -1], [1502, 1515, 1542]),
    enemy(1586, [60, 52, 56, -1], [1547, 1548, 1549, 1532]),
    enemy(1592, [-1, -1, 3, 3], [1550, 1550, 1545, 1525]),
    enemy(1615, [32, 32, 27, 5], [1556, 1557, 1558, 1558]),
    enemy(1764, [32, 30, 28, -1], [1556, 1557, 1558, 1532]),
    enemy(1776, [26, 23, 23, -1], [1547, 1574, 1574]),
  ];
}

function itemMasters() {
  const values = {
    1502: 0, 1504: 2, 1505: 2, 1506: 3, 1513: 0, 1514: 0, 1515: 0,
    1525: 1, 1532: 18, 1539: 8, 1540: 12, 1542: 0, 1543: 0, 1545: 0,
    1547: 10, 1548: 0, 1549: 4, 1550: 9, 1553: 15, 1556: 12, 1557: 0,
    1558: 5, 1561: 3, 1565: 0, 1566: 7, 1567: 4, 1574: 8,
  };
  const types = {
    1502: 1, 1504: 2, 1505: 2, 1506: 2, 1513: 5, 1514: 5, 1515: 5,
    1525: 10, 1532: 13, 1539: 21, 1540: 21, 1542: 15, 1543: 14, 1545: 14,
    1547: 6, 1548: 7, 1549: 8, 1550: 1, 1553: 1, 1556: 6, 1557: 7,
    1558: 8, 1561: 7, 1565: 1, 1566: 7, 1567: 13, 1574: 8,
  };
  return Object.entries(values).map(([id, antiAir]) => ({
    id: Number(id),
    name: `Enemy item ${id}`,
    antiAir,
    type: types[id],
  }));
}

function enemy(id, slots, items) {
  return { id, name: `Enemy ${id}`, slots, items };
}
