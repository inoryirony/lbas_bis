# LBAS Stateful Combat Resolution Design

## Status and Scope

The current detailed optimizer simulates air-state changes and aircraft losses,
but its `expectedDamage` field is an additive attack-power proxy. It is not
expected HP damage because it does not yet resolve targets, hits, criticals,
armor, scratch damage, HP, or sinking.

This document freezes the evidence boundary and implementation order for the
stateful combat model. Accuracy is more important than speed. A heuristic may
produce an incumbent or traversal order, but it may not delete candidates or
claim fixed-sample optimality without a valid upper bound for this model.

The six-agent algorithm and modeling synthesis, including accepted performance
work and postponed hypotheses, is in
`2026-07-23-lbas-autoresearch-synthesis.md`.

## Evidence Levels

Every formula record must carry `formulaVersion`, `source`, and one confidence
level:

- `confirmed`: independently documented game formula or matching current
  implementations with direct evidence.
- `established_simulator_assumption`: empirical rule used by mature simulators;
  useful, but not presented as an official constant.
- `unresolved`: conflicting sources or insufficient evidence. It stays behind
  an explicit option or TODO and cannot silently select one interpretation.

The type 53 attack constant is unresolved: current noro6 uses the aerial-combat
`+25` path while KC3/kancolle-replay retains a `+20` land-attacker path in some
code. Add cross-source fixtures before choosing a default.

## Required Enemy Model

Map adaptation must retain, per ship:

- master ID, name, ship type, speed, source fleet (main or escort), and flagship;
- max/current HP, armor, land/PT/submarine/special-target tags;
- aircraft slots and Stage 2 defense inputs;
- source URL, source revision/date, map, node, difficulty, and formation index.

Manual enemies may override every field. Missing combat fields must produce a
visible limitation and fall back to the legacy attack-power proxy, not invented
HP or armor values.

## Attack Resolution

Each attack-capable aircraft slot resolves independently in game order:

1. Build eligible living targets from surface/submarine/land attack rules.
2. Select main or escort fleet, then one eligible ship. The established
   combined-fleet assumption is main `45%`, escort `55%`; flagship protection
   and empty-fleet fallbacks need explicit fixtures.
3. Compute target-specific pre-cap and post-cap power. Land targets use bombing
   where required. Apply B-25, 65th Sentai, Hs293/Fritz-X/guided-bomb and other
   DD/CL/CA/BB/CV/supply/land/PT rules only after the target is known.
4. Resolve hit probability from base accuracy, equipment accuracy,
   proficiency, target/fleet evasion, and target-type special modifiers.
5. Resolve critical probability and the confirmed critical damage multiplier:
   `1.5 * (1 + floor(sqrt(internalProficiency) + C) / 100)`.
6. On a hit, resolve armor using the established random armor term
   `0.7 * armor + 0.6 * floor(U * armor)`. A non-penetrating hit enters the
   current-HP scratch-damage distribution instead of becoming zero damage.
7. Subtract HP immediately. Remove sunk ships before the next aircraft chooses
   a target.

Ordinary contact and jet-assault damage are later phases, but their random
coordinates must be reserved now so adding them does not reorder existing CRN
draws.

## Accuracy and Evasion Assumptions

Hit probability is versioned separately from power formulas. The first
compatibility implementation may reproduce kancolle-replay's empirical LBAS
model:

- base hit term `0.90`;
- equipment accuracy contribution `0.07 * equipmentAccuracy`;
- proficiency hit and critical contributions;
- single-fleet avoidance multiplier `0.86`;
- combined-fleet avoidance multiplier `0.68`;
- combined-fleet B-25 avoidance multiplier `0.70`.

These values are `established_simulator_assumption`, not confirmed official
formulas. Ship-type-specific accuracy bonuses, such as B-25 and 65th Sentai
against destroyers, are a separate target-effect table. Do not create a generic
"DD/CL/CA hit rate" table unless a source supports it. If enemy master evasion
becomes available, keep it as a separate input and validate how it composes with
the fleet-level empirical multiplier before enabling it.

## Optimization Objective

