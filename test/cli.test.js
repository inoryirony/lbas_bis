import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import cliModule from '../src/cli.js';

const { hydrateScenario, runCli: runCliInProcess } = cliModule;

const root = process.cwd();
const cliPath = path.join(root, 'bin', 'lbas-bis.js');
const scenarioPath = path.join(root, 'examples', 'cli-static.json');
const customScenarioPath = path.join(root, 'examples', 'cli-custom-enemy.json');
const multiplierScenarioPath = path.join(root, 'examples', 'cli-custom-multipliers.json');
const proofFixtureNames = [
  'poi-6-4-combat.json',
  'poi-6-5-combat.json',
  'poi-event-high-air-1-combat.json',
  'poi-event-high-air-2-combat.json',
];

describe('headless LBAS CLI', () => {
  test('validates a scenario and streams optimize events as JSON Lines', async () => {
    const validation = await runCli(['validate', '--scenario', scenarioPath]);
    const optimization = await runCli(['optimize', '--scenario', scenarioPath, '--jsonl']);
    const events = optimization.stdout.trim().split(/\r?\n/).map(JSON.parse);

    expect(validation.code).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
    expect(optimization.code).toBe(0);
    expect(events[0]).toMatchObject({ type: 'started' });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: { search: { status: 'optimal', provenOptimal: true } },
    });
  });

  test('accepts a completely custom enemy ship and aircraft slot scenario', async () => {
    const validation = await runCli(['validate', '--scenario', customScenarioPath]);
    const optimization = await runCli(['optimize', '--scenario', customScenarioPath, '--jsonl']);
    const events = optimization.stdout.trim().split(/\r?\n/).map(JSON.parse);

    expect(validation.code).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
    expect(optimization.code).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: {
        results: [expect.objectContaining({ calculationMode: 'detailed' })],
        search: { provenOptimal: true },
      },
    });
  });

  test('proves a custom multiplier-aware optimum from the shared scenario JSON', async () => {
    const validation = await runCli(['validate', '--scenario', multiplierScenarioPath]);
    const optimization = await runCli(['optimize', '--scenario', multiplierScenarioPath, '--jsonl']);
    const events = optimization.stdout.trim().split(/\r?\n/).map(JSON.parse);
    const completed = events.at(-1);

    expect(validation.code).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
    expect(optimization.code).toBe(0);
    expect(completed).toMatchObject({
      type: 'completed',
      result: { search: { status: 'optimal', provenOptimal: true } },
    });
    expect(completed.result.results[0].bases[0].loadout[0].instanceId)
      .toBe('cli-bonused-attacker');
  });

  test('simulates a locked scenario and returns machine-readable real combat results', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lbas-cli-simulate-'));
    const filename = path.join(directory, 'scenario.json');
    const attacker = {
      instanceId: 'cli-sim-attacker',
      masterId: 187,
      name: 'CLI simulation attacker',
      equipType: 47,
      antiAir: 3,
      radius: 9,
      torpedo: 20,
      bombing: 14,
      accuracy: 10,
      proficiency: 0,
      isPlane: true,
      isAttacker: true,
      isLandAttacker: true,
      isLandBased: true,
      role: 'attacker',
    };
    await fs.writeFile(filename, JSON.stringify({
      equipment: [attacker],
      baseCount: 1,
      targetRadius: 7,
      targetStates: ['supremacy', 'supremacy'],
      simulationOptions: { sampleCount: 32, seed: 'cli-simulate' },
      enemy: {
        mode: 'detailed',
        dataSource: 'custom',
        slots: [],
        ships: [{
          id: 'cli-fragile-dd',
          name: 'CLI fragile DD',
          hp: 1,
          armor: 0,
          evasion: 0,
          luck: 0,
          type: 2,
          speed: 10,
          sourceShipIndex: 0,
          fleet: 'main',
          fleetShipIndex: 0,
          isFlagship: true,
        }],
      },
      lockedBases: [{ slots: [
        { instanceId: attacker.instanceId, kind: 'LOCKED_ITEM' },
        { kind: 'LOCKED_EMPTY' },
        { kind: 'LOCKED_EMPTY' },
        { kind: 'LOCKED_EMPTY' },
      ] }],
    }), 'utf8');

    try {
      const output = await runCli(['simulate', '--scenario', filename]);
      const result = JSON.parse(output.stdout);

      expect(output.code).toBe(0);
      expect(result).toMatchObject({
        calculationMode: 'detailed',
        simulation: {
          expectedHpDamage: expect.any(Number),
          expectedSunkCount: expect.any(Number),
        },
      });
      expect(result.simulation.expectedHpDamage).toBeGreaterThan(0);
      expect(result.simulation.expectedSunkCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('ships four deterministic unlimited 4096-sample combat fixture schemas', async () => {
    for (const fixtureName of proofFixtureNames) {
      const scenario = JSON.parse(await fs.readFile(
        path.join(root, 'examples', fixtureName),
        'utf8',
      ));
      expect(scenario).toMatchObject({
        mapSelection: {
          area: expect.any(Number),
          node: expect.any(String),
          difficulty: expect.any(Number),
          formationIndex: expect.any(Number),
        },
        excludeCarrierAircraft: true,
        optimizationObjective: 'combat',
        simulationOptions: {
          sampleCount: 4096,
          seed: expect.any(String),
        },
        nodeBudget: null,
        simulationWorkBudget: null,
      });
    }
  });

  test('models 6-4 with its single sortie base and two waves', async () => {
    const scenario = JSON.parse(await fs.readFile(
      path.join(root, 'examples', 'poi-6-4-combat.json'),
      'utf8',
    ));

    expect(scenario.baseCount).toBe(1);
    expect(scenario.targetStates).toEqual(['superiority', 'superiority']);
  });
});

describe('CLI map scenario hydration', () => {
  test('lists selectable boss formations for AI-assisted scenario creation', async () => {
    const io = memoryIo();
    const code = await runCliInProcess(
      ['map', 'search', '--boss', '--min-air', '40', '--limit', '5'],
      io,
      { loadMapData: async () => mapDataFixture() },
    );

    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.text)).toEqual({
      total: 1,
      formations: [expect.objectContaining({
        area: 65,
        node: 'M',
        difficulty: 0,
        formationIndex: 0,
        enemyAir: 42,
        targetRadius: 5,
        isBoss: true,
      })],
    });
  });

  test('searches normalized Poi equipment across simplified and traditional Chinese', async () => {
    const io = memoryIo();
    const code = await runCliInProcess(
      ['equipment', 'search', '--name', '银河', '--poi', 'http://poi.test'],
      io,
      {
        createPoiClient: () => ({ loadState: async () => ({}) }),
        extractOptimizationPlanes: () => [
          { instanceId: 122197, masterId: 270, name: '東海(九〇一空)', equipType: 47 },
          { instanceId: 50362, masterId: 187, name: '銀河', equipType: 47 },
        ],
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(io.stdout.text)).toEqual({
      total: 1,
      equipment: [expect.objectContaining({
        instanceId: 50362,
        masterId: 187,
        name: '銀河',
      })],
    });
  });

  test('applies candidate filters to equipment embedded in an offline scenario', async () => {
    const hydrated = await hydrateScenario({
      equipment: [
        { instanceId: 'offline-carrier', masterId: 1, equipType: 6 },
        {
          instanceId: 'offline-land',
          masterId: 2,
          equipType: 47,
          proficiency: 7,
          internalProficiency: 120,
        },
      ],
      excludeCarrierAircraft: true,
    }, null);

    expect(hydrated.equipment.map((plane) => plane.instanceId)).toEqual(['offline-land']);
    expect(hydrated.equipment[0]).toMatchObject({
      proficiency: 0,
      internalProficiency: undefined,
    });
  });

  test.each([
    ['inventory', 5, 83],
    ['max', 7, undefined],
  ])('applies the %s proficiency policy to CLI equipment and locked planes', async (
    optimizerProficiencyMode,
    expectedVisible,
    expectedInternal,
  ) => {
    const plane = {
      instanceId: 'policy-plane',
      masterId: 2,
      equipType: 47,
      proficiency: 5,
      internalProficiency: 83,
    };
    const hydrated = await hydrateScenario({
      equipment: [plane],
      optimizerProficiencyMode,
      lockedBases: [{ slots: [{ plane, locked: true }] }],
    }, null);

    expect(hydrated.optimizerProficiencyMode).toBe(optimizerProficiencyMode);
    expect(hydrated.equipment[0]).toMatchObject({
      proficiency: expectedVisible,
      internalProficiency: expectedInternal,
    });
    expect(hydrated.lockedBases[0].slots[0].plane).toMatchObject({
      proficiency: expectedVisible,
      internalProficiency: expectedInternal,
    });
  });

  test('applies explicit candidate filters to Poi equipment before optimization', async () => {
    const hydrated = await hydrateScenario({
      baseCount: 1,
      excludeCarrierAircraft: true,
      blacklistedMasterIds: [3],
      lockedBases: [{ slots: [{
        locked: true,
        plane: { instanceId: 'locked-carrier' },
      }] }],
    }, 'http://poi.test', {
      createPoiClient: () => ({ loadState: async () => ({}) }),
      extractOptimizationPlanes: () => [
        { instanceId: 'locked-carrier', masterId: 1, equipType: 6 },
        { instanceId: 'other-carrier', masterId: 2, equipType: 6 },
        { instanceId: 'blacklisted-land', masterId: 3, equipType: 47 },
        { instanceId: 'ordinary-land', masterId: 4, equipType: 47 },
      ],
    });

    expect(hydrated.equipment.map((plane) => plane.instanceId)).toEqual([
      'locked-carrier',
      'ordinary-land',
    ]);
  });

  test('preserves standard LOCKED_ITEM equipment through candidate filters', async () => {
    const hydrated = await hydrateScenario({
      equipment: [
        { instanceId: 'standard-locked-carrier', masterId: 11, equipType: 6 },
        { instanceId: 'standard-ordinary-land', masterId: 12, equipType: 47 },
      ],
      excludeCarrierAircraft: true,
      lockedBases: [{ slots: [{
        kind: 'LOCKED_ITEM',
        instanceId: 'standard-locked-carrier',
      }] }],
    }, null);

    expect(hydrated.equipment.map((plane) => plane.instanceId)).toEqual([
      'standard-locked-carrier',
      'standard-ordinary-land',
    ]);
  });

  test('prefers cached noro6 equipment metadata for Poi-backed scenarios', async () => {
    const mapLoadOptions = [];

    await hydrateScenario({ baseCount: 1 }, 'http://poi.test', {
      createPoiClient: () => ({ loadState: async () => ({}) }),
      extractOptimizationPlanes: () => [],
      loadMapData: async (options) => {
        mapLoadOptions.push(options);
        return mapDataFixture();
      },
    });

    expect(mapLoadOptions).toEqual([{ preferCache: true }]);
  });

  test('hydrates detailed enemy slots, air power, and radius from a map selection', async () => {
    const hydrated = await hydrateScenario({
      equipment: [],
      baseCount: 1,
      mapSelection: { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    }, null, {
      loadMapData: async () => mapDataFixture(),
    });

    expect(hydrated).toMatchObject({
      targetRadius: 5,
      enemyAir: 42,
      enemySlots: [expect.objectContaining({
        equipmentMasterId: 1601,
        sortieAntiAir: 10,
        currentSlot: 18,
      })],
      enemy: {
        mode: 'detailed',
        dataSource: 'automatic',
        areaId: 65,
        nodeId: 'M',
        battleType: 2,
        formation: 13,
        manualEnemyAir: 42,
        ships: [expect.objectContaining({
          sourceShipIndex: 0,
          fleet: 'main',
          fleetShipIndex: 0,
          isFlagship: true,
          type: 11,
          hp: 350,
          armor: 180,
          speed: 0,
        })],
        slots: [expect.objectContaining({ equipmentMasterId: 1601 })],
      },
    });
  });

  test('hydrates automatic event multipliers from the exact map selection', async () => {
    const hydrated = await hydrateScenario({
      equipment: [],
      baseCount: 1,
      mapSelection: { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
      eventMultiplierCatalog: {
        version: 1,
        entries: [{
          id: 'fixture-6-5',
          selectors: [{ area: 65, node: 'M', difficulty: 0, formationIndex: 0 }],
          targetTags: ['fixture-6-5', 'boss'],
          source: {
            name: 'CLI fixture',
            url: 'https://example.invalid/cli-fixture',
            revision: 'r1',
            checkedAt: '2026-07-23',
          },
          multiplierRules: [{
            id: 'fixture-6-5-attacker',
            label: 'Fixture attacker',
            enabled: true,
            targetTags: ['fixture-6-5'],
            equipmentMasterIds: [301],
            equipmentTypes: [],
            group: 'fixture-6-5-attacker',
            multiplier: 1.18,
            source: 'automatic',
            overridden: false,
          }],
        }],
      },
    }, null, {
      loadMapData: async () => mapDataFixture(),
    });

    expect(hydrated.combatContext).toMatchObject({
      targetTags: ['fixture-6-5', 'boss'],
      automaticTargetTags: ['fixture-6-5', 'boss'],
      multiplierRules: [expect.objectContaining({
        id: 'fixture-6-5-attacker',
        source: 'automatic',
        overridden: false,
        catalogEntryId: 'fixture-6-5',
      })],
    });
  });

  test('enriches Poi-backed map enemies with official evasion and luck', async () => {
    const state = {
      const: {
        $ships: {
          1501: {
            api_id: 1501,
            api_name: 'Test carrier',
            api_stype: 11,
            api_soku: 10,
            api_houk: [55, 55],
            api_luck: [40, 40],
          },
        },
        $shipTypes: { 11: { api_name: 'Carrier' } },
        $equips: {},
      },
    };
    const hydrated = await hydrateScenario({
      baseCount: 1,
      mapSelection: { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
    }, 'http://poi.test', {
      createPoiClient: () => ({ loadState: async () => state }),
      extractOptimizationPlanes: () => [],
      loadMapData: async () => mapDataFixture(),
    });

    expect(hydrated.enemy.ships[0]).toMatchObject({
      id: 1501,
      hp: 350,
      armor: 180,
      evasion: 55,
      luck: 40,
    });
  });

  test('keeps explicit custom enemy fields ahead of a selected map formation', async () => {
    const customSlots = [{
      instanceId: 'custom-slot',
      name: 'Custom slot',
      sortieAntiAir: 7,
      currentSlot: 9,
      maxSlot: 9,
      overridden: true,
    }];
    const customEnemy = {
      mode: 'detailed',
      dataSource: 'custom',
      ships: [{ id: null, custom: true, name: 'Custom carrier', airPower: 21 }],
      slots: customSlots,
    };
    const hydrated = await hydrateScenario({
      equipment: [],
      baseCount: 1,
      mapSelection: { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
      targetRadius: 7,
      enemyAir: 21,
      enemy: customEnemy,
      enemySlots: customSlots,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    }, null, {
      loadMapData: async () => mapDataFixture(),
    });

    expect(hydrated.targetRadius).toBe(7);
    expect(hydrated.enemyAir).toBe(21);
    expect(hydrated.enemy).toBe(customEnemy);
    expect(hydrated.enemySlots).toBe(customSlots);
  });

  test('uses complete custom enemy input when map data is unavailable', async () => {
    const customSlots = [{
      instanceId: 'offline-slot',
      sortieAntiAir: 5,
      currentSlot: 4,
      maxSlot: 4,
    }];
    const hydrated = await hydrateScenario({
      equipment: [],
      baseCount: 1,
      mapSelection: { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
      targetRadius: 6,
      enemyAir: 10,
      enemySlots: customSlots,
      targetStates: ['parity', 'parity'],
      maxResults: 1,
    }, null, {
      loadMapData: async () => { throw new Error('remote and cache unavailable'); },
    });

    expect(hydrated).toMatchObject({ targetRadius: 6, enemyAir: 10 });
    expect(hydrated.enemySlots).toBe(customSlots);
  });

  test('reports selected formation and map-data failures clearly', async () => {
    await expect(hydrateScenario({
      mapSelection: { area: 65, node: 'Missing', difficulty: 0, formationIndex: 0 },
    }, null, {
      loadMapData: async () => mapDataFixture(),
    })).rejects.toThrow('No map formation found for area 65 node Missing difficulty 0');

    await expect(hydrateScenario({
      mapSelection: { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
    }, null, {
      loadMapData: async () => { throw new Error('remote and cache unavailable'); },
    })).rejects.toThrow('Unable to resolve map selection 65/M: remote and cache unavailable');
  });

  test('reports incomplete formation master data before optimizer validation', async () => {
    const data = mapDataFixture();
    data.master.enemies = [];

    await expect(hydrateScenario({
      mapSelection: { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
      targetRadius: 5,
    }, null, {
      loadMapData: async () => data,
    })).rejects.toThrow('has incomplete enemy data: MISSING_NORO6_ENEMY_MASTER');
  });

  test('runs validate and optimize commands with a map-selected scenario', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lbas-cli-map-'));
    const filename = path.join(directory, 'scenario.json');
    await fs.writeFile(filename, JSON.stringify(mapScenarioFixture()), 'utf8');
    const dependencies = { loadMapData: async () => mapDataFixture() };
    const validationIo = memoryIo();
    const optimizationIo = memoryIo();
    const repeatedOptimizationIo = memoryIo();

    try {
      const validationCode = await runCliInProcess(
        ['validate', '--scenario', filename],
        validationIo,
        dependencies,
      );
      const optimizationCode = await runCliInProcess(
        ['optimize', '--scenario', filename, '--jsonl'],
        optimizationIo,
        dependencies,
      );
      const repeatedOptimizationCode = await runCliInProcess(
        ['optimize', '--scenario', filename, '--jsonl'],
        repeatedOptimizationIo,
        dependencies,
      );
      const events = optimizationIo.stdout.text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
      const repeatedEvents = repeatedOptimizationIo.stdout.text.trim()
        .split(/\r?\n/).map((line) => JSON.parse(line));

      expect(validationCode).toBe(0);
      expect(JSON.parse(validationIo.stdout.text)).toMatchObject({ valid: true });
      expect(optimizationCode).toBe(0);
      expect(repeatedOptimizationCode).toBe(0);
      expect(events.at(-1)).toMatchObject({
        type: 'completed',
        result: {
          results: [expect.objectContaining({ calculationMode: 'detailed' })],
          search: { objective: 'combat', provenOptimal: true },
        },
      });
      expect(withoutElapsedMs(repeatedEvents.at(-1).result))
        .toEqual(withoutElapsedMs(events.at(-1).result));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error?.code || 0, stdout, stderr });
    });
  });
}

/** Removes wall-clock measurements before comparing deterministic CLI results. */
function withoutElapsedMs(value) {
  return JSON.parse(JSON.stringify(value, (key, nestedValue) => (
    key === 'elapsedMs' ? undefined : nestedValue
  )));
}

function mapDataFixture() {
  return {
    source: 'test',
    cells: {
      patterns: [{ a: 65, n: 'M', l: 0, e: [1], r: [5], d: 'boss', t: 2, f: 13 }],
    },
    master: {
      maps: [{ area: 65, name: '6-5', boss: ['M'] }],
      worlds: [{ world: 6, name: 'World 6' }],
      enemies: [{
        id: 1501,
        name: 'Test carrier',
        type: 11,
        hp: 350,
        armor: 180,
        speed: 0,
        slots: [18],
        items: [1601],
      }],
      items: [{ id: 1601, name: 'Test fighter', type: 6, antiAir: 10 }],
    },
  };
}

function mapScenarioFixture() {
  return {
    equipment: [{
      instanceId: 'map-cli-fighter',
      masterId: 801,
      name: 'Map CLI fighter',
      equipType: 48,
      antiAir: 12,
      radius: 7,
      improvement: 0,
      proficiency: 0,
      isPlane: true,
      isFighter: true,
      isLandBased: true,
      role: 'fighter',
    }],
    baseCount: 1,
    mapSelection: { area: 65, node: 'M', difficulty: 0, formationIndex: 0 },
    simulationOptions: { sampleCount: 16, seed: 7 },
    optimizationObjective: 'combat',
    targetStates: ['parity', 'parity'],
    lockedBases: [{ slots: [
      { instanceId: 'map-cli-fighter', kind: 'LOCKED_ITEM' },
      { kind: 'LOCKED_EMPTY' },
      { kind: 'LOCKED_EMPTY' },
      { kind: 'LOCKED_EMPTY' },
    ] }],
    nodeBudget: null,
    simulationWorkBudget: null,
    maxResults: 1,
  };
}

function memoryIo() {
  const stdout = { text: '', write(value) { this.text += value; } };
  const stderr = { text: '', write(value) { this.text += value; } };
  return { stdout, stderr };
}
