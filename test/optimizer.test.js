import { describe, expect, test } from 'vitest';
import optimizer from '../src/optimizer.js';

const { optimizeLoadouts } = optimizer;

describe('LBAS optimizer MVP', () => {
  test('finds a valid base plan without reusing the same equipment instance', () => {
    const equipment = [
      plane('f1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter' }),
      plane('f2', { antiAir: 10, intercept: 3, radius: 7, role: 'fighter' }),
      plane('f3', { antiAir: 9, intercept: 0, radius: 7, role: 'fighter' }),
      plane('f4', { antiAir: 8, intercept: 0, radius: 7, role: 'fighter' }),
      plane('a1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14 }),
      plane('a2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14 }),
      plane('a3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12 }),
      plane('a4', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12 }),
    ];

    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 3,
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].fulfilled).toBe(true);
    expect(result.results[0].bases).toHaveLength(2);

    const usedIds = result.results[0].bases.flatMap((base) =>
      base.loadout.map((item) => item.instanceId),
    );
    expect(new Set(usedIds).size).toBe(usedIds.length);
  });

  test('returns an actionable reason when no plane can reach the requested radius', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('f1', { antiAir: 10, radius: 4, role: 'fighter' }),
        plane('f2', { antiAir: 9, radius: 4, role: 'fighter' }),
        plane('a1', { antiAir: 3, radius: 5, role: 'attacker' }),
        plane('a2', { antiAir: 3, radius: 5, role: 'attacker' }),
      ],
      baseCount: 1,
      targetRadius: 9,
      enemyAir: 36,
      targetStates: ['parity'],
      maxResults: 3,
    });

    expect(result.results).toHaveLength(0);
    expect(result.messages).toContain('No candidate loadout can reach radius 9.');
  });
});

function plane(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: Number(instanceId.replace(/\D/g, '')) || 1,
    name: instanceId,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 0,
    improvement: 0,
    proficiency: 0,
    role: 'attacker',
    torpedo: 0,
    bombing: 0,
    ...overrides,
  };
}
