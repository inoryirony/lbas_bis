# LBAS Autoresearch Synthesis

## Decision Policy

- Accuracy and complete fixed-sample optimality outrank speed.
- No candidate caps, beam-width deletion, sample reduction, or heuristic
  dominance may be used to claim an exact result.
- A heuristic may find an incumbent or order traversal only.
- A proof prune uses a conservative bound and strict inequality. Equality stays
  alive for loss, resource, margin, scarcity, and canonical tie-breaks.
- The practical target is the owned-inventory 6-5 two-base detailed scenario at
  4096 fixed samples in under five minutes, without increasing peak memory to an
  unsafe level.

## Reviewed Explorations

This synthesis incorporates all six completed read-only explorations:

1. `Analyze exact solver speedup`: three-base trajectory MITM.
2. `Analyze exact enemy trajectory MITM`: exact state, dominance, and oracle
   requirements.
3. `Design progressive SAA LBAS`: nested samples, warm starts, validation, and
   proof semantics.
4. `Audit LBAS damage and loss model`: missing target, hit/evasion, critical,
   armor, HP, sinking, contact, jet, and special-target rules.
5. `Audit exact solver pruning`: inventory-compatible prefix bounds and exact
   continuation scoring.
6. `Audit fixed-sample memory reuse`: trajectory interning, streaming suffixes,
   cache lifetimes, and chunked strict bounds.

## Shared Model of the Search Problem

For a fixed seed and sample count, detailed optimization is a deterministic
sequential resource-constrained search. A boundary state is:

```text
(baseIndex, full per-sample enemy-slot trajectory, grouped inventory usage)
```

The trajectory must retain every sample, enemy fleet, and enemy aircraft slot.
Expected air power, maximum air power, state ranks, or aggregate slot totals do
not define equivalent future states. Hashing may find an intern bucket, but
full equality must resolve collisions.

The score is lexicographic. Damage and several resource terms are additive, but
worst air margin is a minimum across waves. Therefore a prefix with a better
local lexicographic score does not automatically dominate another prefix: a
later low margin can equalize margin and expose scarcity or canonical ordering.

## Accepted and Implemented Directions

The current working tree already contains the following exact transformations:

- count-aware inventory compatibility bitmaps before suffix simulation;
- trajectory IDs as a memoized structural-signature fast path, while still
  merging independently cached trajectories by full structure;
- one-shot numeric base records instead of unbounded candidate `baseCache`;
- streamed two-base suffix enumeration with peak retained suffix candidates of
  one;
- reusable final-slot histograms for aircraft-loss damage curves;
- strict fixed-sample incumbent bounds for generic jet prefix and suffix
  simulation.

These changes alter traversal, storage, or proven upper-bound checks only. They
do not remove an equal-score candidate.

## Next Two-Base Performance Hypotheses

Priority order for the current 6-5 target:

1. Preserve integer damage numerators end-to-end rather than round-trip through
   expected floating values.
2. Turn the concentrated non-jet continuation evaluator into an explicit exact
   table scorer. Its enemy transition depends on the incoming trajectory and
   base air state; its damage is a sum of cached slot-loss contributions.
3. Pack enemy trajectories and state ranks into typed arrays with collision-safe
   interning. This matters when more than one structural trajectory appears.
4. Process 4096 samples in blocks for generic paths. Stop only after an observed
   fulfillment failure makes `fulfillment < 1`, or when exact accumulated damage
   plus a remaining conservative bound is strictly below the incumbent.
5. Add byte-bounded caches. Eviction causes recomputation, never candidate loss.

Each hypothesis is reversible and must pass the small exhaustive oracle, the
full core tests, a 16-sample result/key comparison, and then the 4096 benchmark.

## Postponed but Compatible Directions

### Three-Base Trajectory MITM

Three-base detailed search still repeats two-base-prefix and full-plan
simulation. The exact extension is a conditional MITM/trajectory DP:

1. evaluate each base-zero candidate and group by exact output trajectory;
2. evaluate each distinct `(trajectory, base-one candidate)` transition once;
3. retain inventory-aware prefix labels at the second boundary;
4. evaluate each distinct `(second trajectory, base-two candidate)` once and
   join every compatible label.

This is valuable for three bases but does not address the current two-base 6-5
acceptance target, so it follows the two-base work. Worst-case complexity stays
exponential; it is an exact state-reuse optimization, not a polynomial claim.

### Progressive SAA

Use deterministic nested stages such as 256, 1024, and 4096 samples. A previous
winner is reevaluated on the larger prefix and may become an incumbent or branch
order hint. It never filters the larger stage's candidate universe.

