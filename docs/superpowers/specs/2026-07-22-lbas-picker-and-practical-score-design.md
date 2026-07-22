# LBAS Equipment Picker and Practical Score Design

## Scope

This iteration closes four gaps found during live Poi use:

1. `loss` is a valid air-state target but is absent from the UI selectors.
2. A native select containing hundreds of aircraft is not usable.
3. Optimizer blacklists do not constrain manual simulator selection.
4. The displayed damage score ignores accuracy and proficiency benefits, so a
   high-improvement ordinary aircraft can incorrectly outrank a skilled unit in
   practical expected damage.

It also closes two release-review findings: cumulative progress is lost at the
search-event boundary, and a static seed can delay the first detailed incumbent
for millions of nodes.

## Equipment Selection

Each simulator slot uses a searchable picker. The closed control displays the
current aircraft. Opening or typing displays one result list for that slot, so
the page never renders every aircraft for every slot at once.

Aircraft are ordered by equipment type, normalized name, improvement,
proficiency, and instance ID. Every row displays the readable equipment type,
name, improvement, visible proficiency, and instance ID. Search normalization
handles case, width, and simplified/traditional Chinese. Ranking is exact name,
prefix, substring, token substring, then ordered fuzzy subsequence.

Blacklisted master IDs and equipment types are removed from new choices. A
blacklisted aircraft already present in a slot remains visible with a warning;
after clearing or replacing it, it cannot be selected again. The state-update
handler validates the choice as well as the UI, so a stale DOM event cannot
bypass the blacklist.

## Air-State Targets

`loss` is accepted by state parsing, simulator normalization, the wave selector,
CLI scenarios, and optimization. It is rendered as `丧失` in Chinese and the
existing localized label in other languages.

## Practical Damage Score

Status note (2026-07-23): this section describes an intermediate proxy, not HP
damage. The required target, hit/evasion, critical, armor, scratch, HP, and sink
model is specified in
`2026-07-23-lbas-combat-resolution-design.md`. UI/API text must not call the
current additive attack-power score expected HP damage.

The aircraft adapter retains the official accuracy stat. Damage scoring keeps
the existing LBAS attack-power formula, then applies only reference-verified
accuracy and proficiency expectation factors. The UI labels the result as an
estimate unless every required target field is known. Branch bounds use the same
monotonic score components as final ranking; no candidate may be pruned by the
old raw-power ordering and ranked by a different practical score.

The live E3P1 regression compares the owned `+10 銀河` with `銀河(江草隊)` and
records every score component so the selected winner is explainable. E2P3 uses
one scenario for both the guide loadout and optimizer output and compares target
fulfillment, enemy-air trajectory, expected damage, own loss, and resource cost.
No UI text claims one is better unless the declared lexicographic objective
actually prefers it under identical inputs.

## Search Responsiveness

Progress events preserve both proof-local `nodesExplored` and monotonic
`totalNodesExplored`. The first-incumbent seed uses a bounded fast attempt and a
cheap feasible fallback; expensive improvement belongs after an incumbent is
published. Formal proof remains unbounded by default and continues until
`provenOptimal` or explicit cancellation.

## Verification

- Unit tests cover search normalization/ranking, type sorting, blacklisted
  current items, handler-level blacklist rejection, and `loss` UI parsing.
- Search-session tests cover monotonic cumulative events and bounded work before
  the first incumbent.
- Damage tests pin official data fields and the E3P1 comparison components.
- CLI fixtures compare E2P3 guide and optimized loadouts under one scenario.
- Full tests, typecheck, package dry-run, live Poi reload, 6-4, 6-5, E3P1, and
  E2P3 checks run serially with no orphaned Node processes.
