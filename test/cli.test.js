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
});

describe('CLI map scenario hydration', () => {
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
        manualEnemyAir: 42,
        slots: [expect.objectContaining({ equipmentMasterId: 1601 })],
      },
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
      const events = optimizationIo.stdout.text.trim().split(/\r?\n/).map((line) => JSON.parse(line));

      expect(validationCode).toBe(0);
      expect(JSON.parse(validationIo.stdout.text)).toMatchObject({ valid: true });
      expect(optimizationCode).toBe(0);
      expect(events.at(-1)).toMatchObject({
        type: 'completed',
        result: {
          results: [expect.objectContaining({ calculationMode: 'detailed' })],
          search: { provenOptimal: true },
        },
      });
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

function mapDataFixture() {
  return {
    source: 'test',
    cells: {
      patterns: [{ a: 65, n: 'M', l: 0, e: [1], r: [5], d: 'boss', t: 0, f: 1 }],
    },
    master: {
      maps: [{ area: 65, name: '6-5', boss: ['M'] }],
      worlds: [{ world: 6, name: 'World 6' }],
      enemies: [{ id: 1501, name: 'Test carrier', slots: [18], items: [1601] }],
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