Air-state fulfillment remains the first lexicographic objective. Combat value
then uses stateful outcomes in this order:

1. maximize all-wave target fulfillment probability;
2. maximize expected threat-weighted sunk targets;
3. maximize expected threat suppression from heavy/medium damage, after the
   exact game effects and thresholds are sourced;
4. maximize expected HP damage;
5. minimize aircraft loss and resource cost;
6. compare air margin, scarcity, and canonical key.

Sinking already improves later attacks because sunk targets leave the selection
pool. The explicit sunk-target score captures the player's preference for
removing enemy actions; it must be reported separately so it is not hidden as
an arbitrary damage multiplier. Until threat-suppression effects are verified,
that objective remains disabled rather than guessed.

## Search and Proof Consequences

Target selection and HP transitions make damage non-additive across aircraft
and waves. Existing per-plane additive damage bounds cannot certify this score.
Before enabling the stateful objective in exact search:

- build a conservative upper bound for kills, suppression, and HP damage;
- compare reduced inventories against complete enumeration;
- preserve strict inequality in pruning so equal primary scores survive for
  loss, resource, margin, scarcity, and canonical tie-breaks;
- report `provenOptimal` only for the declared fixed sample stream, candidate
  universe, formula version, and objective;
- keep progressive 256/1024/4096 SAA stages as warm starts and ordering only.
  Earlier stages never remove later candidates, and population optimality is
  never implied by fixed-sample proof.

## Incremental Implementation

1. Rename current output to `attackPowerProxy` in UI/CLI/API while retaining a
   deprecated `expectedDamage` compatibility field.
2. Preserve enemy HP, armor, type, target tags, fleet side, and provenance in
   `map-catalog.js` and `enemy-slots.js`.
3. Add a pure target-specific power module and cross-source fixtures for B-25,
   65th Sentai, guided weapons, land targets, and the disputed type 53 path.
4. Add deterministic target selection, eligibility, sinking, armor, scratch,
   and HP transitions with coordinate-addressed random draws.
5. Add versioned empirical hit/evasion and proficiency critical models.
6. Add ordinary contact, jet damage, and event-specific rules only with source
   metadata and explicit applicability.
7. Rebuild search score and certified upper bounds, then compare E3P1 and E2P3
   guide loadouts against the optimizer under identical inputs.

## Required Regression Fixtures

- Accuracy/evasion golden tables for single, combined, and combined B-25 cases.
- Equipment-by-target-type matrix including B-25, 65th Sentai, guided weapons,
  land targets, PT, and submarines.
- Deterministic hit, critical, armor, scratch, HP, and sinking sequences.
- A wave where an early sink removes target-selection dilution for later planes.
- Main/escort selection frequencies under shared fixed random coordinates.
- E3P1 `+10 Ginga` versus `Ginga (Egusa Squadron)` with every score component.
- E2P3 guide plan versus optimizer result with armor and combined-fleet rules.
- Small random inventories whose production winner equals complete enumeration.

## References

- noro6 power and target effects:
  https://github.com/noro6/kc-web/blob/d490a8411c92669ecbd258bb7c47af392402ea99/src/classes/aerialCombat/powerCalculator.ts#L153-L445
- noro6 contact and proficiency criticals:
  https://github.com/noro6/kc-web/blob/d490a8411c92669ecbd258bb7c47af392402ea99/src/classes/item/item.ts#L1202-L1348
- noro6 Stage 1 and armor distribution:
  https://github.com/noro6/kc-web/blob/d490a8411c92669ecbd258bb7c47af392402ea99/src/classes/commonCalc.ts#L33-L163
- noro6 Stage 2:
  https://github.com/noro6/kc-web/blob/d490a8411c92669ecbd258bb7c47af392402ea99/src/classes/aerialCombat/shootDownInfo.ts#L132-L198
- kancolle-replay LBAS simulation:
  https://github.com/KC3Kai/kancolle-replay/blob/ec3094c5ba57e289d2716a75ab5f4dee31f1b07f/js/kcsim.js#L2967-L3337

KCWiki's relevant pages were blocked by Cloudflare during this audit. Rules not
independently recovered from another source remain classified accordingly.
