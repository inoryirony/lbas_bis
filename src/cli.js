'use strict';

const fs = require('fs/promises');
const { buildEnemyCatalog } = require('./enemy-catalog');
const { loadMapData } = require('./map-cache');
const { buildMapCatalog } = require('./map-catalog');
const { prepareSearch } = require('./optimizer');
const { extractOptimizationPlanes } = require('./poi-data');
const { filterOptimizationEquipment } = require('./equipment-filter');
const { createPoiClient } = require('./poi-client');
const { runSearchSession } = require('./search-session');

/**
 * @param {string[]} argv
 * @param {{stdout: {write(value: string): any}, stderr: {write(value: string): any}}} [io]
 * @param {Record<string, any>} [dependencies]
 */
async function runCli(argv, io = process, dependencies = {}) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'validate') return validateCommand(parsed, io, dependencies);
    if (parsed.command === 'optimize') return optimizeCommand(parsed, io, dependencies);
    if (parsed.command === 'enemy' && parsed.positionals[0] === 'search') {
      return enemySearchCommand(parsed, io);
    }
    throw new Error('Usage: lbas-bis <validate|optimize|enemy search> [options]');
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

async function validateCommand(parsed, io, dependencies) {
  const scenario = await loadScenario(parsed.flags.scenario);
  const options = await hydrateScenario(scenario, parsed.flags.poi, dependencies);
  const prepared = prepareSearch(options);
  io.stdout.write(`${JSON.stringify({
    valid: prepared.valid,
    message: prepared.message || null,
    errors: prepared.errors || [],
  })}\n`);
  return prepared.valid ? 0 : 1;
}

