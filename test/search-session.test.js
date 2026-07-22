import { describe, expect, test } from 'vitest';
import searchSessionModule from '../src/search-session.js';

const { runSearchSession } = searchSessionModule;

describe('LBAS search session', () => {
  test('finds a fighter-feasible incumbent before proving the 365-air four-wave optimum', () => {
    const { events, result } = runSearchSession(detailedParityScenario());
    const incumbent = events.find((event) => event.type === 'incumbent');

    expect(incumbent).toBeDefined();
    expect(incumbent.plan.bases.flatMap((base) => base.loadout).filter(Boolean))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ isFighter: true }),
      ]));
    expect(incumbent.plan.allWaveTargetFulfillmentProbability).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'started',
      'phase_changed',
      'progress',
      'incumbent',
      'completed',
    ]));
    expect(events.filter((event) => event.type === 'phase_changed').map((event) => event.phase))
      .toEqual(expect.arrayContaining(['improving', 'proving_optimal']));
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.at(-1).nodesExplored).toBe(result.search.nodesExplored);
    expect(progress.every((event, index) =>
      index === 0 || event.nodesExplored >= progress[index - 1].nodesExplored)).toBe(true);
    expect(progress.every((event) => Number.isFinite(event.totalNodesExplored))).toBe(true);
    expect(progress.at(-1).totalNodesExplored).toBeGreaterThanOrEqual(
      result.search.nodesExplored,
    );
    expect(progress.every((event, index) =>
      index === 0 || event.totalNodesExplored >= progress[index - 1].totalNodesExplored))
      .toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: {
        search: {
          status: 'optimal',
          provenOptimal: true,
        },
      },
    });
    expect(result.search).toMatchObject({ status: 'optimal', provenOptimal: true });
  }, 30000);

  test('cancellation preserves the incumbent without claiming optimality', () => {
    let cancelled = false;
    const { events, result } = runSearchSession({
      ...smallDetailedScenario(),
      isCancelled: () => cancelled,
      onIncumbent: () => {
        cancelled = true;
      },
    });

    expect(events.some((event) => event.type === 'incumbent')).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'cancelled',
      result: {
        search: { status: 'cancelled', provenOptimal: false },
        results: [expect.any(Object)],
      },
    });
    expect(result.search).toMatchObject({ status: 'cancelled', provenOptimal: false });
  });

  test('first feasible incumbent keeps an attacker when distinct fighters already cover parity', () => {
    let cancelled = false;
    const equipment = [
      ...Array.from({ length: 12 }, (_, index) => plane(`distinct-fighter-${index}`, {
        masterId: 400 + index,
        antiAir: 20,
        role: 'fighter',
      })),
      ...Array.from({ length: 8 }, (_, index) => plane(`distinct-attacker-${index}`, {
        masterId: 500 + index,
        antiAir: 1,
        torpedo: 20,
        bombing: 20,
        role: 'attacker',
      })),
    ];
    const { events } = runSearchSession({
      equipment,
      baseCount: 2,
      targetRadius: 7,
      enemy: {
        mode: 'detailed',
        slots: [{
          instanceId: 'enemy-air-300',
          name: '300 air fixture',
          sortieAntiAir: 300,
          currentSlot: 1,
          maxSlot: 1,
        }],
      },
      targetStates: ['parity', 'parity', 'parity', 'parity'],
      simulationOptions: { seed: 'distinct-fighter-order', sampleCount: 4 },
      nodeBudget: Infinity,
      maxResults: 1,
      isCancelled: () => cancelled,
      onIncumbent: () => {
        cancelled = true;
      },
    });
    const incumbent = events.find((event) => event.type === 'incumbent');

    expect(incumbent).toBeDefined();
    expect(incumbent.plan.totalDamagePower).toBeGreaterThan(0);
    expect(incumbent.plan.bases.flatMap((base) => base.loadout).filter(Boolean))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ isAttacker: true }),
      ]));
  });
});

function detailedParityScenario() {
  const fighters = Array.from({ length: 6 }, (_, index) => plane(`fighter-${index}`, {
    masterId: 100,
    antiAir: 20,
    role: 'fighter',
  }));
  const attackers = Array.from({ length: 8 }, (_, index) => plane(`attacker-${index}`, {
    masterId: 200 + index,
    antiAir: 1,
    torpedo: 20,
    bombing: 20,
    role: 'attacker',
  }));
  return {
    equipment: [...attackers, ...fighters],
    baseCount: 2,
    targetRadius: 7,
    enemy: {
      mode: 'detailed',
      slots: [{
        instanceId: 'enemy-air-365',
        name: '365 air fixture',
        sortieAntiAir: 365,
        currentSlot: 1,
        maxSlot: 1,
      }],
    },
    targetStates: ['parity', 'parity', 'parity', 'parity'],
    simulationOptions: { seed: '365-parity', sampleCount: 64 },
    nodeBudget: Infinity,
    maxResults: 3,
  };
}

function smallDetailedScenario() {
  return {
    equipment: [
      plane('small-fighter', { masterId: 301, antiAir: 12, role: 'fighter' }),
      plane('small-attacker', {
        masterId: 302,
        antiAir: 1,
        torpedo: 14,
        role: 'attacker',
      }),
    ],
    baseCount: 1,
    targetRadius: 7,
    enemy: {
      mode: 'detailed',
      slots: [{
        instanceId: 'small-enemy',
        name: 'small enemy',
        sortieAntiAir: 40,
        currentSlot: 1,
        maxSlot: 1,
      }],
    },
    targetStates: ['parity', 'parity'],
    lockedBases: [{ slots: [
      { locked: false },
      { plane: null, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
    ] }],
    simulationOptions: { seed: 'cancel', sampleCount: 4 },
    nodeBudget: Infinity,
    maxResults: 1,
  };
}

function plane(instanceId, overrides = {}) {
  const role = overrides.role || 'attacker';
  return {
    instanceId,
    masterId: overrides.masterId,
    name: instanceId,
    equipType: role === 'fighter' ? 48 : 47,
    iconType: 0,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 7,
    torpedo: 0,
    bombing: 0,
    asw: 0,
    scout: 0,
    improvement: 0,
    proficiency: 0,
    isPlane: true,
    isFighter: role === 'fighter',
    isAttacker: role === 'attacker',
    isLandAttacker: role === 'attacker',
    isLandBased: true,
    role,
    ...overrides,
  };
}
