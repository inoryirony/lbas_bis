# LBAS Stateful Combat Resolution Design

## Status and Scope

Implementation completed on 2026-07-24. The detailed optimizer now reports
`expectedHpDamage` and `expectedSunkCount` from stateful target selection, hit,
critical, armor, scratch, HP continuation, and sinking. `attackPowerProxy`
remains a separate lower-priority explanation and tie-break field.

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

## Implemented Target-Power Slice

`lbas-target-power-v1` is implemented in `src/damage.js` from the locked noro6
and KC3 revisions listed below. `calculatePlaneTargetAttackPower` is used by
real combat scoring and by the certified optimistic bound. Land-recon, contact,
event, PT, and special-target modifiers are applied in both paths with an
optimistic maximum in the bound.

The cross-source-agreed rules currently cover:

- land targets using bombing instead of torpedo for type 47/53 aircraft;
- 65th Sentai and skilled 20th Sentai destroyer attack stats;
- B-25 pre-cap multipliers for destroyer, light cruiser, heavy cruiser,
  battleship/carrier, supply, seaplane-tender, and land targets;
- Hs293 against destroyers, Fritz-X against battleships, guided type-A weapon
  target groups, and Hs293D against destroyers.

The formula metadata deliberately keeps these conflicts unresolved and disabled:

- type 53 `+20` versus `+25` airstrike modifier;
- master 484 multiplicative versus additive target adjustment;
- master 454 light-carrier branch ordering;
- master 562 battleship adjustment present only in the KC3 reference path.

Stateful target selection, hit, armor, HP, and valid proof bounds are connected;
the primitive is part of the optimizer objective and exhaustive-oracle fixtures.

## Required Enemy Model

Map adaptation must retain, per ship:

- master ID, name, ship type, speed, source fleet (main or escort), and flagship;
- max/current HP, armor, land/PT/submarine/special-target tags;
- aircraft slots and Stage 2 defense inputs;
- source URL, source revision/date, map, node, difficulty, and formation index.

Manual enemies may override every field. Missing combat fields produce a visible
limitation and `null` real-damage fields rather than invented HP or armor values.

## Attack Resolution

Each attack-capable aircraft slot resolves independently in game order:

1. Build eligible living targets from surface/submarine/land attack rules.
2. Select main or escort fleet, then one eligible ship. The established
   combined-fleet assumption is main `45%`, escort `55%`; flagship protection
   and empty-fleet fallbacks have deterministic fixtures.
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

Ordinary contact, its cross-wave carry-over, and flagship protection use reserved
random coordinates so they do not reorder existing CRN draws. Jet-assault loss
remains a separate air phase.

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
and waves. The production solver therefore uses cached fixed-sample trajectories,
continuation state, and a conservative lexicographic combat ceiling:

- use optimistic perfect targeting, reachable damage multipliers, and HP/sink ceilings;
- compare reduced and seeded random inventories against complete enumeration;
- preserve strict inequality in pruning so equal primary scores survive for
  loss, resource, margin, scarcity, and canonical tie-breaks;
- report `provenOptimal` only for the declared fixed sample stream, candidate
  universe, formula version, and objective;
- use the declared 4096 samples for scoring and proof. Warm starts and ordering
  never remove candidates, and population optimality is never implied by a
  fixed-sample proof.

## Completed Implementation

1. Renamed the legacy output to `attackPowerProxy` in UI/CLI/API while retaining a
   deprecated `expectedDamage` compatibility field.
2. Preserved enemy HP, armor, type, target tags, fleet side, and provenance in
   `map-catalog.js` and `enemy-slots.js`.
3. Added a pure target-specific power module and cross-source fixtures for B-25,
   65th Sentai, guided weapons, land targets, and the disputed type 53 path.
4. Added deterministic target selection, eligibility, sinking, armor, scratch,
   and HP transitions with coordinate-addressed random draws.
5. Added versioned empirical hit/evasion and proficiency critical models.
6. Added ordinary contact, flagship protection, submarine/Toukai eligibility,
   PT/special-target transforms, and event-specific rules with source
   metadata and explicit applicability.
7. Rebuilt search score and certified upper bounds and pinned four real map/event
   fixtures plus exhaustive-oracle comparisons.
8. Disabled cross-group dominance for every fixed-sample detailed search because
   replacing one aircraft can reorder the whole plan's CRN loss coordinates.

## Proof Record

The three eligible two-base fixtures completed four-worker proofs; the one-base 6-4
fixture used the serial grouped-exhaustive backend. All 4096-sample, unlimited-budget
proofs completed with `provenOptimal=true`: 6-5 in 240.415 seconds wall time, 6-4 in
213.358 seconds, event high-air fixture 1 in 146.276 seconds, and event high-air
fixture 2 in 13.696 seconds. Every process completed in strictly less than five
minutes. These results prove only their frozen candidate
universe, seed, fixed sample stream, and formula version.

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
