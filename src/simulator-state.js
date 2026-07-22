'use strict';

const {
  detailedEnemyValidationError,
  validateAndNormalizeDetailedEnemySlots,
} = require('./enemy-slots');
const {
  DEFAULT_SAMPLE_COUNT,
  validateSampleCount,
} = require('./simulation-options');

const SLOTS_PER_BASE = 4;
const WAVES_PER_BASE = 2;
const MIN_BASES = 1;
const MAX_BASES = 3;
const DEFAULT_TARGET_RADIUS = 7;
const DEFAULT_ENEMY_AIR = 72;
const DEFAULT_TARGET_STATE = 'parity';
const STATE_OPTIONS = new Set(['denial', 'parity', 'superiority', 'supremacy']);
const BASE_NAMES = ['第一基地', '第二基地', '第三基地'];

/** Creates a normalized simulator state with legacy static-enemy defaults. */
function createEmptySimulatorState(baseCount = 1) {
  return normalizeSimulatorState({
    targetRadius: DEFAULT_TARGET_RADIUS,
    baseCount,
    candidateMode: 'owned',
    enemy: createDefaultEnemy(),
    simulationOptions: createDefaultSimulationOptions(),
    bases: [],
    waves: [],
  });
}

/** Normalizes legacy and detailed simulator shapes into one immutable state. */
function normalizeSimulatorState(state = {}) {
  const baseCount = clampBaseCount(state.baseCount);
  return {
    targetRadius: positiveNumber(state.targetRadius, DEFAULT_TARGET_RADIUS),
    baseCount,
    candidateMode: state.candidateMode === 'theoretical' ? 'theoretical' : 'owned',
    enemy: normalizeEnemy(state.enemy),
    simulationOptions: normalizeSimulationOptions(state.simulationOptions || state.simulation),
    bases: normalizeBases(state.bases, baseCount),
    waves: normalizeWaves(state.waves, baseCount),
  };
}

function setBaseCount(state, baseCount) {
  return normalizeSimulatorState({
    ...state,
    baseCount,
  });
}

function setBaseSlot(state, baseIndex, slotIndex, slotPatch) {
  const normalized = normalizeSimulatorState(state);
  if (!isValidBaseSlot(baseIndex, slotIndex, normalized.baseCount)) {
    return normalized;
  }

  const bases = normalized.bases.map((base, currentBaseIndex) => {
    if (currentBaseIndex !== baseIndex) {
      return base;
    }
    return {
      ...base,
      slots: base.slots.map((slot, currentSlotIndex) =>
        currentSlotIndex === slotIndex
          ? { ...slot, ...slotPatch }
          : slot,
      ),
    };
  });

  return normalizeSimulatorState({
    ...normalized,
    bases,
  });
}

/** Toggles a slot lock without treating an explicitly empty slot as unlocked. */
function setSlotLock(state, baseIndex, slotIndex, locked) {
  return setBaseSlot(state, baseIndex, slotIndex, { locked: Boolean(locked) });
}

function setWaveTarget(state, waveIndex, targetState) {
  const normalized = normalizeSimulatorState(state);
  if (waveIndex < 0 || waveIndex >= normalized.waves.length) {
    return normalized;
  }

  const waves = normalized.waves.map((wave, currentIndex) =>
    currentIndex === waveIndex
      ? { ...wave, targetState: normalizeTargetState(targetState) }
      : wave,
  );

  return normalizeSimulatorState({
    ...normalized,
    waves,
  });
}

/** Exports legacy slot objects while preserving locked null as a real constraint. */
function simulatorToOptimizerInput(state) {
  const normalized = normalizeSimulatorState(state);
  const input = {
    baseCount: normalized.baseCount,
    targetRadius: normalized.targetRadius,
    enemyAir: normalized.enemy.enemyAir,
    targetStates: normalized.waves.map((wave) => wave.targetState),
    lockedBases: normalized.bases.map((base) => ({
      slots: base.slots.map((slot) => ({
        plane: slot.locked ? slot.plane : null,
        locked: Boolean(slot.locked),
      })),
    })),
  };
  if (normalized.enemy.mode !== 'detailed') return input;
  return {
    ...input,
    enemy: normalized.enemy,
    enemySlots: normalized.enemy.slots,
    simulationOptions: normalized.simulationOptions,
  };
}

