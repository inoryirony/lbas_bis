import { describe, expect, test } from 'vitest';
import optimizer from '../src/optimizer.js';
import scoreModule from '../src/search-score.js';

const { optimizeLoadouts } = optimizer;
const { comparePlansForSort } = scoreModule;

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
      base.loadout.filter(Boolean).map((item) => item.instanceId),
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

  test('allows a three-plane optimum and preserves the fourth slot as null', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: true }),
        plane('attacker-1', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 14, isLandBased: true }),
        plane('attacker-2', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 13, isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 60,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    });

    expect(result.search.status).toBe('optimal');
    expect(Number.isFinite(result.search.budget)).toBe(true);
    expect(result.results[0].bases[0].loadout.filter(Boolean)).toHaveLength(3);
    expect(result.results[0].bases[0].loadout[3]).toBeNull();
  });

  test('allows a zero-plane base when the static target and radius permit it', () => {
    const result = optimizeLoadouts({
      equipment: [],
      baseCount: 1,
      targetRadius: 0,
      enemyAir: 0,
      targetStates: ['none', 'none'],
      maxResults: 1,
    });

    expect(result.search.status).toBe('optimal');
    expect(result.results[0].bases[0].loadout).toEqual([null, null, null, null]);
  });

  test('keeps a locked empty slot empty while filling other slots', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: true }),
        plane('attacker-1', { radius: 8, role: 'attacker', torpedo: 14, isLandBased: true }),
        plane('attacker-2', { radius: 8, role: 'attacker', torpedo: 13, isLandBased: true }),
        plane('attacker-3', { radius: 8, role: 'attacker', torpedo: 12, isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity'],
      lockedBases: [{ slots: [
        { plane: null, locked: false },
        { plane: null, locked: true },
        { plane: null, locked: false },
        { plane: null, locked: false },
      ] }],
      maxResults: 1,
    });

    expect(result.results[0].bases[0].loadout[1]).toBeNull();
    expect(result.results[0].bases[0].loadout.filter(Boolean)).toHaveLength(3);
  });

  test('treats a directly null legacy slot constraint as open', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: true }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 0,
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [null] }],
      maxResults: 1,
    });

    expect(result.search.status).toBe('optimal');
    expect(result.results[0].bases[0].loadout[0]?.instanceId).toBe('fighter');
  });

  test('globally reserves an item locked in a later base', () => {
    const reserved = plane('reserved-later', {
      antiAir: 14,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const result = optimizeLoadouts({
      equipment: [
        reserved,
        plane('fighter-2', { antiAir: 12, radius: 7, role: 'fighter', isLandBased: true }),
        ...Array.from({ length: 6 }, (_, index) => plane(`attacker-${index}`, {
          antiAir: 2,
          radius: 8,
          role: 'attacker',
          torpedo: 14 - index,
          isLandBased: true,
        })),
      ],
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      lockedBases: [
        { slots: [] },
        { slots: [{ plane: reserved, locked: true }] },
      ],
      maxResults: 1,
    });

    const usedIds = result.results[0].bases.flatMap((base) =>
      base.loadout.filter(Boolean).map((item) => item.instanceId),
    );
    expect(usedIds.filter((id) => id === reserved.instanceId)).toHaveLength(1);
    expect(result.results[0].bases[1].loadout[0].instanceId).toBe(reserved.instanceId);
  });

  test.each([
    ['duplicate', [
      { slots: [{ plane: plane('locked', { radius: 7 }), locked: true }] },
      { slots: [{ plane: plane('locked', { radius: 7 }), locked: true }] },
    ]],
    ['missing', [
      { slots: [{ plane: plane('not-in-inventory', { radius: 7 }), locked: true }] },
    ]],
  ])('returns invalid_input for %s locked instance IDs', (_label, lockedBases) => {
    const result = optimizeLoadouts({
      equipment: [plane('locked', { antiAir: 12, radius: 7, role: 'fighter' })],
      baseCount: lockedBases.length,
      targetRadius: 7,
      enemyAir: 0,
      targetStates: ['supremacy'],
      lockedBases,
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      mode: 'branch-and-bound',
      status: 'invalid_input',
      provenOptimal: false,
    }));
  });

  test('reports budget exhaustion without claiming infeasibility', () => {
    const result = optimizeLoadouts({
      equipment: Array.from({ length: 5 }, (_, index) => plane(`fighter-${index}`, {
        antiAir: 8 + index,
        radius: 7,
        role: 'fighter',
      })),
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity'],
      nodeBudget: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      provenOptimal: false,
      budget: 1,
    }));
  });

  test('does not claim optimality when a detailed search exhausts its budget', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('fighter', { antiAir: 12, radius: 7, role: 'fighter' }),
        plane('attacker', { antiAir: 2, radius: 7, role: 'attacker', torpedo: 14 }),
      ],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['superiority', 'superiority'],
      simulationOptions: { seed: 'budget', sampleCount: 8 },
      nodeBudget: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      provenOptimal: false,
    }));
    expect(result.messages.join(' ')).not.toMatch(/infeasible/i);
  });

  test.each([0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 10001])(
    'returns invalid_input for detailed sampleCount %s',
    (sampleCount) => {
      const result = optimizeLoadouts({
        equipment: [plane('fighter', { antiAir: 12, radius: 7, role: 'fighter' })],
        baseCount: 1,
        targetRadius: 7,
        enemy: detailedEnemy(),
        simulationOptions: { sampleCount },
      });

      expect(result.search).toEqual(expect.objectContaining({
        status: 'invalid_input',
        provenOptimal: false,
      }));
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_SAMPLE_COUNT' }),
      ]));
    },
  );

  test.each([1, 3])('returns invalid_input for %s separate enemy fleets', (fleetCount) => {
    const enemyFleets = Array.from({ length: fleetCount }, () => detailedEnemy());
    const result = optimizeLoadouts({
      equipment: [plane('fighter', { antiAir: 12, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemyFleets,
      simulationOptions: { dispatchMode: 'separate', sampleCount: 2 },
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'invalid_input',
      provenOptimal: false,
    }));
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_SEPARATE_ENEMY_FLEETS' }),
    ]));
  });

  test('accounts for detailed simulation samples and skips a leaf atomically when short', () => {
    const options = lockedDetailedOptions(4);
    const short = optimizeLoadouts({ ...options, simulationWorkBudget: 3 });
    const exact = optimizeLoadouts({ ...options, simulationWorkBudget: 4 });

    expect(short.results).toEqual([]);
    expect(short.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      provenOptimal: false,
      simulationSamplesEvaluated: 0,
      simulationBudget: 3,
    }));
    expect(exact.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
      simulationSamplesEvaluated: 4,
      simulationBudget: 4,
    }));
  });

  test('completes the unique detailed terminal at exact node budget and exhausts at one less', () => {
    const options = { ...lockedDetailedOptions(2), simulationWorkBudget: 2 };
    const exact = optimizeLoadouts({ ...options, nodeBudget: 2 });
    const short = optimizeLoadouts({ ...options, nodeBudget: 1 });

    expect(exact.search).toEqual(expect.objectContaining({
      status: 'optimal',
      nodesExplored: 2,
      provenOptimal: true,
      simulationSamplesEvaluated: 2,
    }));
    expect(short.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      nodesExplored: 1,
      provenOptimal: false,
      simulationSamplesEvaluated: 0,
    }));
  });

  test('bounds default detailed work for a one-base eight-item inventory', () => {
    const result = optimizeLoadouts({
      equipment: distinctFighters(8),
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      maxResults: 1,
    });

    expect(Number.isFinite(result.search.simulationBudget)).toBe(true);
    expect(result.search.simulationSamplesEvaluated).toBeLessThanOrEqual(
      result.search.simulationBudget,
    );
    expect(result.search.status).toBe('budget_exhausted');
    expect(result.search.provenOptimal).toBe(false);
  });

  test('returns invalid_input for invalid detailed enemy slots', () => {
    const result = optimizeLoadouts({
      equipment: [plane('fighter', { antiAir: 12, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemy: {
        mode: 'detailed',
        slots: [{
          instanceId: 'enemy-1',
          name: 'Invalid enemy',
          sortieAntiAir: 10,
          currentSlot: 19,
          maxSlot: 18,
        }],
      },
      simulationOptions: { seed: 'invalid', sampleCount: 8 },
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'invalid_input',
      provenOptimal: false,
    }));
    expect(result.messages.join(' ')).toMatch(/currentSlot.*maxSlot/i);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'DETAILED_ENEMY_CURRENT_SLOT_EXCEEDS_MAX',
        slotIndex: 0,
      }),
    ]));
  });

  test('fully enumerates and ranks detailed plans by all-wave fulfillment first', () => {
    const fighterPlane = plane('fighter', {
      antiAir: 20,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const attackerPlane = plane('attacker', {
      antiAir: 0,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });
    const options = {
      equipment: [fighterPlane, attackerPlane],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['superiority', 'superiority'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'ranking', sampleCount: 32 },
      nodeBudget: Infinity,
      maxResults: 3,
    };

    const result = optimizeLoadouts(options);
    const reversed = optimizeLoadouts({ ...options, equipment: [...options.equipment].reverse() });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('fighter');
    expect(result.results[0].calculationMode).toBe('detailed');
    expect(result.results[0].simulation.allWaveTargetFulfillmentProbability).toBeGreaterThan(
      result.results[1].simulation.allWaveTargetFulfillmentProbability,
    );
    expect(reversed.results.map((plan) => plan.score))
      .toEqual(result.results.map((plan) => plan.score));
  });

  test('matches an explicit detailed exhaustive ranking with four equipment choices', () => {
    const equipment = distinctFighters(4);
    const common = {
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      simulationOptions: { seed: 'four-way', sampleCount: 8 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 5,
    };
    const production = optimizeLoadouts({
      ...common,
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    });
    const exhaustive = [null, ...equipment].flatMap((item) => optimizeLoadouts({
      ...common,
      maxResults: 1,
      lockedBases: [{ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort(comparePlansForSort);

    expect(production.search.status).toBe('optimal');
    expect(production.results.map((plan) => plan.canonicalKey))
      .toEqual(exhaustive.map((plan) => plan.canonicalKey));
  });

  test('honors a finite budget before enumerating 45 distinct groups', () => {
    const result = optimizeLoadouts({
      equipment: distinctFighters(45),
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity'],
      nodeBudget: 1,
      maxResults: 1,
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'budget_exhausted',
      provenOptimal: false,
      budget: 1,
    }));
  }, 2000);

  test('streams a complete 45-group search without retaining every candidate', () => {
    const result = optimizeLoadouts({
      equipment: distinctFighters(45),
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 40,
      targetStates: ['parity', 'parity'],
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
  }, 20000);

  test('does not exhaust a budget that ends exactly on the only leaf', () => {
    const fighter = plane('only-locked', { antiAir: 12, radius: 7, role: 'fighter' });
    const result = optimizeLoadouts({
      equipment: [fighter],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 0,
      targetStates: ['supremacy', 'supremacy'],
      lockedBases: [{ slots: [
        { plane: fighter, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      nodeBudget: 2,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      nodesExplored: 2,
      provenOptimal: true,
    }));
  });

  test('reports infeasible only after exhausting the search', () => {
    const result = optimizeLoadouts({
      equipment: [plane('short', { antiAir: 20, radius: 2, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 9,
      enemyAir: 72,
      targetStates: ['parity', 'parity'],
      nodeBudget: Infinity,
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'infeasible',
      provenOptimal: true,
    }));
  });

  test('reports target-air infeasibility when radius is reachable', () => {
    const result = optimizeLoadouts({
      equipment: [plane('reachable-but-weak', { antiAir: 0, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 999,
      targetStates: ['supremacy', 'supremacy'],
      nodeBudget: Infinity,
    });

    expect(result.search.status).toBe('infeasible');
    expect(result.messages).toEqual(['No loadout can satisfy the target air state.']);
  });

  test('does not mislabel global range competition as target-air failure', () => {
    const result = optimizeLoadouts({
      equipment: [
        plane('short-1', { radius: 4, role: 'fighter' }),
        plane('short-2', { radius: 4, role: 'fighter' }),
        plane('only-recon', { radius: 8, role: 'recon', equipType: 49 }),
      ],
      baseCount: 2,
      targetRadius: 6,
      enemyAir: 0,
      targetStates: ['none', 'none', 'none', 'none'],
      nodeBudget: Infinity,
    });

    expect(result.search.status).toBe('infeasible');
    expect(result.messages).toEqual([
      'No loadout can satisfy all range, air, inventory, and lock constraints.',
    ]);
  });

  test('clears exact internal proficiency while finding the minimum visible level', () => {
    const result = optimizeLoadouts({
      equipment: [plane('max-trained-fighter', {
        antiAir: 4,
        radius: 7,
        role: 'fighter',
        proficiency: 7,
        internalProficiency: 120,
      })],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 50,
      targetStates: ['parity', 'parity'],
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.results[0].bases[0].minimumProficiency).toBe(7);
  });

  test('does not truncate the only feasible target-air combination after 72 distractions', () => {
    const distractions = Array.from({ length: 73 }, (_, index) => plane(`damage-${index}`, {
      antiAir: 1,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    }));
    const fighter = plane('only-fighter', {
      antiAir: 8,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });

    const result = optimizeLoadouts({
      equipment: [...distractions, fighter],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 63,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
      nodeBudget: Infinity,
    });

    expect(result.search.status).toBe('optimal');
    expect(result.results[0].bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .toContain('only-fighter');
  }, 20000);
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

/** Creates formula-distinct fighter groups for streaming search probes. */
function distinctFighters(count) {
  return Array.from({ length: count }, (_, index) => plane(`distinct-${index}`, {
    masterId: 1000 + index,
    antiAir: 8 + (index % 5),
    radius: 7,
    role: 'fighter',
  }));
}

/** Creates a detailed enemy fleet for optimizer simulation tests. */
function detailedEnemy() {
  return {
    mode: 'detailed',
    slots: [{
      instanceId: 'enemy-fighter',
      name: 'Enemy fighter',
      sortieAntiAir: 10,
      currentSlot: 18,
      maxSlot: 18,
    }],
  };
}

/** Creates a unique all-locked detailed plan for exact budget tests. */
function lockedDetailedOptions(sampleCount) {
  const fighter = plane('locked-detailed', {
    antiAir: 12,
    radius: 7,
    role: 'fighter',
  });
  return {
    equipment: [fighter],
    baseCount: 1,
    targetRadius: 7,
    enemy: detailedEnemy(),
    lockedBases: [{ slots: [
      { plane: fighter, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
    ] }],
    simulationOptions: { seed: 'exact-budget', sampleCount },
    nodeBudget: Infinity,
    maxResults: 1,
  };
}
