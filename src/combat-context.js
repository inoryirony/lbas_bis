'use strict';

/** Normalizes target tags and equipment multiplier rules without mutating input. */
function normalizeCombatContext(context = {}) {
  const normalized = {
    targetTags: normalizeTags(context.targetTags),
    multiplierRules: Array.isArray(context.multiplierRules)
      ? context.multiplierRules.map(normalizeMultiplierRule)
      : [],
  };
  if (Array.isArray(context.automaticTargetTags)) {
    normalized.automaticTargetTags = normalizeTags(context.automaticTargetTags);
  }
  return normalized;
}

/** Returns a canonical combat context together with explicit validation errors. */
function validateCombatContext(context = {}) {
  const normalized = normalizeCombatContext(context);
  const rawRules = Array.isArray(context.multiplierRules) ? context.multiplierRules : [];
  const errors = [];
  const seenIds = new Set();

  normalized.multiplierRules.forEach((rule, ruleIndex) => {
    const rawRule = rawRules[ruleIndex] || {};
    if (!rule.id) {
      errors.push({ ruleIndex, field: 'id', message: 'Rule ID is required.' });
    } else if (seenIds.has(rule.id)) {
      errors.push({ ruleIndex, field: 'id', message: 'Rule ID must be unique.' });
    }
    seenIds.add(rule.id);
    if (!rule.equipmentMasterIds.length && !rule.equipmentTypes.length) {
      errors.push({
        ruleIndex,
        field: 'equipmentSelectors',
        message: 'At least one equipment master ID or equipment type is required.',
      });
    }
    for (const field of ['equipmentMasterIds', 'equipmentTypes']) {
      if (hasInvalidPositiveInteger(rawRule[field])) {
        errors.push({
          ruleIndex,
          field,
          message: 'Equipment selectors must contain only positive integers.',
        });
      }
    }
    if (!Number.isFinite(rule.multiplier) || rule.multiplier <= 0) {
      errors.push({
        ruleIndex,
        field: 'multiplier',
        message: 'Multiplier must be a finite number greater than zero.',
      });
    }
  });

  return { valid: errors.length === 0, errors, context: normalized };
}

/** Calculates the deterministic post-cap multiplier for one equipment item. */
function equipmentDamageMultiplier(plane, context = {}) {
  const targetTags = new Set(context.targetTags || []);
  const strongestByGroup = new Map();
  for (const rule of context.multiplierRules || []) {
    if (!rule.enabled || !ruleMatchesPlane(rule, plane, targetTags)) continue;
    const group = rule.group || rule.id;
    const current = strongestByGroup.get(group);
    if (current === undefined || rule.multiplier > current) {
      strongestByGroup.set(group, rule.multiplier);
    }
  }
  return [...strongestByGroup.values()].reduce((total, multiplier) =>
    total * multiplier, 1);
}

/** Converts one untrusted rule to its canonical plain-object representation. */
function normalizeMultiplierRule(rule = {}) {
  const source = rule.source === 'automatic' ? 'automatic' : 'custom';
  const id = normalizeString(rule.id);
  const normalized = {
    id,
    label: normalizeString(rule.label),
    enabled: rule.enabled !== false,
    targetTags: normalizeTags(rule.targetTags),
    equipmentMasterIds: normalizePositiveIntegers(rule.equipmentMasterIds),
    equipmentTypes: normalizePositiveIntegers(rule.equipmentTypes),
    group: normalizeString(rule.group) || id,
    multiplier: Number(rule.multiplier),
    source,
    overridden: rule.overridden === true || source === 'custom',
  };
  const catalogEntryId = normalizeString(rule.catalogEntryId);
  if (catalogEntryId) normalized.catalogEntryId = catalogEntryId;
  if (isPlainObject(rule.catalogSource)) {
    normalized.catalogSource = {
      name: normalizeString(rule.catalogSource.name),
      url: normalizeString(rule.catalogSource.url),
      revision: normalizeString(rule.catalogSource.revision),
      checkedAt: normalizeString(rule.catalogSource.checkedAt),
    };
  }
  return normalized;
}

/** Checks tag and equipment selectors for one already-normalized rule. */
function ruleMatchesPlane(rule, plane, targetTags) {
  if (!rule.targetTags.every((tag) => targetTags.has(tag))) return false;
  const masterId = Number(plane?.masterId);
  const equipType = Number(plane?.equipType);
  return rule.equipmentMasterIds.includes(masterId) ||
    rule.equipmentTypes.includes(equipType);
}

function normalizeTags(values) {
  return unique((Array.isArray(values) ? values : [])
    .map(normalizeString)
    .filter(Boolean));
}

function normalizePositiveIntegers(values) {
  return unique((Array.isArray(values) ? values : [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0));
}

function hasInvalidPositiveInteger(values) {
  return Array.isArray(values) && values.some((value) => {
    const number = Number(value);
    return !Number.isInteger(number) || number <= 0;
  });
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  return [...new Set(values)];
}

/** Distinguishes plain metadata records from arrays and primitive values. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  equipmentDamageMultiplier,
  normalizeCombatContext,
  validateCombatContext,
};