/** Creates the backward-compatible manual total-air enemy shape. */
function createDefaultEnemy() {
  return {
    mode: 'manual',
    dataSource: 'custom',
    enemyAir: DEFAULT_ENEMY_AIR,
    manualEnemyAir: DEFAULT_ENEMY_AIR,
    areaId: null,
    nodeId: null,
    isAirRaidCell: false,
    slots: [],
    ships: Array.from({ length: 6 }, (_, index) => ({
      id: null,
      name: '',
      airPower: index === 0 ? DEFAULT_ENEMY_AIR : 0,
    })),
  };
}

/** Normalizes manual total air or detailed aircraft slots without mutating input. */
function normalizeEnemy(enemy = {}) {
  const defaults = createDefaultEnemy();
  const hasExplicitMode = enemy.mode === 'manual' || enemy.mode === 'detailed';
  const detailed = enemy.mode === 'detailed' || (!hasExplicitMode && (
    Array.isArray(enemy.enemySlots) ||
    (Array.isArray(enemy.slots) && enemy.slots.length > 0)
  ));
  const slotValidation = validateAndNormalizeDetailedEnemySlots(
    enemy.slots || enemy.enemySlots,
  );
  const slots = slotValidation.valid
    ? slotValidation.slots
    : preserveDetailedSlotInputs(enemy.slots || enemy.enemySlots);
  const shipCount = Math.max(6, Array.isArray(enemy.ships) ? enemy.ships.length : 0);
  const ships = Array.from({ length: shipCount }, (_, index) => {
    const fallback = defaults.ships[index] || { id: null, name: '', airPower: 0 };
    const ship = enemy.ships?.[index] || fallback;
    return {
      ...ship,
      id: ship.id ?? null,
      name: ship.name || '',
      airPower: nonNegativeNumber(ship.airPower, fallback.airPower),
    };
  });
  const summedAir = ships.reduce((total, ship) => total + ship.airPower, 0);
  const enemyAir = enemy.enemyAir == null
    ? summedAir
    : nonNegativeNumber(enemy.enemyAir, DEFAULT_ENEMY_AIR);
  const manualEnemyAir = detailed
    ? nonNegativeNumber(enemy.manualEnemyAir, enemyAir)
    : enemyAir;

  const detailedAir = slotValidation.valid
    ? slots.reduce(
      (total, slot) => total + Math.floor(slot.sortieAntiAir * Math.sqrt(slot.currentSlot)),
      0,
    )
    : 0;
  return {
    mode: detailed ? 'detailed' : enemy.mode || 'manual',
    dataSource: enemy.dataSource === 'automatic' ? 'automatic' : 'custom',
    enemyAir: detailed ? detailedAir : manualEnemyAir,
    manualEnemyAir,
    areaId: enemy.areaId ?? null,
    nodeId: enemy.nodeId ?? null,
    source: enemy.source ?? null,
    isAirRaidCell: enemy.isAirRaidCell === true,
    ships,
    slots,
    ...(detailed ? {
      valid: slotValidation.valid,
      errors: slotValidation.errors,
    } : {}),
  };
}

/** Preserves invalid UI inputs so repeated normalization cannot erase errors. */
function preserveDetailedSlotInputs(slots = []) {
  if (!Array.isArray(slots)) return slots;
  return slots.flatMap((slot, index) => slot ? [{
    ...slot,
    instanceId: slot.instanceId ?? `enemy-slot-${index}`,
    name: typeof slot.name === 'string' ? slot.name : '',
    sortieAntiAir: slot.sortieAntiAir,
    currentSlot: slot.currentSlot,
    maxSlot: slot.maxSlot,
  }] : []);
}

/** Strictly normalizes valid detailed enemy slots and throws for explicit bad values. */
function normalizeDetailedEnemySlots(slots = []) {
  const result = validateAndNormalizeDetailedEnemySlots(slots);
  if (!result.valid) throw detailedEnemyValidationError(result.errors);
  return result.slots;
}

/** Replaces one detailed enemy slot immutably. */
function setDetailedEnemySlot(state, slotIndex, slotPatch) {
  const normalized = normalizeSimulatorState(state);
  if (slotIndex < 0 || slotIndex >= normalized.enemy.slots.length) return normalized;
  const slots = normalized.enemy.slots.map((slot, index) =>
    index === slotIndex ? { ...slot, ...slotPatch } : slot);
  return normalizeSimulatorState({
    ...normalized,
    enemy: { ...normalized.enemy, mode: 'detailed', slots },
  });
}

