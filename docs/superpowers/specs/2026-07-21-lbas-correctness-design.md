# LBAS Correctness And Continuous Simulation Design

## Goal

Replace the current fixed-enemy-air heuristic recommender with a correctness-oriented optimizer that:

- models aircraft capabilities and LBAS slot sizes explicitly;
- supports zero to four equipped aircraft, including locked empty slots;
- never reports "no solution" merely because a heuristic budget was exhausted;
- proves optimality for tractable inventories and reports when optimality is not proven;
- runs waves in sortie order when enemy slot details are available;
- clearly labels total-air-only calculations as static estimates.

## Considered Approaches

1. Increase the existing pool and result limits. This is fast to implement but preserves false no-solution and false-best outcomes, so it is rejected.
2. Run full instance-level exhaustive search for every inventory. This is a useful oracle for small tests but grows too quickly for a normal Poi inventory.
3. Group equivalent aircraft and use branch-and-bound with an explicit node budget, while retaining exhaustive search as a small-case oracle. This is the selected approach because it can prove results when it finishes and remains honest when it does not.

## Aircraft Model

Each plane keeps its inventory identity and gains independent capability flags derived from the API equipment type and icon type:

`isPlane`, `isFighter`, `isAttacker`, `isLandAttacker`, `isHeavyLandAttacker`, `isRecon`, `isLandRecon`, `isBakusen`, `isAswPatrol`, `isAutoGyro`, `isAswBomber1`, `isAswBomber2`, `blocksRangeExtension`, `isJet`, and `isHeavyJet`.

LBAS slot sizes are capability-driven: recon 4, heavy land attacker 9, other aircraft 18. Range starts with the minimum radius of every equipped plane. A longer recon may extend that minimum by the game formula; a non-attacking ASW patrol plane disables extension. Empty slots do not participate.

Visible proficiency is stored separately from internal proficiency. If Poi supplies only the visible level, calculations expose a lower and upper air-power bound for that visible band. Hard target checks use the lower bound so a result means the target is guaranteed across the visible band; the upper bound is displayed as a possible value. The existing uniform visible-level threshold remains available but is named as such; it is not presented as per-aircraft optimization.

## Air State And Wave Model

`airStateFor` receives whether the side has a participating plane. If both air powers are zero and there is no plane, it returns `NONE`; a real zero-air-power plane remains distinguishable.

Enemy input supports two modes:

- `static`: only total enemy air power is known. Every wave uses the same value and the UI labels all output as a static estimate.
- `detailed`: enemy slots contain plane anti-air, current count, and optional identity. A seeded Monte Carlo simulation evaluates waves in actual order. Each wave calculates current air powers, determines state, applies enemy stage-one losses, updates slot counts, and advances to the next wave. When a base concentrates both waves on this enemy, its own stage-one loss is applied only after the second wave; a separately dispatched base applies it after each wave. The first implementation excludes enemy fleet anti-air stage two unless the required enemy anti-air data is present, and reports that limitation in simulation metadata.

The simulator returns state probabilities, expected remaining slots, expected enemy air power, expected own air power, expected damage proxy, and the seed/sample count used.

## Search Model

Locked equipment instances are collected before candidate generation and removed from every other base pool. A locked empty slot remains empty. All other slots include an explicit `EMPTY` choice.

Equipment instances with identical optimization-relevant properties are grouped as `(properties, count)`; result materialization maps selected counts back to stable instance IDs. Hard constraints are checked during recursion, before any ranking or result limit:

- inventory counts and locked ownership;
- zero-to-four slot capacity;
- attainable target radius;
- attainable air-power target for each base or wave model.

Static search treats every requested wave target as a hard constraint. Among feasible plans it uses a lexicographic objective shared by candidate comparison, pruning, and final ranking:

1. expected damage proxy;
2. lower expected aircraft loss and resource cost;
3. air-power margin;
4. lower missing-equipment and scarcity cost.

Branch-and-bound builds a relaxed single-base envelope for every unassigned base using the current remaining groups while ignoring competition with other unassigned bases. This envelope exactly checks that base's slots, range, recon multiplier, and target threshold, and returns independent optimistic damage and margin values. Reusing the same group in multiple relaxed envelopes is allowed because it can only make the bound more optimistic. A branch is pruned only when an envelope is infeasible or its score is strictly worse than the current Kth score; equality is retained for deterministic tie-breaking.

Top K contains unique equivalence-count plans rather than permutations or plans differing only by interchangeable instance IDs. Materialization maps each group count to stable sorted instance IDs. Search metadata contains `status`, `nodesExplored`, `budget`, `provenOptimal`, and `mode`. Status is one of `optimal`, `infeasible`, `budget_exhausted`, or `invalid_input`; an exhausted search is never called infeasible. Reaching the budget exactly is not exhaustion unless an additional node remains unexplored.

Detailed simulation ranks plans first by all-wave fulfillment probability, then by expected damage, loss/resource cost, margin, and scarcity. Every plan uses common random numbers derived from `(seed, sample, wave, side, slot)` so its score is independent of traversal order. Until a valid probability/expected-damage upper bound exists, detailed mode does not use score pruning and can claim `provenOptimal` only after complete enumeration.

For small inventories, a separate exhaustive oracle enumerates all legal assignments and canonicalizes them to the same equivalence-count plan identity. Randomized regression tests compare complete Top K scores, canonical plan keys, feasibility, and status against this oracle. Bound property tests exhaustively complete random partial states and verify every reported optimistic bound is at least the true best completion.

## UI And Compatibility

The existing simulator-first Poi UI remains. Enemy controls show a static/detailed mode indicator, and result rows show search status and whether optimality is proven. Missing theoretical equipment stays visible but dimmed and marked with its shortage count. Empty slots are selectable and lockable. Each plan shows the uniform minimum visible proficiency level and does not call it a per-plane minimum.

Existing `role` remains temporarily as a compatibility display field, but calculation and search rules use capability flags. Public CommonJS entry points remain compatible where practical.

## Error Handling

Invalid or duplicate locked instances return a structured input error. No-range candidates, confirmed infeasibility, and exhausted search budgets are separate outcomes. Detailed simulation with malformed enemy slots falls back to a structured validation error, not silent static behavior.

## Verification

Regression tests cover the ten audit cases, plus capability extraction and static/detailed mode labeling. Formula fixtures are cross-checked against `noro6/kc-web` for slot sizes, range extension, air state, proficiency bands, improvement anti-air, and stage-one losses. `KC3Kai/kancolle-replay` is used as a second implementation reference where matching code is available. Final verification runs tests, typecheck, package dry-run, a deterministic simulation fixture, randomized optimizer-vs-exhaustive comparisons, and Poi junction validation.

## Assumptions To Revisit

- Poi equipment `api_alv` is a visible proficiency level unless an internal value is explicitly available.
- Enemy stage-two anti-air cannot be accurate from slot anti-air/count alone; it must remain excluded and disclosed until enemy fleet anti-air data is modeled.
- Damage remains an expected attack-power proxy without a selected enemy target and armor. It must not be labeled final damage.
