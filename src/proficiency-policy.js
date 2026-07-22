'use strict';

const PROFICIENCY_MODES = new Set(['lost', 'inventory', 'max']);

/** Normalizes optimizer proficiency assumptions while keeping lost as the default. */
function normalizeOptimizerProficiencyMode(mode) {
  return PROFICIENCY_MODES.has(mode) ? mode : 'lost';
}

/**
 * Returns one aircraft copy under the selected optimizer proficiency assumption.
 * @param {Record<string, any> | null} plane Aircraft instance.
 * @param {string} mode Proficiency assumption.
 * @returns {Record<string, any> | null} Adjusted aircraft copy.
 */
function planeWithOptimizerProficiency(plane, mode) {
  if (!plane) return null;
  const normalizedMode = normalizeOptimizerProficiencyMode(mode);
  if (normalizedMode === 'inventory') return { ...plane };
  return {
    ...plane,
    proficiency: normalizedMode === 'max' ? 7 : 0,
    internalProficiency: undefined,
  };
}

/**
 * Applies one policy consistently to candidate equipment and explicit locked planes.
 * @param {Record<string, any>} input Optimizer or CLI scenario input.
 * @param {string} [mode] Proficiency assumption.
 * @returns {Record<string, any>} Input copy with the selected policy applied.
 */
function applyOptimizerProficiencyPolicy(input = {}, mode = input.optimizerProficiencyMode) {
  const optimizerProficiencyMode = normalizeOptimizerProficiencyMode(mode);
  return {
    ...input,
    optimizerProficiencyMode,
    ...(Array.isArray(input.equipment) ? {
      equipment: input.equipment.map((plane) =>
        planeWithOptimizerProficiency(plane, optimizerProficiencyMode)),
    } : {}),
    lockedBases: (input.lockedBases || []).map((base) => ({
      ...base,
      slots: (base.slots || []).map((slot) => (
        slot && Object.prototype.hasOwnProperty.call(slot, 'plane')
          ? {
              ...slot,
              plane: planeWithOptimizerProficiency(slot.plane, optimizerProficiencyMode),
            }
          : slot
      )),
    })),
  };
}

module.exports = {
  applyOptimizerProficiencyPolicy,
  normalizeOptimizerProficiencyMode,
  planeWithOptimizerProficiency,
};
