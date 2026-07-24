'use strict';

/** Validates and canonicalizes global equipment-tag selectors. */
function validateEquipmentTagConstraints(value = {}) {
  if (value == null) value = {};
  if (!isPlainObject(value)) {
    return invalid('Equipment tag selectors must be an object.');
  }
  for (const field of ['requiredAll', 'excludedAny']) {
    if (value[field] != null && !isValidTagArray(value[field])) {
      return invalid(
        `Equipment tag selectors.${field} must contain only non-empty strings.`,
      );
    }
  }
  return {
    valid: true,
    constraints: {
      requiredAll: normalizeTags(value.requiredAll),
      excludedAny: normalizeTags(value.excludedAny),
    },
    errors: [],
  };
}

/** Returns whether one equipment item satisfies every normalized tag selector. */
function equipmentMatchesTagConstraints(plane, constraints = {}) {
  const tags = new Set(normalizeTags(plane?.tags));
  const requiredAll = constraints.requiredAll || [];
  const excludedAny = constraints.excludedAny || [];
  return requiredAll.every((tag) => tags.has(tag)) &&
    excludedAny.every((tag) => !tags.has(tag));
}

/** Normalizes a possibly absent tag list to unique trimmed strings. */
function normalizeTags(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean))];
}

/** Checks that a selector is an array of non-empty string tokens. */
function isValidTagArray(values) {
  return Array.isArray(values) && values.every((value) =>
    typeof value === 'string' && value.trim().length > 0);
}

/** Distinguishes plain selector records from arrays and other values. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Builds the shared structured validation result for one selector error. */
function invalid(message) {
  return {
    valid: false,
    constraints: { requiredAll: [], excludedAny: [] },
    errors: [{ field: 'equipmentTagConstraints', message }],
  };
}

module.exports = {
  equipmentMatchesTagConstraints,
  validateEquipmentTagConstraints,
};
