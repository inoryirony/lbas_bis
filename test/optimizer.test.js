import { describe, expect, test } from 'vitest';
import optimizer from '../src/optimizer.js';
import scoreModule from '../src/search-score.js';

const { buildStaticSeedCandidates, optimizeLoadouts, prepareSearch } = optimizer;
const { comparePlansForSort } = scoreModule;

describe('LBAS optimizer MVP', () => {
  test('cancels bounded seed generation before enumerating its Pareto pool', () => {
    const prepared = prepareSearch({
      equipment: Array.from({ length: 8 }, (_unused, index) => plane(`cancel-seed-${index}`, {
        antiAir: index,
        radius: 7,
        role: 'attacker',
        torpedo: 20 - index,
        isLandBased: true,
      })),
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['loss', 'loss'],
    });
    let checks = 0;

    const candidates = buildStaticSeedCandidates(
      prepared.baseLocks[0],
      prepared,
      0,
      { isCancelled: () => { checks += 1; return true; } },
    );

    expect(candidates).toEqual([]);
    expect(checks).toBe(1);
  });

  test('prepares one shared fixed-sample random table for every detailed candidate', () => {
    const prepared = prepareSearch({
      equipment: [plane('shared-random', { antiAir: 8, radius: 7, role: 'fighter' })],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity'],
      simulationOptions: { seed: 'shared-random', sampleCount: 8 },
    });

    expect(prepared.valid).toBe(true);
    expect(prepared.simulationOptions.fixedRandom).toEqual(expect.any(Function));
    expect(prepared.simulationOptions.scoreContext).toEqual(expect.objectContaining({
      baseCache: expect.any(Map),
    }));
  });

  test('removes only capacity-covered detailed groups with identical loss behavior', () => {
    const stronger = Array.from({ length: 8 }, (_unused, index) => plane(
      `detailed-dominator-${index}`,
      {
        masterId: 3300 + index,
        torpedo: 20,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      },
    ));
    const ordinaryWeak = plane('detailed-dominated', {
      masterId: 3400,
      torpedo: 5,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    });
    const mislabeledWeak = plane('detailed-dominated-label-mismatch', {
      masterId: 3402,
      torpedo: 5,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const jetWeak = plane('detailed-jet-not-dominated', {
      masterId: 3401,
      torpedo: 5,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
      isJet: true,
    });
    const prepared = prepareSearch({
      equipment: [...stronger, ordinaryWeak, mislabeledWeak, jetWeak],
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['loss', 'loss', 'loss', 'loss'],
      simulationOptions: { seed: 'detailed-dominance', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .not.toContain(ordinaryWeak.instanceId);
    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .not.toContain(mislabeledWeak.instanceId);
    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(jetWeak.instanceId);
    expect(prepared.detailedGroupsRemoved).toBe(2);
  });

  test('does not let a short custom slot dominate a full custom slot', () => {
    const short = Array.from({ length: 4 }, (_unused, index) => plane(
      `short-custom-slot-${index}`,
      {
        masterId: 3600 + index,
        currentSlot: 1,
        torpedo: 15,
        radius: 7,
        role: 'attacker',
      },
    ));
    const full = plane('full-custom-slot', {
      masterId: 9998,
      currentSlot: 18,
      torpedo: 14,
      radius: 7,
      role: 'attacker',
    });
    const prepared = prepareSearch({
      equipment: [...short, full],
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      simulationOptions: { seed: 'custom-slot-dominance', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(full.instanceId);
  });

  test('does not let a short explicit slot size dominate a full explicit slot size', () => {
    const short = Array.from({ length: 4 }, (_unused, index) => plane(
      `short-explicit-slot-${index}`,
      {
        masterId: 3700 + index,
        slotSize: 1,
        torpedo: 15,
        radius: 7,
        role: 'attacker',
      },
    ));
    const full = plane('full-explicit-slot', {
      masterId: 9997,
      slotSize: 18,
      torpedo: 14,
      radius: 7,
      role: 'attacker',
    });
    const prepared = prepareSearch({
      equipment: [...short, full],
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      simulationOptions: { seed: 'explicit-slot-dominance', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(full.instanceId);
  });

  test('removes an equal-damage fighter when full-inventory scarcity is non-worse', () => {
    const stronger = Array.from({ length: 4 }, (_unused, index) => plane(
      `full-inventory-stronger-${index}`,
      { masterId: 3800, antiAir: 12, radius: 7, role: 'fighter' },
    ));
    const weaker = plane('full-inventory-weaker', {
      masterId: 9996,
      antiAir: 5,
      radius: 7,
      role: 'fighter',
    });
    const prepared = prepareSearch({
      equipment: [...stronger, weaker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity'],
      simulationOptions: { seed: 'full-inventory-scarcity', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .not.toContain(weaker.instanceId);
  });

  test('counts locked equivalent copies when comparing detailed scarcity', () => {
    const lockedWeak = plane('locked-scarcity-weak', {
      masterId: 3900,
      antiAir: 5,
      radius: 7,
      role: 'fighter',
    });
    const freeWeak = plane('free-scarcity-weak', {
      masterId: 3900,
      antiAir: 5,
      radius: 7,
      role: 'fighter',
    });
    const freeStrong = plane('free-scarcity-strong', {
      masterId: 1000,
      antiAir: 12,
      radius: 7,
      role: 'fighter',
    });
    const prepared = prepareSearch({
      equipment: [lockedWeak, freeWeak, freeStrong],
      baseCount: 2,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['supremacy', 'supremacy', 'supremacy', 'supremacy'],
      lockedBases: [
        { slots: [
          { plane: lockedWeak, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
        { slots: [
          { locked: false },
          { plane: null, locked: true },
          { plane: null, locked: true },
          { plane: null, locked: true },
        ] },
      ],
      simulationOptions: { seed: 'locked-inventory-scarcity', sampleCount: 1 },
    });

    expect(prepared.groups.flatMap((group) => group.instances.map((item) => item.instanceId)))
      .toContain(freeWeak.instanceId);
  });

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
      nodeBudget: 1000,
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
      optimalityScope: 'model_exact',
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
      optimalityScope: 'fixed_sample',
      evaluationSampleCount: 4,
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

  test('does not spend detailed node budget walking zero-count equipment groups', () => {
    const equipment = Array.from({ length: 80 }, (_unused, index) => plane(
      `sparse-detailed-${index}`,
      {
        masterId: 3000 + index,
        torpedo: 10,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      },
    ));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'sparse-detailed-groups', sampleCount: 1 },
      nodeBudget: 100,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.search.nodesExplored).toBeLessThanOrEqual(100);
  });

  test('does not cap default detailed simulation work before proving optimality', () => {
    const result = optimizeLoadouts({
      equipment: distinctFighters(8),
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      simulationOptions: { seed: 'uncapped-default', sampleCount: 8 },
      maxResults: 1,
    });

    expect(result.search.simulationBudget).toBe(Infinity);
    expect(result.search.status).toBe('optimal');
    expect(result.search.provenOptimal).toBe(true);
  });

  test('prunes detailed branches whose maximum damage cannot beat a perfect incumbent', () => {
    const equipment = [30, 20, 10, 5].map((torpedo, index) => plane(`damage-${index}`, {
      masterId: 2000 + index,
      torpedo,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    }));
    const sampleCount = 8;
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'detailed-damage-bound', sampleCount },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
      simulationSamplesEvaluated: sampleCount,
      candidatesEvaluated: 1,
    }));
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('damage-0');
  });

  test('passes the incumbent into detailed simulation for fixed-sample pruning', () => {
    const equipment = [
      plane('close-damage-high-air', {
        masterId: 2100,
        torpedo: 14,
        antiAir: 12,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      }),
      plane('close-damage-low-air', {
        masterId: 2101,
        torpedo: 14,
        antiAir: 0,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      }),
    ];
    const sampleCount = 32;
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'detailed-simulation-bound', sampleCount },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search.status).toBe('optimal');
    expect(result.search.provenOptimal).toBe(true);
    expect(result.search.simulationSamplesEvaluated).toBeGreaterThanOrEqual(sampleCount);
    expect(result.search.simulationSamplesEvaluated).toBeLessThan(2 * sampleCount);
    expect(result.search.numericScoreEvaluations).toBeGreaterThan(0);
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('close-damage-high-air');
  });

  test('counts seed screening while skipping proof simulation when minimum-loss damage cannot win', () => {
    const equipment = [
      plane('minimum-loss-bound-jet', {
        masterId: 2150,
        torpedo: 14,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
        isJet: true,
        isEscortItem: true,
      }),
      plane('minimum-loss-bound-normal', {
        masterId: 2151,
        torpedo: 14,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      }),
    ];
    const sampleCount = 128;
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'minimum-loss-bound', sampleCount },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
      simulationSamplesEvaluated: 2 * sampleCount,
      numericScoreEvaluations: 2,
      candidatesEvaluated: 1,
    }));
    expect(result.results[0].bases[0].loadout[0].instanceId)
      .toBe('minimum-loss-bound-jet');
  });

  test('reuses per-base detailed damage bounds across global combinations', () => {
    const equipment = Array.from({ length: 6 }, (_unused, index) => plane(
      `cached-damage-bound-${index}`,
      {
        masterId: 2170 + index,
        torpedo: 20 - index,
        radius: 7,
        role: 'attacker',
        isLandBased: true,
      },
    ));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss', 'loss', 'loss'],
      lockedBases: [0, 1].map(() => ({ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] })),
      simulationOptions: { seed: 'cached-damage-bound', sampleCount: 8 },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.search.damageUpperBoundEvaluations).toBe(
      result.search.solverStats.candidatesByBase.reduce((total, count) => total + count, 0),
    );
  });

  test('does not grant a free land-recon modifier to detailed damage bounds', () => {
    const equipment = Array.from({ length: 16 }, (_unused, index) => plane(`plain-${index}`, {
      masterId: 2200 + index,
      torpedo: 30 - index / 10,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    }));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: { mode: 'detailed', slots: [] },
      targetStates: ['loss', 'loss'],
      simulationOptions: { seed: 0, sampleCount: 1 },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.search.damageUpperBoundEvaluations).toBeLessThan(equipment.length);
    expect(result.search.candidatesEvaluated).toBeLessThan(equipment.length);
    expect(result.results[0].bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .toEqual(['plain-0', 'plain-1', 'plain-2', 'plain-3']);
  });

  test('proves a different static optimum when a target equipment bonus applies', () => {
    const strong = plane('strong-unbonused', {
      masterId: 300,
      torpedo: 18,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    });
    const weak = plane('weak-bonused', {
      masterId: 301,
      torpedo: 10,
      radius: 7,
      role: 'attacker',
      isLandBased: true,
    });
    const result = optimizeLoadouts({
      equipment: [strong, weak],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 0,
      targetStates: ['denial', 'denial'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      combatContext: bonusContext(301, 3),
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.results[0].bases[0].loadout[0].instanceId).toBe('weak-bonused');
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

  test('keeps target-feasible detailed plans instead of zero-fulfillment distractions', () => {
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
    expect(result.results[0].simulation.allWaveTargetFulfillmentProbability).toBeGreaterThan(0);
    expect(result.results).toHaveLength(1);
    expect(reversed.results.map((plan) => plan.score))
      .toEqual(result.results.map((plan) => plan.score));
  });

  test('reports detailed target infeasibility after every plan has zero fulfillment', () => {
    const attacker = plane('zero-air-attacker', {
      antiAir: 0,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });

    const result = optimizeLoadouts({
      equipment: [attacker],
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
      simulationOptions: { seed: 'zero-fulfillment', sampleCount: 16 },
      nodeBudget: Infinity,
    });

    expect(result.results).toEqual([]);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'infeasible',
      provenOptimal: true,
    }));
  });

  test('does not retain a later zero-fulfillment plan after finding a feasible plan', () => {
    const fighter = plane('supremacy-fighter', {
      antiAir: 30,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const attacker = plane('parity-attacker', {
      antiAir: 10,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });

    const result = optimizeLoadouts({
      equipment: [fighter, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'supremacy'],
      lockedBases: [{ slots: [
        { locked: false },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
      simulationOptions: { seed: 'late-zero-fulfillment', sampleCount: 16 },
      nodeBudget: Infinity,
      maxResults: 2,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].allWaveTargetFulfillmentProbability).toBeGreaterThan(0);
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

  test('proves detailed rank one through a reusable base frontier', () => {
    const equipment = distinctFighters(4);
    const common = {
      equipment,
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity'],
      simulationOptions: { seed: 'rank-one-frontier', sampleCount: 8 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
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
    const exhaustive = equipment.flatMap((item) => optimizeLoadouts({
      ...common,
      lockedBases: [{ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort(comparePlansForSort);

    expect(production.search).toMatchObject({
      status: 'optimal',
      provenOptimal: true,
      backend: 'detailed-frontier',
    });
    expect(production.results[0].canonicalKey).toBe(exhaustive[0].canonicalKey);
  });

  test('prunes detailed suffixes that cannot share scarce inventory with a viable prefix', () => {
    const scarceAttackers = Array.from({ length: 4 }, (_unused, index) => plane(
      `scarce-detailed-${index}`,
      {
        masterId: 3900,
        antiAir: 16,
        radius: 7,
        role: 'attacker',
        torpedo: 24,
        isLandBased: true,
      },
    ));
    const result = optimizeLoadouts({
      equipment: scarceAttackers,
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['superiority', 'superiority', 'loss', 'loss'],
      simulationOptions: { seed: 'scarce-detailed-inventory-bound', sampleCount: 4 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toMatchObject({
      status: 'optimal',
      provenOptimal: true,
      backend: 'detailed-frontier',
    });
    expect(result.search.solverStats.inventoryCompatibilityPrunes).toBeGreaterThan(0);
    expect(result.search.solverStats.suffixCandidatesEvaluated)
      .toBeLessThan(result.search.solverStats.suffixCandidatesTotal);
    expect(result.search.solverStats.peakRetainedSuffixCandidates).toBeLessThanOrEqual(1);
  });

  test('stops infeasible jet suffixes on a strict fixed-sample incumbent bound', () => {
    const fighters = Array.from({ length: 8 }, (_unused, index) => plane(
      `jet-bound-fighter-${index}`,
      { masterId: 3950, antiAir: 16, radius: 7, role: 'fighter', isLandBased: true },
    ));
    const jets = Array.from({ length: 4 }, (_unused, index) => plane(
      `jet-bound-attacker-${index}`,
      {
        masterId: 3951,
        antiAir: 16,
        radius: 7,
        role: 'attacker',
        torpedo: 40,
        isJet: true,
        isLandBased: true,
      },
    ));
    const result = optimizeLoadouts({
      equipment: [...fighters, ...jets],
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        ...detailedEnemy(),
        stage2Defense: {
          modeled: true,
          byAvoidance: { 0: { fixedLosses: [17], rateFactors: [0] } },
        },
      },
      targetStates: ['superiority', 'superiority', 'superiority', 'superiority'],
      simulationOptions: { seed: 'pj', sampleCount: 32 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
    expect(result.search.solverStats.prefixSimulationBoundPrunes).toBeGreaterThan(0);
    expect(result.search.solverStats.suffixSimulationBoundPrunes).toBeGreaterThan(0);
  });

  test('reports countable progress while proving a two-base detailed optimum', () => {
    const progress = [];
    const result = optimizeLoadouts({
      equipment: distinctFighters(8),
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'countable-progress', sampleCount: 4 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
      onProgress: (snapshot) => progress.push(snapshot),
    });

    expect(result.search.provenOptimal).toBe(true);
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'building_prefix_trajectories',
        completedWork: expect.any(Number),
        totalWork: expect.any(Number),
      }),
      expect.objectContaining({
        phase: 'evaluating_suffix_trajectories',
        completedWork: expect.any(Number),
        totalWork: expect.any(Number),
      }),
    ]));
    expect(progress.filter((snapshot) => snapshot.totalWork != null).every((snapshot) =>
      snapshot.completedWork <= snapshot.totalWork)).toBe(true);
    const suffixProgress = progress.filter((snapshot) =>
      snapshot.phase === 'evaluating_suffix_trajectories');
    expect(suffixProgress.some((snapshot) => snapshot.totalWork == null)).toBe(true);
    expect(suffixProgress.at(-1)).toMatchObject({
      completedWork: result.search.solverStats.suffixCandidatesTotal,
      totalWork: result.search.solverStats.suffixCandidatesTotal,
    });
    expect(result.search.solverStats.prefixTrajectorySimulations)
      .toBeLessThan(result.search.solverStats.prefixCandidatesEvaluated);
    expect(result.search.solverStats.prefixTrajectorySimulations)
      .toBeLessThan(result.search.solverStats.prefixStateSignatureProbes);
    expect(result.search.solverStats.trajectoryKeySerializations)
      .toBeLessThan(result.search.solverStats.prefixCandidatesEvaluated);
    expect(result.search.solverStats.suffixTrajectorySimulations)
      .toBeLessThan(result.search.solverStats.suffixCandidatesEvaluated);
  });

  test('reports seed work before publishing the first detailed incumbent', () => {
    const events = [];
    const result = optimizeLoadouts({
      equipment: distinctFighters(8),
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'seed-progress', sampleCount: 4 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
      onProgress: (snapshot) => events.push({ type: 'progress', ...snapshot }),
      onIncumbent: () => events.push({ type: 'incumbent' }),
    });

    const firstIncumbent = events.findIndex((event) => event.type === 'incumbent');
    expect(result.search.provenOptimal).toBe(true);
    expect(firstIncumbent).toBeGreaterThan(0);
    expect(events.slice(0, firstIncumbent)).toContainEqual(expect.objectContaining({
      type: 'progress',
      phase: 'finding_feasible',
      nodesExplored: expect.any(Number),
    }));
    expect(events.slice(0, firstIncumbent).some((event) => event.nodesExplored > 0)).toBe(true);
  });

  test('publishes a large-inventory incumbent within the bounded heuristic seed budget', () => {
    let cancelled = false;
    let randomCalls = 0;
    let firstIncumbentRandomCalls = null;
    /** @type {{ totalNodesExplored: number } | null} */
    let firstIncumbentProgress = null;
    const equipment = Array.from({ length: 64 }, (_, index) => plane(`seed-tradeoff-${index}`, {
      masterId: 3000 + index,
      antiAir: index + 1,
      torpedo: 64 - index,
      bombing: 64 - index,
      radius: 7,
      isLandBased: true,
      role: 'attacker',
    }));
    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: {
        seed: 'prompt-large-seed',
        sampleCount: 4,
        fixedRandom: () => {
          randomCalls += 1;
          return 0.5;
        },
      },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
      isCancelled: () => cancelled,
      onIncumbent: (_plan, progress) => {
        if (firstIncumbentProgress) return;
        firstIncumbentProgress = progress;
        firstIncumbentRandomCalls = randomCalls;
        cancelled = true;
      },
    });

    expect(firstIncumbentProgress).not.toBeNull();
    if (!firstIncumbentProgress) throw new Error('Expected a feasible incumbent.');
    expect(firstIncumbentProgress.totalNodesExplored).toBeLessThanOrEqual(20000);
    expect(firstIncumbentRandomCalls).toBeLessThanOrEqual(2000);
    expect(result.search).toMatchObject({ status: 'cancelled', provenOptimal: false });
    expect(result.results).toHaveLength(1);
  }, 30000);

  test('does not prune a second-wave target made feasible by first-wave enemy losses', () => {
    const fighter = plane('fighter', {
      antiAir: 20,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const attacker = plane('attacker', {
      antiAir: 10,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });
    const common = {
      equipment: [fighter, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'superiority'],
      simulationOptions: { seed: 's48', sampleCount: 1 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 2,
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
    const exhaustive = [fighter, attacker].flatMap((item) => optimizeLoadouts({
      ...common,
      maxResults: 1,
      lockedBases: [{ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort(comparePlansForSort);

    expect(exhaustive[0].bases[0].loadout[0].instanceId).toBe('attacker');
    expect(production.search).toMatchObject({ status: 'optimal', provenOptimal: true });
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

  test('proves an obvious one-base damage optimum without enumerating every distraction', () => {
    const best = [20, 19, 18, 17].map((torpedo, index) => plane(`best-${index}`, {
      masterId: 2000 + index,
      antiAir: 8,
      radius: 7,
      role: 'attacker',
      torpedo,
      isLandBased: true,
    }));
    const distractions = Array.from({ length: 80 }, (_, index) => plane(`weak-${index}`, {
      masterId: 3000 + index,
      antiAir: 8,
      radius: 7,
      role: 'attacker',
      torpedo: 1 + (index % 5),
      isLandBased: true,
    }));

    const result = optimizeLoadouts({
      equipment: [...distractions, ...best],
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 10,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
      nodeBudget: 2000,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.results[0].bases[0].loadout.filter(Boolean).map((item) => item.instanceId))
      .toEqual(expect.arrayContaining(best.map((item) => item.instanceId)));
  });

  test('proves a two-base scarce-air allocation without walking every zero group', () => {
    const fighters = Array.from({ length: 24 }, (_, index) => plane(`allocation-fighter-${index}`, {
      masterId: 4000 + index,
      antiAir: 10 + (index % 3),
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    }));
    const attackers = Array.from({ length: 24 }, (_, index) => plane(`allocation-attacker-${index}`, {
      masterId: 5000 + index,
      antiAir: 4,
      radius: 7,
      role: 'attacker',
      torpedo: 30 - index,
      isLandBased: true,
    }));

    const result = optimizeLoadouts({
      equipment: [...attackers, ...fighters],
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 180,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
      nodeBudget: Infinity,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
      backend: 'frontier-dp',
    }));
    expect(result.search.solverStats.groupsRemoved).toBeGreaterThan(0);
    expect(result.results[0].bases).toHaveLength(2);
    expect(result.results[0].bases.every((base) => base.fulfilled)).toBe(true);
  });

  test('finds a multi-base seed without spending exact proof nodes', () => {
    const equipment = [
      plane('seed-fighter-1', { antiAir: 14, radius: 7, role: 'fighter' }),
      plane('seed-fighter-2', { antiAir: 13, radius: 7, role: 'fighter' }),
      ...Array.from({ length: 6 }, (_, index) => plane(`seed-attacker-${index}`, {
        antiAir: 4,
        radius: 7,
        role: 'attacker',
        torpedo: 20 - index,
        isLandBased: true,
      })),
    ];
    let cancel = false;

    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemyAir: 120,
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      maxResults: 1,
      nodeBudget: Infinity,
      isCancelled: () => cancel,
      onIncumbent: () => {
        cancel = true;
      },
    });

    expect(result.results[0].fulfilled).toBe(true);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'cancelled',
      provenOptimal: false,
    }));
    expect(result.search.nodesExplored).toBeGreaterThan(0);
  });

  test('detailed frontier keeps a candidate that reaches a stricter second wave after losses', () => {
    const fighter = plane('frontier-second-wave-fighter', {
      antiAir: 20,
      radius: 7,
      role: 'fighter',
      isLandBased: true,
    });
    const attacker = plane('frontier-second-wave-attacker', {
      antiAir: 10,
      radius: 7,
      role: 'attacker',
      torpedo: 20,
      bombing: 20,
      isLandBased: true,
    });
    const common = {
      equipment: [fighter, attacker],
      baseCount: 1,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'superiority'],
      simulationOptions: { seed: 's48', sampleCount: 1 },
      simulationWorkBudget: Infinity,
      nodeBudget: Infinity,
      maxResults: 1,
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
    const exhaustive = [fighter, attacker].flatMap((item) => optimizeLoadouts({
      ...common,
      nodeBudget: 100,
      lockedBases: [{ slots: [
        { plane: item, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
        { plane: null, locked: true },
      ] }],
    }).results).sort(comparePlansForSort);

    expect(production.search).toMatchObject({
      backend: 'detailed-frontier',
      status: 'optimal',
      provenOptimal: true,
    });
    expect(production.results[0].canonicalKey).toBe(exhaustive[0].canonicalKey);
    expect(production.results[0].bases[0].loadout[0].instanceId)
      .toBe('frontier-second-wave-attacker');
  });

  test('emits a detailed multi-base seed before spending exact proof nodes', () => {
    const equipment = [
      plane('detailed-seed-fighter-1', { antiAir: 14, radius: 7, role: 'fighter' }),
      plane('detailed-seed-fighter-2', { antiAir: 13, radius: 7, role: 'fighter' }),
      ...Array.from({ length: 6 }, (_unused, index) => plane(
        `detailed-seed-attacker-${index}`,
        {
          antiAir: 4,
          radius: 7,
          role: 'attacker',
          torpedo: 20 - index,
          isLandBased: true,
        },
      )),
    ];
    let cancel = false;

    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'detailed-seed', sampleCount: 2 },
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      isCancelled: () => cancel,
      onIncumbent: () => {
        cancel = true;
      },
    });

    expect(result.results[0].allWaveTargetFulfillmentProbability).toBeGreaterThan(0);
    expect(result.search).toEqual(expect.objectContaining({
      status: 'cancelled',
      provenOptimal: false,
      nodesExplored: 0,
    }));
  });

  test('derives later-base air constraints from fixed-sample remaining enemy air', () => {
    const equipment = [
      plane('dynamic-air-fighter-1', { antiAir: 14, radius: 7, role: 'fighter' }),
      plane('dynamic-air-fighter-2', { antiAir: 13, radius: 7, role: 'fighter' }),
      ...Array.from({ length: 6 }, (_unused, index) => plane(
        `dynamic-air-attacker-${index}`,
        {
          antiAir: 4,
          radius: 7,
          role: 'attacker',
          torpedo: 20 - index,
          isLandBased: true,
        },
      )),
    ];
    const result = optimizeLoadouts({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: detailedEnemy(),
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'dynamic-air-bound', sampleCount: 8 },
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
      maxResults: 1,
    });

    expect(result.search).toEqual(expect.objectContaining({
      status: 'optimal',
      provenOptimal: true,
    }));
    expect(result.search.dynamicAirBoundEvaluations).toBeGreaterThan(0);
    expect(result.search.prefixDamageBoundEvaluations).toBeGreaterThan(0);
    expect(result.results[0].allWaveTargetFulfillmentProbability).toBe(1);
    expect(result.results[0].bases.some((base) => base.fighterCount > 0)).toBe(true);
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

function bonusContext(masterId, multiplier) {
  return {
    targetTags: ['event-test'],
    multiplierRules: [{
      id: `bonus-${masterId}`,
      enabled: true,
      targetTags: ['event-test'],
      equipmentMasterIds: [masterId],
      equipmentTypes: [],
      group: `bonus-${masterId}`,
      multiplier,
    }],
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