async function optimizeCommand(parsed, io, dependencies) {
  const scenario = await loadScenario(parsed.flags.scenario);
  const options = await hydrateScenario(scenario, parsed.flags.poi, dependencies);
  const { result } = runSearchSession({
    ...options,
    nodeBudget: normalizeExactBudget(options.nodeBudget),
    simulationWorkBudget: normalizeExactBudget(options.simulationWorkBudget),
    onEvent(event) {
      io.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });
  return result.search.provenOptimal ? 0 : result.search.status === 'invalid_input' ? 1 : 2;
}

async function enemySearchCommand(parsed, io) {
  const poiUrl = parsed.flags.poi || 'http://127.0.0.1:17777';
  const state = await createPoiClient(poiUrl).loadState();
  let noro6Master = null;
  try {
    noro6Master = (await loadMapData()).master;
  } catch (_error) {
    // Poi and Navy Album remain usable while offline without a map cache.
  }
  const catalog = buildEnemyCatalog(state, { noro6Master });
  const matches = catalog.search(parsed.flags.name || '').slice(0, 100);
  io.stdout.write(`${JSON.stringify({ total: matches.length, ships: matches })}\n`);
  return 0;
}

async function hydrateScenario(scenario, poiUrl, dependencies = {}) {
  const hydrated = await hydrateMapSelection(
    scenario,
    dependencies.loadMapData || loadMapData,
  );
  if (!poiUrl) return applyEquipmentFilters(hydrated);
  const clientFactory = dependencies.createPoiClient || createPoiClient;
  const extractPlanes = dependencies.extractOptimizationPlanes || extractOptimizationPlanes;
  const state = await clientFactory(poiUrl).loadState();
  const equipment = extractPlanes(state, {
    includeMissing: hydrated.candidateMode === 'theoretical' || hydrated.includeMissing === true,
    missingCopiesPerMaster: hydrated.missingCopiesPerMaster ?? 1,
  });
  return applyEquipmentFilters({
    ...hydrated,
    equipment,
  });
}

function applyEquipmentFilters(scenario) {
  if (!Array.isArray(scenario.equipment)) return scenario;
  return {
    ...scenario,
    equipment: filterOptimizationEquipment(scenario.equipment, {
      excludeCarrierAircraft: scenario.excludeCarrierAircraft === true,
      blacklistedMasterIds: scenario.blacklistedMasterIds,
      lockedInstanceIds: (scenario.lockedBases || []).flatMap((base) =>
        (base?.slots || []).filter((slot) => slot?.locked && slot.plane)
          .map((slot) => slot.plane.instanceId)),
    }),
  };
}

/** Fills missing CLI enemy inputs from one noro6 map formation. */
async function hydrateMapSelection(scenario, loadMapDataImpl) {
  const selection = scenario?.mapSelection;
  if (!selection) return scenario;

  const needsRadius = !hasOwn(scenario, 'targetRadius');
  const hasExplicitEnemy = ['enemy', 'enemySlots', 'enemyAir'].some((key) => hasOwn(scenario, key));
  const needsEnemy = !hasExplicitEnemy;
  if (!needsRadius && !needsEnemy) return scenario;

  const normalized = normalizeMapSelection(selection);
  let mapData;
  try {
    mapData = await loadMapDataImpl();
  } catch (error) {
    throw new Error(
      `Unable to resolve map selection ${normalized.area}/${normalized.node}: ${error.message}`,
    );
  }
  const catalog = buildMapCatalog(mapData);
  const formations = catalog.formations(
    normalized.area,
    normalized.node,
    normalized.difficulty,
  );
  if (!formations.length) {
    throw new Error(
      `No map formation found for area ${normalized.area} node ${normalized.node} ` +
      `difficulty ${normalized.difficulty}.`,
    );
  }
  const formation = formations[normalized.formationIndex];
  if (!formation) {
    throw new Error(
      `Map formation index ${normalized.formationIndex} is unavailable for area ` +
      `${normalized.area} node ${normalized.node} difficulty ${normalized.difficulty}; ` +
      `available indexes are 0-${formations.length - 1}.`,
    );
  }

  const resolved = { ...scenario };
  if (needsRadius) {
    if (!formation.radius.length || formation.radius.some((value) => !Number.isFinite(value))) {
      throw new Error(`Map formation ${formation.id} does not provide a valid target radius.`);
    }
    resolved.targetRadius = Math.max(...formation.radius);
  }
  if (needsEnemy) {
    if (formation.warnings.length) {
      const codes = [...new Set(formation.warnings.map((warning) => warning.code))].join(', ');
      throw new Error(`Map formation ${formation.id} has incomplete enemy data: ${codes}.`);
    }
    resolved.enemyAir = formation.enemyAir;
    resolved.enemySlots = formation.enemySlots.map((slot) => ({ ...slot }));
    resolved.enemy = {
      mode: 'detailed',
      dataSource: 'automatic',
      areaId: formation.area,
      nodeId: formation.node,
      source: formation.source,
      manualEnemyAir: formation.enemyAir,
      ships: formation.ships.map((ship) => ({ ...ship })),
      slots: resolved.enemySlots.map((slot) => ({ ...slot, overridden: false })),
    };
  }
  return resolved;
}

/** Validates and canonicalizes the zero-based map formation selector. */
function normalizeMapSelection(selection) {
  const area = Number(selection.area);
  const node = String(selection.node ?? '').trim();
  const difficulty = Number(selection.difficulty ?? 0);
  const formationIndex = Number(selection.formationIndex ?? 0);
  if (!Number.isInteger(area) || area < 0 || !node) {
    throw new Error('mapSelection.area and mapSelection.node are required.');
  }
  if (!Number.isInteger(difficulty) || difficulty < 0) {
    throw new Error('mapSelection.difficulty must be a nonnegative integer.');
  }
  if (!Number.isInteger(formationIndex) || formationIndex < 0) {
    throw new Error('mapSelection.formationIndex must be a nonnegative integer.');
  }
  return { area, node, difficulty, formationIndex };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

async function loadScenario(filename) {
  if (!filename) throw new Error('--scenario is required.');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

function normalizeExactBudget(value) {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === 'jsonl') {
      flags[key] = true;
    } else {
      flags[key] = rest[index + 1];
      index += 1;
    }
  }
  return { command, flags, positionals };
}

module.exports = { hydrateScenario, parseArgs, runCli };
