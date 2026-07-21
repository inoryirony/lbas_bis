'use strict';

const DEFAULT_SAMPLE_COUNT = 1000;
const MAX_SAMPLE_COUNT = 10000;
const INVALID_SIMULATION_LIMITATION = 'INVALID_SIMULATION_OPTIONS';

/** Validates a strict positive integer sample count while defaulting blank input. */
function validateSampleCount(value, options = {}) {
  const path = options.path || 'sampleCount';
  if (isBlank(value)) {
    return { valid: true, sampleCount: DEFAULT_SAMPLE_COUNT, errors: [] };
  }
  const number = typeof value === 'number' || typeof value === 'string'
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(number) || !Number.isInteger(number) ||
      number <= 0 || number > MAX_SAMPLE_COUNT) {
    const error = {
      code: 'INVALID_SAMPLE_COUNT',
      path,
      field: 'sampleCount',
      value,
      message: `${path} must be an integer from 1 to ${MAX_SAMPLE_COUNT}.`,
    };
    return { valid: false, sampleCount: null, errors: [error] };
  }
  return { valid: true, sampleCount: number, errors: [] };
}

/** Returns a valid sample count or throws a structured RangeError for direct APIs. */
function requireSampleCount(value, options = {}) {
  const validation = validateSampleCount(value, options);
  if (validation.valid) return validation.sampleCount;
  throw Object.assign(new RangeError(validation.errors[0].message), {
    code: INVALID_SIMULATION_LIMITATION,
    errors: validation.errors,
  });
}

/** Returns whether an editable numeric field has no explicit value. */
function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

module.exports = {
  DEFAULT_SAMPLE_COUNT,
  INVALID_SIMULATION_LIMITATION,
  MAX_SAMPLE_COUNT,
  requireSampleCount,
  validateSampleCount,
};
