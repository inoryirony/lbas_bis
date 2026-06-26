'use strict';

const { normalizeSimulatorState } = require('./simulator-state');

function applyPlanToSimulator(state, plan) {
  const normalized = normalizeSimulatorState(state);
  return normalizeSimulatorState({
    ...normalized,
    bases: normalized.bases.map((base, baseIndex) => {
      const plannedLoadout = plan?.bases?.[baseIndex]?.loadout || [];
      return {
        ...base,
        slots: base.slots.map((slot, slotIndex) => {
          if (slot.locked) {
            return slot;
          }
          return {
            ...slot,
            plane: plannedLoadout[slotIndex] || null,
            proficiency: null,
            improvement: null,
          };
        }),
      };
    }),
  });
}

module.exports = {
  applyPlanToSimulator,
};