`provenOptimal` means optimal only for the declared fixed sample stream,
candidate universe, simulator version, and objective. Stability across stages
is convergence evidence, not population optimality. Independent validation uses
a different seed and paired common random numbers across a frozen finalist set.

This is compatible with exact search but is not a shortcut for the five-minute
fixed-4096 target.

## Accuracy Workstream

The current `expectedDamage` is an attack-power proxy. The stateful combat model
and source confidence rules are defined in
`2026-07-23-lbas-combat-resolution-design.md`.

In particular, hit and evasion must be explicit model inputs:

- base hit, equipment accuracy, proficiency hit/critical contribution;
- single/combined fleet empirical evasion modifiers;
- target-type accuracy effects for B-25, 65th Sentai, and guided weapons;
- future enemy-master evasion only after its composition with fleet modifiers
  is verified.

Simulator-derived constants are labeled assumptions. There is no invented
generic hit-rate table by DD/CL/CA class. Target-type bonuses are applied only
where a source defines them.

Stateful target selection and sinking make damage non-additive. Existing damage
bounds cannot certify that future objective unchanged; the score and bounds
must be rebuilt together before real HP damage becomes the exact-search ranking.

## Resolved Correctness Risk

`aircraftEquivalenceKey` now includes `cost`, `shootDownAvoidance`, and
`isEscortItem`. Regressions prove that behavior-distinct planes form separate
groups and receive separate Stage 2 numeric records.

## Benchmark Record

- Original owned-inventory 6-5, 16 samples: about 86 seconds, 722,491 suffix
  evaluations.
- Streaming/compatibility version: 47.5 seconds, about 267 MB RSS, 184,498
  suffix evaluations, same recorded canonical optimum.
- Slot-loss histogram version, 16 samples: 40.9 seconds, about 249 MB RSS, same
  recorded canonical optimum.
- Strict jet suffix bound, current inventory and current benchmark seed:
  26.5 seconds, about 227 MB max RSS, 11,602 suffix simulation-bound prunes,
  and `provenOptimal=true`.
- Pre-histogram 4096 run: 866,214 ms, about 634 MB RSS,
  `provenOptimal=true`.
- Histogram-only 4096 run exceeded 604 seconds and was terminated cleanly.
- Strict jet prefix/suffix bounds, owned-inventory 6-5 at 4096 samples and seed
  `6-5-exact-benchmark`: 251,322 ms search time, about 695 MB max RSS,
  2,553 prefix and 19,205 suffix simulation-bound prunes,
  `provenOptimal=true`, and no surviving child process. The selected master IDs
  were base one `[157,403,417,444]` and base two `[225,323,475,484]`.
- Live Poi inventory, noro6 6-5 M formation 0, four-wave parity, default 4096
  sample stream: first incumbent at 26,193 ms and fixed-sample optimum at
  271,940 ms wall time, about 568 MB peak RSS, 5,609,320 explored nodes, and
  `provenOptimal=true`. Three incumbents improved the attack-power proxy from
  918.039 to 1230.399. The final master IDs were base one
  `[157,225,403,444]` and base two `[154,403,417,484]`.
- That run spent about 179 seconds building 74,417 prefix trajectories and
  about 42 seconds streaming 576,003 suffix candidates. This makes the exact
  concentrated non-jet prefix evaluator the next two-base performance target.
- Live Poi static checks proved a 6-4 N four-wave superiority optimum and a
  6-5 M four-wave parity optimum. Three-base event checks proved optima for
  720-air/radius-5 and 686-air/radius-8 denial scenarios, while the owned
  inventory 727-air/radius-9 scenario was proven infeasible rather than budget
  exhausted.
- Poi-backed static CLI startup fell from 11,349 ms to 549 ms by preferring the
  validated noro6 cache only for optional equipment metadata. Map formation
  selection remains remote-first. Detailed progress now retains the active
  prefix/suffix phase instead of regressing to the generic proof phase.

The 16-sample runs are controlled performance probes, not accuracy substitutes.
The under-five-minute fixed-4096 performance target is now met for this frozen
seed and current inventory. It is not a proof that every map/inventory finishes
within five minutes, and it does not validate the attack-power proxy as HP
damage.

## Required Gates

- Small exhaustive locked-plan oracle for concentrated, separate, jet, recon,
  duplicate-group, locked-slot, and exact-tie cases.
- Full score tuple and canonical key equality, not only the first equipment ID.
- Forced trajectory-hash collision and cache-budget `0/tiny/unbounded` tests.
- Block size `1/7/64/sampleCount` equality for chunked scoring.
- Three-base MITM oracle before enabling that path.
- E3P1 and E2P3 real-map comparisons after the HP damage model is implemented.
- Every interrupted benchmark must have its exact child PID stopped and checked.