/** Appends one detailed enemy slot immutably and switches the enemy to detailed mode. */
function addDetailedEnemySlot(state, slot) {
  const normalized = normalizeSimulatorState(state);
  return normalizeSimulatorState({
    ...normalized,
    enemy: {
      ...normalized.enemy,
      mode: 'detailed',
      slots: [...normalized.enemy.slots, slot],
    },
  });
}

/** Removes one detailed enemy slot immutably. */
function removeDetailedEnemySlot(state, slotIndex) {
  const normalized = normalizeSimulatorState(state);
  if (slotIndex < 0 || slotIndex >= normalized.enemy.slots.length) return normalized;
  return normalizeSimulatorState({
    ...normalized,
    enemy: {
      ...normalized.enemy,
      mode: 'detailed',
      slots: normalized.enemy.slots.filter((_slot, index) => index !== slotIndex),
    },
  });
}

/** Returns stable simulation defaults while preserving an explicit zero-like seed. */
function createDefaultSimulationOptions() {
  return { seed: 0, sampleCount: DEFAULT_SAMPLE_COUNT, dispatchMode: 'concentrated' };
}

/** Normalizes Monte Carlo controls used by simulator and optimizer callers. */
function normalizeSimulationOptions(options = {}) {
  const defaults = createDefaultSimulationOptions();
  const validation = validateSampleCount(options?.sampleCount, {
    path: 'simulationOptions.sampleCount',
  });
  return {
    seed: options?.seed ?? defaults.seed,
    sampleCount: validation.valid ? validation.sampleCount : options?.sampleCount,
    dispatchMode: options?.dispatchMode === 'separate' ? 'separate' : 'concentrated',
    ...(validation.valid ? {} : {
      valid: false,
      errors: validation.errors,
    }),
  };
}

function normalizeBases(bases = [], baseCount) {
  return Array.from({ length: baseCount }, (_, baseIndex) => {
    const base = bases[baseIndex] || {};
    return {
      name: base.name || BASE_NAMES[baseIndex] || `Base ${baseIndex + 1}`,
      slots: normalizeSlots(base.slots),
    };
  });
}

/** Normalizes four simulator slots without erasing explicit null locks. */
function normalizeSlots(slots = []) {
  return Array.from({ length: SLOTS_PER_BASE }, (_, slotIndex) => {
    const slot = slots[slotIndex] || {};
    return {
      plane: slot.plane ?? null,
      locked: Boolean(slot.locked),
      proficiency: slot.proficiency ?? null,
      improvement: slot.improvement ?? null,
    };
  });
}

function normalizeWaves(waves = [], baseCount) {
  return Array.from({ length: baseCount * WAVES_PER_BASE }, (_, waveIndex) => {
    const wave = waves[waveIndex] || {};
    return {
      baseIndex: Math.floor(waveIndex / WAVES_PER_BASE),
      waveInBase: waveIndex % WAVES_PER_BASE,
      targetState: normalizeTargetState(wave.targetState),
    };
  });
}

function normalizeTargetState(targetState) {
  return STATE_OPTIONS.has(targetState) ? targetState : DEFAULT_TARGET_STATE;
}

function isValidBaseSlot(baseIndex, slotIndex, baseCount) {
  return (
    baseIndex >= 0 &&
    baseIndex < baseCount &&
    slotIndex >= 0 &&
    slotIndex < SLOTS_PER_BASE
  );
}

function clampBaseCount(value) {
  const count = Number(value) || MIN_BASES;
  return Math.max(MIN_BASES, Math.min(MAX_BASES, Math.floor(count)));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

module.exports = {
  SLOTS_PER_BASE,
  WAVES_PER_BASE,
  addDetailedEnemySlot,
  createEmptySimulatorState,
  normalizeDetailedEnemySlots,
  normalizeSimulatorState,
  normalizeSimulationOptions,
  removeDetailedEnemySlot,
  setBaseCount,
  setBaseSlot,
  setDetailedEnemySlot,
  setSlotLock,
  setWaveTarget,
  simulatorToOptimizerInput,
};
