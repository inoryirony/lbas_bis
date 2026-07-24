'use strict';

const PT_IDS = new Set([1637, 1638, 1639, 1640, 2192, 2193, 2194]);
const SPECIAL_RULES = Object.freeze([
  rule('anchorage-water-demon', [1557, 1586], 0.35, 3, 1.7, 1.1),
  rule('anchorage-water-demon-provisional', [1620], 0.35, 3, 1.7, 1,
    'provisional_simulator_assumption'),
  rule('supply-depot-princess', range(1653, 1658), 0.4, 3.5, 1.7),
  rule('summer-princess-a', range(1665, 1667), 0.5, 2.5, 1.6, 1.06),
  rule('summer-princess-b', range(1668, 1672), 0.4, 2, 1.5),
  rule('summer-princess-c', range(1696, 1698), 0.4, 1.8, 1.5),
  rule('summer-princess-d', range(1699, 1704), 0.5, 1.5, 1.2),
  rule('summer-harbour', [...range(2023, 2028), ...range(2243, 2246)], 0.5, 1.5, 1.2),
  rule('anchorage-repair-princess', [1751], 0.4, 1.7, 1.3),
  rule('new-anchorage-a', [2178, 2179, 2196, 2197], 0.5, 2.2, 1.5, 1.06),
  rule('new-anchorage-b', [2180, 2181], 0.5, 1.6, 1.3, 1.15),
  rule('new-anchorage-c', range(2188, 2191), 0.4, 1.8, 1.4),
]);
const RULE_BY_ID = new Map(SPECIAL_RULES.flatMap((entry) =>
  entry.enemyIds.map((id) => [id, entry])));

/** Builds one immutable special-enemy multiplier rule. */
function rule(
  id,
  enemyIds,
  probability,
  highMultiplier,
  lowMultiplier,
  accuracyMultiplier = 1,
  confidence = 'established_simulator_assumption',
) {
  return Object.freeze({
    id,
    enemyIds: Object.freeze(enemyIds),
    probability,
    highMultiplier,
    lowMultiplier,
    accuracyMultiplier,
    confidence,
  });
}

/** Expands one inclusive integer range for the locked simulator table. */
function range(first, last) {
  return Array.from({ length: last - first + 1 }, (_unused, index) => first + index);
}

/**
 * Adds versioned PT and special-airstrike metadata to one enemy ship copy.
 * @template {Record<string, any>} T
 * @param {T} ship
 * @returns {T & {
 *   isPT: boolean,
 *   specialAirstrikeRuleId: any,
 *   airstrikeRuleSource: Record<string, any> | null,
 * }}
 */
function decorateEnemyAirstrikeRules(ship) {
  const id = enemyMasterId(ship);
  const isPT = ship.isPT === true || PT_IDS.has(id);
  const profile = isPT ? ptProfile() : RULE_BY_ID.get(id) || null;
  /** @type {T & {
   *   isPT: boolean,
   *   specialAirstrikeRuleId: any,
   *   airstrikeRuleSource: Record<string, any> | null,
   * }} */
  const decorated = {
    ...ship,
    isPT,
    specialAirstrikeRuleId: ship.specialAirstrikeRuleId ?? profile?.id ?? null,
    airstrikeRuleSource: profile ? {
      repository: 'KC3Kai/kancolle-replay',
      revision: 'ec3094c5ba57e289d2716a75ab5f4dee31f1b07f',
      path: 'js/kcsim.js',
      confidence: profile.confidence,
    } : null,
  };
  return decorated;
}

/** Returns the randomized post-cap profile for one known or explicitly tagged target. */
function specialAirstrikeProfile(target = {}) {
  if (target.specialAirstrikeProfile) return target.specialAirstrikeProfile;
  if (target.isPT === true || PT_IDS.has(enemyMasterId(target))) return ptProfile();
  return RULE_BY_ID.get(enemyMasterId(target)) || null;
}

/** Returns the locked LBAS accuracy product for one special enemy target. */
function specialAirstrikeAccuracyMultiplier(target = {}) {
  const profileMultiplier = RULE_BY_ID.get(enemyMasterId(target))?.accuracyMultiplier ?? 1;
  const summerBattleshipMultiplier = target.isSummerBB === true ? 1.1 : 1;
  return profileMultiplier * summerBattleshipMultiplier;
}

/** Returns the fixed-revision PT imp post-cap profile. */
function ptProfile() {
  return {
    id: 'pt',
    probability: 0.4,
    highMultiplier: 0.7,
    lowMultiplier: 0.4,
    confidence: 'established_simulator_assumption',
  };
}

/** Resolves a target's API enemy master ID without using its display name. */
function enemyMasterId(target) {
  const id = Number(target?.masterId ?? target?.id);
  return Number.isFinite(id) ? id : 0;
}

module.exports = {
  PT_IDS,
  SPECIAL_RULES,
  decorateEnemyAirstrikeRules,
  specialAirstrikeAccuracyMultiplier,
  specialAirstrikeProfile,
};
