'use strict';

const { sify } = require('chinese-conv');

const COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/** Normalizes user-visible equipment text for matching across width, case, and Chinese script. */
function normalizeEquipmentQuery(value) {
  return sify(String(value ?? '').normalize('NFKC').toLocaleLowerCase()).trim();
}

/** Orders aircraft by API equipment type and then by their visible identity. */
function sortEquipmentChoices(equipment = []) {
  return [...equipment].sort((left, right) =>
    (Number(left.equipType) || 0) - (Number(right.equipType) || 0) ||
    COLLATOR.compare(String(left.name || ''), String(right.name || '')) ||
    (Number(right.improvement) || 0) - (Number(left.improvement) || 0) ||
    (Number(right.proficiency) || 0) - (Number(left.proficiency) || 0) ||
    COLLATOR.compare(String(left.instanceId), String(right.instanceId)));
}

/** Returns sorted matches ranked by exact, prefix, substring, and fuzzy-subsequence quality. */
function rankEquipmentMatches(equipment = [], query = '') {
  const needle = normalizeEquipmentQuery(query);
  if (!needle) return sortEquipmentChoices(equipment);
  const compactNeedle = compactSearchText(needle);
  return equipment
    .map((plane) => ({ plane, rank: matchRank(plane, needle, compactNeedle) }))
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || compareEquipment(left.plane, right.plane))
    .map(({ plane }) => plane);
}

function matchRank(plane, needle, compactNeedle) {
  const values = [
    plane.name,
    plane.typeName,
    plane.masterId,
    plane.instanceId,
  ].map(normalizeEquipmentQuery).filter(Boolean);
  let best = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const compact = compactSearchText(value);
    if (value === needle || compact === compactNeedle) best = Math.min(best, 0);
    else if (value.startsWith(needle) || compact.startsWith(compactNeedle)) best = Math.min(best, 1);
    else if (value.includes(needle) || compact.includes(compactNeedle)) best = Math.min(best, 2);
    else if (isOrderedSubsequence(compactNeedle, compact)) best = Math.min(best, 3);
  }
  return best;
}

function compareEquipment(left, right) {
  return (Number(left.equipType) || 0) - (Number(right.equipType) || 0) ||
    COLLATOR.compare(String(left.name || ''), String(right.name || '')) ||
    (Number(right.improvement) || 0) - (Number(left.improvement) || 0) ||
    (Number(right.proficiency) || 0) - (Number(left.proficiency) || 0) ||
    COLLATOR.compare(String(left.instanceId), String(right.instanceId));
}

function compactSearchText(value) {
  return String(value || '').replace(/[\p{P}\p{S}\s]+/gu, '');
}

function isOrderedSubsequence(needle, value) {
  if (!needle) return true;
  let cursor = 0;
  for (const character of value) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

module.exports = {
  normalizeEquipmentQuery,
  rankEquipmentMatches,
  sortEquipmentChoices,
};
