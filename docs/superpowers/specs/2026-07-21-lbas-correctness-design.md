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

`isPlane`, `isFighter`, `isAttacker`, `isLandAttacker`, `isHeavyLandAttacker`, `isRecon`, `isLandRecon`, `isBakusen`, `isAswPatrol`, `isJet`, and `isHeavyJet`.

LBAS slot sizes are capability-driven: recon 4, heavy land attacker 9, other aircraft 18. Range starts with the minimum radius of every equipped plane. A longer recon may extend that minimum by the game formula; a non-attacking ASW patrol plane disables extension. Empty slots do not participate.

Visible proficiency is stored separately from internal proficiency. If Poi supplies only the visible level, calculations expose a lower and upper air-power bound for that visible band. The existing uniform visible-level threshold remains available but is named as such; it is not presented as per-aircraft optimization.

## Air State And Wave Model

`airStateFor` receives whether the side has a participating plane. If both air powers are zero and there is no plane, it returns `NONE`; a real zero-air-power plane remains distinguishable.

Enemy input supports two modes:

- `static`: only total enemy air power is known. Every wave uses the same value and the UI labels all output as a static estimate.
- `detailed`: enemy slots contain plane anti-air, current count, and optional identity. A seeded Monte Carlo simulation evaluates waves in actual order. Each wave calculates current air powers, determines state, applies stage-one losses to both sides, updates slot counts, and advances to the next wave. The first implementation excludes enemy fleet anti-air stage two unless the required enemy anti-air data is present, and reports that limitation in simulation metadata.

The simulator returns state probabilities, expected remaining slots, expected enemy air power, expected own air power, expected damage proxy, and the seed/sample count used.

## Search Model

Locked equipment instances are collected before candidate generation and removed from every other base pool. A locked empty slot remains empty. All other slots include an explicit `EMPTY` choice.

Equipment instances with identical optimization-relevant properties are grouped as `(properties, count)`; result materialization maps selected counts back to stable instance IDs. Hard constraints are checked during recursion, before any ranking or result limit:

- inventory counts and locked ownership;
- zero-to-four slot capacity;
- attainable target radius;
- attainable air-power target for each base or wave model.

Search uses a lexicographic objective shared by candidate comparison, pruning, and final ranking:

1. all requested wave targets fulfilled (or highest detailed-simulation fulfillment probability);
2. expected damage proxy;
3. lower expected aircraft loss and resource cost;
4. air-power margin;
5. lower missing-equipment and scarcity cost.

Branch-and-bound computes optimistic remaining air power and damage. It prunes only when a hard constraint cannot be met or the optimistic score cannot enter Top K. Search metadata contains `status`, `nodesExplored`, `budget`, `provenOptimal`, and `mode`. Status is one of `optimal`, `infeasible`, or `budget_exhausted`; an exhausted search is never called infeasible.

For small inventories, a separate exhaustive oracle enumerates all legal assignments. Randomized regression tests compare the optimizer's best score and feasibility result against this oracle.

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
