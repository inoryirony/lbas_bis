'use strict';

const INVALID_SLOT_LIMITATION = 'INVALID_DETAILED_ENEMY_SLOTS';

/**
 * Validates detailed enemy slots and applies defaults only to blank values.
 * Blank sortie anti-air defaults to 0. Blank current/max slots copy the other
 * valid slot value, or both default to 0 when both are blank.
 */
function validateAndNormalizeDetailedEnemySlots(slots = [], options = {}) {
  const pathPrefix = options.pathPrefix || 'enemy.slots';
  const errors = [];
  const source = slots == null ? [] : slots;
  if (!Array.isArray(source)) {
    return {
      valid: false,
      slots: [],
      errors: [validationError({
        code: 'INVALID_DETAILED_ENEMY_SLOTS',
        path: pathPrefix,
        slotIndex: null,
        field: 'slots',
        value: source,
        message: `${pathPrefix} must be an array.`,
      })],
    };
  }

  const normalized = source.filter(Boolean).map((slot, slotIndex) => {
    const sortie = parseOptionalNumber(slot.sortieAntiAir, slotIndex, 'sortieAntiAir', pathPrefix, errors);
    const current = parseOptionalNumber(slot.currentSlot, slotIndex, 'currentSlot', pathPrefix, errors);
    const maximum = parseOptionalNumber(slot.maxSlot, slotIndex, 'maxSlot', pathPrefix, errors);
    const currentSlot = current.present
      ? current.value
      : maximum.valid && maximum.present ? maximum.value : 0;
    const maxSlot = maximum.present
      ? maximum.value
      : current.valid && current.present ? current.value : 0;

    if (current.valid && maximum.valid && currentSlot > maxSlot) {
      errors.push(validationError({
        code: 'DETAILED_ENEMY_CURRENT_SLOT_EXCEEDS_MAX',
        path: `${pathPrefix}[${slotIndex}].currentSlot`,
        slotIndex,
        field: 'currentSlot',
        value: slot.currentSlot,
        message: `${pathPrefix}[${slotIndex}].currentSlot must not exceed maxSlot.`,
      }));
    }

    return {
      instanceId: slot.instanceId ?? `enemy-slot-${slotIndex}`,
      name: typeof slot.name === 'string' ? slot.name : '',
      sortieAntiAir: sortie.present ? sortie.value : 0,
      currentSlot,
      maxSlot,
    };
  });

  return { valid: errors.length === 0, slots: normalized, errors };
}

/** Creates an exception for direct simulation APIs that cannot return invalid summaries. */
function detailedEnemyValidationError(errors) {
  return Object.assign(
    new TypeError(errors[0]?.message || 'Detailed enemy slots are invalid.'),
    { code: INVALID_SLOT_LIMITATION, errors },
  );
}

/** Parses one optional finite nonnegative number while retaining blank-state metadata. */
function parseOptionalNumber(value, slotIndex, field, pathPrefix, errors) {
  if (isBlank(value)) return { present: false, valid: true, value: 0 };
  const numeric = typeof value === 'number' || typeof value === 'string'
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    errors.push(validationError({
      code: 'INVALID_DETAILED_ENEMY_SLOT_VALUE',
      path: `${pathPrefix}[${slotIndex}].${field}`,
      slotIndex,
      field,
      value,
      message: `${pathPrefix}[${slotIndex}].${field} must be a finite nonnegative number.`,
    }));
    return { present: true, valid: false, value: 0 };
  }
  return { present: true, valid: true, value: numeric };
}

/** Returns whether a UI field is intentionally blank rather than invalid. */
function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

/** Returns a detached structured validation error. */
function validationError(error) {
  return { ...error };
}

module.exports = {
  INVALID_SLOT_LIMITATION,
  detailedEnemyValidationError,
  validateAndNormalizeDetailedEnemySlots,
};
