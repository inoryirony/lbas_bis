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

  test('prefers land-based aircraft over carrier aircraft after the target state is satisfied', () => {
    const equipment = [
      plane('carrier-fighter-1', { antiAir: 15, radius: 7, role: 'fighter', isLandBased: false }),
      plane('carrier-fighter-2', { antiAir: 14, radius: 7, role: 'fighter', isLandBased: false }),
      plane('carrier-fighter-3', { antiAir: 13, radius: 7, role: 'fighter', isLandBased: false }),
      plane('carrier-fighter-4', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: false }),
      plane('land-fighter', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
      plane('land-attacker-1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14, isLandBased: true }),
      plane('land-attacker-2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14, isLandBased: true }),
      plane('land-attacker-3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12, isLandBased: true }),
    ];

    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    const selectedIds = result.results[0].bases[0].loadout.map((item) => item.instanceId);
    expect(selectedIds).toContain('land-fighter');
    expect(selectedIds).toContain('land-attacker-1');
    expect(selectedIds).not.toEqual([
      'carrier-fighter-1',
      'carrier-fighter-2',
      'carrier-fighter-3',
      'carrier-fighter-4',
    ]);
  });

  test('maximizes land-based attackers after satisfying the target air state', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('land-fighter-1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('land-fighter-2', { antiAir: 10, intercept: 4, radius: 7, role: 'fighter', isLandBased: true }),
        plane('land-fighter-3', { antiAir: 9, intercept: 3, radius: 7, role: 'fighter', isLandBased: true }),
        plane('land-attacker-1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14, isLandBased: true }),
        plane('land-attacker-2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14, isLandBased: true }),
        plane('land-attacker-3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12, isLandBased: true }),
        plane('land-attacker-4', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 10, bombing: 12, isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results[0].bases[0].landAttackerCount).toBe(3);
    expect(result.results[0].bases[0].damagePower).toBeGreaterThan(0);
  });

  test('keeps long-range land attackers in the candidate pool for radius-seven targets', () => {
    const shortRangeFighters = Array.from({ length: 60 }, (_, index) =>
      plane(`short-fighter-${index}`, {
        antiAir: 12,
        intercept: 4,
        radius: 3,
        role: 'fighter',
        isLandBased: true,
      }),
    );
    const gingaSquadron = Array.from({ length: 4 }, (_, index) =>
      plane(`ginga-${index}`, {
        antiAir: 3,
        radius: 9,
        role: 'attacker',
        torpedo: 14,
        bombing: 14,
        proficiency: 7,
        isLandBased: true,
      }),
    );

    const result = optimizeLoadouts({
      equipment: [...shortRangeFighters, ...gingaSquadron],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].bases[0].loadout.map((item) => item.instanceId)).toEqual([
      'ginga-0',
      'ginga-1',
      'ginga-2',
      'ginga-3',
    ]);
  });

  test('keeps short-range combat planes that can be extended by land recon', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter-1', { antiAir: 12, radius: 4, role: 'fighter', proficiency: 7, isLandBased: true }),
        plane('fighter-2', { antiAir: 12, radius: 4, role: 'fighter', proficiency: 7, isLandBased: true }),
        plane('fighter-3', { antiAir: 12, radius: 4, role: 'fighter', proficiency: 7, isLandBased: true }),
        plane('recon', { masterId: 311, antiAir: 3, radius: 8, role: 'recon', isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 6,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].bases[0].radius).toBe(6);
  });

  test('includes theoretical missing equipment in valid plans', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('owned-fighter', { masterId: 225, antiAir: 11, intercept: 5, radius: 7, role: 'fighter', proficiency: 7, isLandBased: true }),
        plane('missing-attacker-1', {
          masterId: 187,
          antiAir: 3,
          radius: 9,
          role: 'attacker',
          torpedo: 14,
          bombing: 14,
          proficiency: 7,
          isLandBased: true,
          available: false,
          missing: true,
        }),
        plane('missing-attacker-2', {
          masterId: 187,
          antiAir: 3,
          radius: 9,
          role: 'attacker',
          torpedo: 14,
          bombing: 14,
          proficiency: 7,
          isLandBased: true,
          available: false,
          missing: true,
        }),
        plane('missing-attacker-3', {
          masterId: 187,
          antiAir: 3,
          radius: 9,
          role: 'attacker',
          torpedo: 14,
          bombing: 14,
          proficiency: 7,
          isLandBased: true,
          available: false,
          missing: true,
        }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].missingEquipment).toEqual([
      { masterId: 187, name: 'missing-attacker-1', count: 3 },
    ]);
    expect(result.results[0].bases[0].minimumProficiency).toBeGreaterThanOrEqual(0);
  });

  test('treats each base as two waves and records six waves for three bases', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('f1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f2', { antiAir: 10, intercept: 3, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f3', { antiAir: 9, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f4', { antiAir: 8, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f5', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f6', { antiAir: 10, intercept: 3, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f7', { antiAir: 9, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f8', { antiAir: 8, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f9', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f10', { antiAir: 10, intercept: 3, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f11', { antiAir: 9, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
        plane('f12', { antiAir: 8, intercept: 0, radius: 7, role: 'fighter', isLandBased: true }),
      ],
      baseCount: 3,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity', 'parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
    });

    expect(result.results[0].bases).toHaveLength(3);
    expect(result.results[0].waves).toHaveLength(6);
    expect(result.results[0].waves.map((wave) => wave.baseIndex)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  test('keeps locked equipment in the requested base and fills remaining slots', () => {
    const lockedAttacker = plane('locked-ginga', {
      antiAir: 3,
      radius: 9,
      role: 'attacker',
      torpedo: 14,
      bombing: 14,
      isLandBased: true,
    });
    const result = optimizeLoadouts({
      equipment: [
        lockedAttacker,
        plane('fighter-1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
        plane('attacker-1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14, isLandBased: true }),
        plane('attacker-2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14, isLandBased: true }),
        plane('attacker-3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12, isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      lockedBases: [
        {
          slots: [
            { plane: lockedAttacker, locked: true },
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
          ],
        },
      ],
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('locked-ginga');
    expect(result.results[0].bases[0].loadout).toHaveLength(4);
  });

  test('does not reuse a locked equipment instance in another base', () => {
    const lockedFighter = plane('locked-fighter', {
      antiAir: 11,
      intercept: 5,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const equipment = [
      lockedFighter,
      ...Array.from({ length: 11 }, (_, index) =>
        plane(`plane-${index}`, {
          antiAir: index < 3 ? 10 : 3,
          radius: index < 3 ? 7 : 9,
          role: index < 3 ? 'fighter' : 'attacker',
          torpedo: index < 3 ? 0 : 14,
          bombing: index < 3 ? 0 : 14,
          isLandBased: true,
        }),
      ),
    ];

    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      lockedBases: [
        {
          slots: [
            { plane: lockedFighter, locked: true },
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
          ],
        },
        {
          slots: [
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
          ],
        },
      ],
      maxResults: 1,
    });

    const usedIds = result.results[0].bases.flatMap((base) =>
      base.loadout.map((item) => item.instanceId),
    );
    expect(usedIds.filter((id) => id === 'locked-fighter')).toHaveLength(1);
  });
});

/** Creates a legacy optimizer fixture with explicit aircraft capabilities. */
function plane(instanceId, overrides = {}) {
  const role = overrides.role ?? 'attacker';
  const equipType = role === 'fighter' ? 48 : role === 'recon' ? 49 : 47;
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
    equipType,
    isPlane: true,
    isFighter: role === 'fighter',
    isAttacker: role === 'attacker',
    isLandAttacker: role === 'attacker',
    isRecon: role === 'recon',
    isLandRecon: role === 'recon',
    scout: role === 'recon' ? 8 : 0,
    role,
    torpedo: 0,
    bombing: 0,
    isLandBased: false,
    ...overrides,
  };
}
