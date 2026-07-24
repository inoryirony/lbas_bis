'use strict';

const {
  normalizeCombatContext,
  validateCombatContext,
} = require('./combat-context');

const EMPTY_EVENT_MULTIPLIER_CATALOG = Object.freeze({ version: 1, entries: Object.freeze([]) });

/**
 * Resolves catalog entries for one exact map formation and merges user overrides.
 * @param {Record<string, any>} selection Exact map formation selector.
 * @param {Record<string, any>} [existingContext] Existing custom and automatic rules.
 * @param {Record<string, any>} [catalog] Versioned data-only multiplier catalog.
 * @returns {Record<string, any>} Canonical combat context plus validation metadata.
 */
function resolveEventCombatContext(
  selection,
  existingContext = {},
  catalog = EMPTY_EVENT_MULTIPLIER_CATALOG,
) {
  const catalogValidation = validateEventMultiplierCatalog(catalog);
  const existing = normalizeCombatContext(existingContext);
  if (!catalogValidation.valid) {
    return {
      valid: false,
      errors: catalogValidation.errors,
      context: existing,
      matchedEntryIds: [],
    };
  }
  const selectionValidation = validateMapSelection(selection);
  if (!selectionValidation.valid) {
    return {
      valid: false,
      errors: selectionValidation.errors,
      context: existing,
      matchedEntryIds: [],
    };
  }

  const normalizedSelection = selectionValidation.selection;
  const matchedEntries = catalogValidation.entries.filter((entry) =>
    entry.selectors.some((selector) => selectorsEqual(selector, normalizedSelection)));
  const automaticTargetTags = unique(matchedEntries.flatMap((entry) => entry.targetTags));
  const previousAutomaticTags = new Set(existing.automaticTargetTags || []);
  const manualTargetTags = existing.targetTags.filter((tag) => !previousAutomaticTags.has(tag));
  const customRules = existing.multiplierRules.filter((rule) =>
    rule.source !== 'automatic' || rule.overridden === true);
  const customRuleIds = new Set(customRules.map((rule) => rule.id));
  const automaticRules = matchedEntries.flatMap((entry) =>
    entry.multiplierRules.map((rule) => ({
      ...rule,
      source: 'automatic',
      overridden: false,
      catalogEntryId: entry.id,
      catalogSource: { ...entry.source },
    })))
    .filter((rule) => !customRuleIds.has(rule.id));
  const context = normalizeCombatContext({
    targetTags: unique([...manualTargetTags, ...automaticTargetTags]),
    automaticTargetTags,
    multiplierRules: [...customRules, ...automaticRules],
  });
  const combatValidation = validateCombatContext(context);
  return {
    valid: combatValidation.valid,
    errors: combatValidation.errors,
    context: combatValidation.context,
    matchedEntryIds: matchedEntries.map((entry) => entry.id),
  };
}

/**
 * Validates and canonicalizes a versioned data-only event multiplier catalog.
 * @param {Record<string, any>} [catalog] Untrusted catalog JSON.
 * @returns {Record<string, any>} Validation errors and normalized entries.
 */
function validateEventMultiplierCatalog(catalog = EMPTY_EVENT_MULTIPLIER_CATALOG) {
  const errors = [];
  if (!isPlainObject(catalog) || Number(catalog.version) !== 1 || !Array.isArray(catalog.entries)) {
    return {
      valid: false,
      errors: [{ field: 'catalog', message: 'Event multiplier catalog version 1 requires entries.' }],
      entries: [],
    };
  }
  const seenIds = new Set();
  const entries = catalog.entries.map((entry, entryIndex) =>
    normalizeCatalogEntry(entry, entryIndex, errors, seenIds));
  return { valid: errors.length === 0, errors, entries };
}

/** Normalizes one catalog entry while collecting every actionable validation error. */
function normalizeCatalogEntry(entry, entryIndex, errors, seenIds) {
  const id = normalizeString(entry?.id);
  if (!id || seenIds.has(id)) {
    errors.push({
      entryIndex,
      field: 'id',
      message: id ? 'Catalog entry IDs must be unique.' : 'Catalog entry ID is required.',
    });
  }
  seenIds.add(id);
  const selectors = Array.isArray(entry?.selectors)
    ? entry.selectors.map((selector) => normalizeSelector(selector))
    : [];
  if (!selectors.length || selectors.some((selector) => selector == null)) {
    errors.push({
      entryIndex,
      field: 'selectors',
      message: 'Catalog selectors require area, node, difficulty, and formationIndex.',
    });
  }
  const source = normalizeSource(entry?.source);
  if (!source) {
    errors.push({
      entryIndex,
      field: 'source',
      message: 'Catalog source requires name, url, revision, and checkedAt.',
    });
  }
  const targetTags = normalizeTags(entry?.targetTags);
  const rawRules = Array.isArray(entry?.multiplierRules) ? entry.multiplierRules : [];
  const combatValidation = validateCombatContext({ targetTags, multiplierRules: rawRules });
  if (!rawRules.length || !combatValidation.valid) {
    errors.push({
      entryIndex,
      field: 'multiplierRules',
      message: rawRules.length
        ? combatValidation.errors[0].message
        : 'Catalog entries require at least one multiplier rule.',
    });
  }
  return {
    id,
    selectors: selectors.filter(Boolean),
    targetTags,
    source: source || {},
    multiplierRules: combatValidation.context.multiplierRules,
  };
}

/** Validates one map selection supplied to the resolver. */
function validateMapSelection(selection) {
  const normalized = normalizeSelector(selection);
  return normalized
    ? { valid: true, errors: [], selection: normalized }
    : {
        valid: false,
        errors: [{
          field: 'mapSelection',
          message: 'Map selection requires area, node, difficulty, and formationIndex.',
        }],
        selection: null,
      };
}

/** Converts one exact selector to canonical numeric and string fields. */
function normalizeSelector(selector) {
  const area = Number(selector?.area);
  const node = normalizeString(selector?.node);
  const difficulty = Number(selector?.difficulty);
  const formationIndex = Number(selector?.formationIndex);
  if (!Number.isInteger(area) || area < 0 || !node ||
      !Number.isInteger(difficulty) || difficulty < 0 ||
      !Number.isInteger(formationIndex) || formationIndex < 0) return null;
  return { area, node, difficulty, formationIndex };
}

/** Returns true only for identical canonical formation selectors. */
function selectorsEqual(left, right) {
  return left.area === right.area &&
    left.node === right.node &&
    left.difficulty === right.difficulty &&
    left.formationIndex === right.formationIndex;
}

/** Normalizes required inspectable source metadata without interpreting its claims. */
function normalizeSource(source) {
  if (!isPlainObject(source)) return null;
  const normalized = {
    name: normalizeString(source.name),
    url: normalizeString(source.url),
    revision: normalizeString(source.revision),
    checkedAt: normalizeString(source.checkedAt),
  };
  return Object.values(normalized).every(Boolean) ? normalized : null;
}

/** Normalizes tag arrays for catalog metadata. */
function normalizeTags(values) {
  return unique((Array.isArray(values) ? values : [])
    .map(normalizeString)
    .filter(Boolean));
}

/** Trims a string value or returns the canonical empty string. */
function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Returns a stable unique copy of one primitive list. */
function unique(values) {
  return [...new Set(values)];
}

/** Distinguishes plain records from arrays and primitive values. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  EMPTY_EVENT_MULTIPLIER_CATALOG,
  resolveEventCombatContext,
  validateEventMultiplierCatalog,
};
