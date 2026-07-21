'use strict';

const fs = require('fs/promises');
const { buildEnemyCatalog } = require('./enemy-catalog');
const { loadMapData } = require('./map-cache');
const { prepareSearch } = require('./optimizer');
const { extractOptimizationPlanes } = require('./poi-data');
const { createPoiClient } = require('./poi-client');
const { runSearchSession } = require('./search-session');

async function runCli(argv, io = process) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'validate') return validateCommand(parsed, io);
    if (parsed.command === 'optimize') return optimizeCommand(parsed, io);
    if (parsed.command === 'enemy' && parsed.positionals[0] === 'search') {
      return enemySearchCommand(parsed, io);
    }
    throw new Error('Usage: lbas-bis <validate|optimize|enemy search> [options]');
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

async function validateCommand(parsed, io) {
  const scenario = await loadScenario(parsed.flags.scenario);
  const options = await hydrateScenario(scenario, parsed.flags.poi);
  const prepared = prepareSearch(options);
  io.stdout.write(`${JSON.stringify({
    valid: prepared.valid,
    message: prepared.message || null,
    errors: prepared.errors || [],
  })}\n`);
  return prepared.valid ? 0 : 1;
}

async function optimizeCommand(parsed, io) {
  const scenario = await loadScenario(parsed.flags.scenario);
  const options = await hydrateScenario(scenario, parsed.flags.poi);
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

async function hydrateScenario(scenario, poiUrl) {
  if (!poiUrl) return scenario;
  const state = await createPoiClient(poiUrl).loadState();
  return {
    ...scenario,
    equipment: extractOptimizationPlanes(state, {
      includeMissing: scenario.candidateMode === 'theoretical' || scenario.includeMissing === true,
      missingCopiesPerMaster: scenario.missingCopiesPerMaster ?? 1,
    }),
  };
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

module.exports = { parseArgs, runCli };
