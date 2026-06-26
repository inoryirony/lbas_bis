'use strict';

const SLOTS_PER_BASE = 4;
const WAVES_PER_BASE = 2;
const MIN_BASES = 1;
const MAX_BASES = 3;
const DEFAULT_TARGET_RADIUS = 7;
const DEFAULT_ENEMY_AIR = 72;
const DEFAULT_TARGET_STATE = 'parity';
const STATE_OPTIONS = new Set(['denial', 'parity', 'superiority', 'supremacy']);
const BASE_NAMES = ['第一基地', '第二基地', '第三基地'];

function createEmptySimulatorState(baseCount = 1) {
  return normalizeSimulatorState({
    targetRadius: DEFAULT_TARGET_RADIUS,
    baseCount,
    candidateMode: 'owned',
    enemy: createDefaultEnemy(),
    bases: [],
    waves: [],
  });
}

function normalizeSimulatorState(state = {}) {
  const baseCount = clampBaseCount(state.baseCount);
  return {
    targetRadius: positiveNumber(state.targetRadius, DEFAULT_TARGET_RADIUS),
    baseCount,
    candidateMode: state.candidateMode === 'theoretical' ? 'theoretical' : 'owned',
    enemy: normalizeEnemy(state.enemy),
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

function simulatorToOptimizerInput(state) {
  const normalized = normalizeSimulatorState(state);
  return {
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
}

function createDefaultEnemy() {
  return {
    mode: 'manual',
    enemyAir: DEFAULT_ENEMY_AIR,
    areaId: null,
    nodeId: null,
    ships: Array.from({ length: 6 }, (_, index) => ({
      id: null,
      name: '',
      airPower: index === 0 ? DEFAULT_ENEMY_AIR : 0,
    })),
  };
}

function normalizeEnemy(enemy = {}) {
  const defaults = createDefaultEnemy();
  const ships = Array.from({ length: 6 }, (_, index) => {
    const ship = enemy.ships?.[index] || defaults.ships[index];
    return {
      id: ship.id ?? null,
      name: ship.name || '',
      airPower: nonNegativeNumber(ship.airPower, defaults.ships[index].airPower),
    };
  });
  const summedAir = ships.reduce((total, ship) => total + ship.airPower, 0);
  const enemyAir = enemy.enemyAir == null
    ? summedAir
    : nonNegativeNumber(enemy.enemyAir, DEFAULT_ENEMY_AIR);

  return {
    mode: enemy.mode || 'manual',
    enemyAir,
    areaId: enemy.areaId ?? null,
    nodeId: enemy.nodeId ?? null,
    ships,
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

function normalizeSlots(slots = []) {
  return Array.from({ length: SLOTS_PER_BASE }, (_, slotIndex) => {
    const slot = slots[slotIndex] || {};
    return {
      plane: slot.plane || null,
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
  createEmptySimulatorState,
  normalizeSimulatorState,
  setBaseCount,
  setBaseSlot,
  setSlotLock,
  setWaveTarget,
  simulatorToOptimizerInput,
};
