import { describe, expect, test } from 'vitest';
import stage2Module from '../src/enemy-stage2.js';

const { buildEnemyStage2Defense, stageTwoShootdownStatus } = stage2Module;

describe('enemy Stage 2 anti-air', () => {
  test('matches the kcwiki and kc-web no-cut-in enemy formula for every avoidance level', () => {
    const defense = buildEnemyStage2Defense({
      enemyIds: [1501],
      formation: 1,
      battleType: 1,
      enemiesById: new Map([[1501, {
        id: 1501,
        name: 'AA cruiser',
        aa: 100,
        items: [1601],
      }]]),
      itemsById: new Map([[1601, {
        id: 1601,
        name: 'AA gun',
        type: 21,
        itype: 15,
        antiAir: 10,
      }]]),
    });

    expect(defense).toMatchObject({ modeled: true, formation: 1, isUnion: false });
    expect(stageTwoShootdownStatus(defense, 0)).toEqual({
      fixedLosses: [7],
      rateFactors: [0.2],
    });
    expect(stageTwoShootdownStatus(defense, 1)).toEqual({
      fixedLosses: [4],
      rateFactors: [0.12],
    });
    expect(stageTwoShootdownStatus(defense, 2)).toEqual({
      fixedLosses: [4],
      rateFactors: [0.12],
    });
    expect(stageTwoShootdownStatus(defense, 3)).toEqual({
      fixedLosses: [3],
      rateFactors: [0.1],
    });
    expect(stageTwoShootdownStatus(defense, 4)).toEqual({
      fixedLosses: [3],
      rateFactors: [0.1],
    });
    expect(stageTwoShootdownStatus(defense, 5)).toEqual({
      fixedLosses: [3],
      rateFactors: [0.08],
    });
  });

  test('floors enemy square-root anti-air before adding weighted equipment', () => {
    const defense = buildEnemyStage2Defense({
      enemyIds: [1502],
      formation: 1,
      battleType: 1,
      enemiesById: new Map([[1502, {
        id: 1502,
        aa: 2,
        items: [1602],
      }]]),
      itemsById: new Map([[1602, {
        id: 1602,
        type: 12,
        itype: 0,
        antiAir: 1,
      }]]),
    });

    expect(stageTwoShootdownStatus(defense, 0).rateFactors[0]).toBeCloseTo(0.01, 8);
  });

  test('applies formation after flooring each ship fleet anti-air bonus', () => {
    const defense = buildEnemyStage2Defense({
      enemyIds: [1503],
      formation: 3,
      battleType: 1,
      enemiesById: new Map([[1503, {
        id: 1503,
        aa: 0,
        items: [1603, 1604],
      }]]),
      itemsById: new Map([
        [1603, { id: 1603, type: 21, itype: 15, antiAir: 2 }],
        [1604, { id: 1604, type: 18, itype: 0, antiAir: 7 }],
      ]),
    });

    expect(defense.rawFleetAntiAir).toBe(6.4);
    expect(stageTwoShootdownStatus(defense, 0).fixedLosses).toEqual([2]);
  });

  test('floors avoidance-adjusted fleet anti-air before fixed shootdown', () => {
    const defense = buildEnemyStage2Defense({
      enemyIds: [1504],
      formation: 3,
      battleType: 1,
      enemiesById: new Map([[1504, {
        id: 1504,
        aa: 13,
        items: [1605],
      }]]),
      itemsById: new Map([[1605, {
        id: 1605,
        type: 18,
        itype: 0,
        antiAir: 12,
      }]]),
    });

    expect(defense.rawFleetAntiAir).toBeCloseTo(11.2);
    expect(stageTwoShootdownStatus(defense, 2).fixedLosses).toEqual([1]);
  });

  test('floors each enemy ship fleet anti-air bonus before summing the fleet', () => {
    const defense = buildEnemyStage2Defense({
      enemyIds: [1506, 1507],
      formation: 1,
      battleType: 1,
      enemiesById: new Map([
        [1506, { id: 1506, aa: 28, items: [1606] }],
        [1507, { id: 1507, aa: 28, items: [1606] }],
      ]),
      itemsById: new Map([[1606, { id: 1606, type: 18, itype: 0, antiAir: 1 }]]),
    });

    expect(defense.rawFleetAntiAir).toBe(0);
    expect(stageTwoShootdownStatus(defense, 0).fixedLosses).toEqual([0, 0]);
  });

  test('uses only submarines for Stage 2 at an air-supported ASW cell', () => {
    const defense = buildEnemyStage2Defense({
      enemyIds: [1505, 1506],
      formation: 1,
      battleType: 8,
      enemiesById: new Map([
        [1505, { id: 1505, type: 13, aa: 0, items: [] }],
        [1506, { id: 1506, type: 3, aa: 100, items: [1605] }],
      ]),
      itemsById: new Map([[1605, { id: 1605, type: 21, itype: 15, antiAir: 10 }]]),
    });

    expect(defense.ships.map((ship) => ship.enemyId)).toEqual([1505]);
    expect(stageTwoShootdownStatus(defense, 0).rateFactors).toHaveLength(1);
  });

  test('applies combined-fleet main and escort Stage 2 factors', () => {
    const enemyIds = Array.from({ length: 7 }, (_, index) => 1510 + index);
    const enemiesById = new Map(enemyIds.map((id) => [id, {
      id,
      aa: 100,
      items: [1606],
    }]));
    const defense = buildEnemyStage2Defense({
      enemyIds,
      formation: 1,
      battleType: 2,
      enemiesById,
      itemsById: new Map([[1606, { id: 1606, type: 21, itype: 15, antiAir: 10 }]]),
    });

    expect(stageTwoShootdownStatus(defense, 0).rateFactors[0]).toBeCloseTo(0.16);
    expect(stageTwoShootdownStatus(defense, 0).rateFactors[6]).toBeCloseTo(0.096);
  });
});
