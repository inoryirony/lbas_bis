# LBAS BIS Handoff

Last updated: 2026-07-24 (Asia/Shanghai)

## Mission

Ship the Poi LBAS optimizer as an accuracy-first exact optimizer that:

1. publishes the first target-feasible plan quickly;
2. keeps proving the optimum in the background with visibly active progress;
3. never labels a budget-limited or cancelled incumbent as optimal;
4. ranks feasible combat plans by expected sinks, expected HP damage, attack proxy,
   loss, resources, air margin, and scarcity;
5. uses the same deterministic fixed-sample model in simulation, search scoring, and
   certified bounds;
6. remains usable from Poi and the JSON/JSONL CLI.

Implementation and proof evidence is recorded below. Publishing gates must be rerun
fresh, and the publishing commit must continue to exclude the user-owned
`bin/lbas-bis.js` change.

## Repository And Safety Boundaries

- Repository: `C:\Users\12566\Documents\Codex\2026-06-26\use-github-linear-or-my-uploaded\poi`
- Branch: `main`
- Remote: `https://github.com/inoryirony/lbas_bis.git`
- Required repository-local Git identity:

  ```text
  inoryirony <82687061+inoryirony@users.noreply.github.com>
  ```

- Poi plugin path is a Junction to this repository:

  ```text
  C:\Users\12566\AppData\Roaming\poi\plugins\node_modules\poi-plugin-lbas-bis
  ```

- `bin/lbas-bis.js` contains user-owned changes. Do not modify, revert, stage, or
  commit it.
- Stage explicit paths only; do not use `git add -A`.
- Kill only Node processes whose complete command line belongs to this repository's
  CLI benchmark. Do not kill Codex, memory, or MCP processes.
- The complete reachable Git history was audited and already uses acceptable
  identities. No history rewrite or force-push is required.

## Implemented Model And Search

- Real enemy HP, armor, evasion, luck, fleet side, flagship state, target tags, and
  aircraft slots are preserved from map data.
- Stateful per-wave combat resolves target eligibility, main/escort selection,
  flagship protection, ordinary contact and carry-over, hit, critical, armor random,
  scratch damage, HP continuation, sinking, and removal of sunk targets.
- Sunk ships never revive between waves. Fixed coordinate RNG keeps results independent
  of traversal order.
- B-25, 65th Sentai, Hs293, Fritz-X, guided weapons, land targets, PT/special enemies,
  submarines, and Toukai use explicit target rules.
- Land-based recon damage affects both real HP damage and the optimistic proof bound.
- Event equipment multipliers and user-entered multiplier rules are data-driven.
- Equipment tags and slot locks are exact optimizer constraints.
- Detailed combat search uses suffix frontiers, cached trajectories and continuation
  state, safe air/combat upper bounds, strong combat ordering, and four suffix shards.
- Four workers share the incumbent's primary combat score through an atomic buffer.
- Terminal candidates are compared with the exact prefix-plus-suffix score components;
  the first feasible incumbent is fully simulated immediately, while later improving
  candidates defer the full four-wave simulation until the shard's final winner. This
  removes repeated Monte Carlo work without changing the lexicographic objective.
- Flat cached contact state uses the complete two-byte encoding, so suffix simulation
  preserves both fields of ordinary contact carried from the prefix.
- Combat transition/profile grouping and proof ceilings use the same explicit-or-derived
  attacker/contact capabilities as the real resolver, including custom aircraft data.
- Detailed fixed-sample search disables cross-group dominance because replacing any aircraft
  can reorder the whole plan's CRN loss coordinates, so an individually stronger aircraft
  does not prove that the complete plan's fixed-sample score is non-worse.
- Grouped and frontier fixed-sample bounds assign surviving attackers injectively across
  every reachable combat draw coordinate, including coordinate shifts after Stage 2 loss.
- Cancellation preserves the best valid incumbent and reports `provenOptimal=false`.
- Both exact backends poll cancellation again after their last synchronous simulation and
  before publishing `optimal` or `shard_complete`, closing the terminal certificate race.
- The parallel runner closes its cancellation window before publishing the first aggregate
  100% event backed by `shardComplete` from every worker; later cancel requests return false.
- Importing an incumbent changes the simulator loadout without cancelling or
  invalidating the active proof.
- Legacy detailed and both combat backends poll cancellation after their last synchronous
  simulation before issuing any terminal certificate.
- Standard and legacy locked-slot shapes are protected from CLI candidate filters, zero-slot
  aircraft cannot select contact, `maxHp`-only enemies start at full HP, and separate two-base
  combat searches stay on the compatible serial backend.

## 6-5 Infeasibility And Progress Fixes

The reproduced immediate 6-5 infeasibility was a real filter conflict, not an unsafe
prune. With carrier aircraft excluded and equipment type 48 blacklisted, all fighter
candidates disappeared; only non-fighter types remained and could not reach parity
against enemy air 318. The UI now explains this narrow conflict only after the solver's
first-wave air upper bound proves infeasibility. It does not silently override filters.

Unknown-total exact-search phases do not use Chromium's unreliable native indeterminate
animation. A lightweight UI clock drives the moving pulse every 100 ms even when the
solver spends several seconds between snapshots. Countable phases begin only after every
worker has frozen its assignment, then show exact
`completedWork / totalWork` plus a moving activity marker. A transition is counted only
after its full evaluation completes, so the fixed total never grows and percentage never
regresses. Nodes,
prunes, complete candidates, samples, and elapsed time continue updating underneath.

## Strict 4096-Sample Proofs

The three eligible two-base fixtures use four workers; the one-base 6-4 fixture uses
the serial `combat-grouped-exhaustive` backend. All use deterministic fixed samples and
unlimited node and simulation budgets. Every run exited successfully with
`status=optimal` and `provenOptimal=true`.

| Fixture | Shape | Wall / solver | Proof evidence |
| --- | --- | ---: | --- |
| `examples/poi-6-5-combat.json` | two bases, four waves | 228.883 s / 217.066 s | 167,944 / 167,944 suffixes; 2 full terminal simulations, 6 exact-score reuses |
| `examples/poi-6-4-combat.json` | one base, two waves | 205.550 s / 194.216 s | 2,932,280 nodes; 101,826,870 samples |
| `examples/poi-event-high-air-1-combat.json` | high-air event boss | 139.202 s / 127.592 s | 37,016 / 37,016 suffixes; 4 full terminal simulations, 1,325 exact-score reuses |
| `examples/poi-event-high-air-2-combat.json` | high-air event boss | 13.736 s / 2.114 s | 226 / 226 suffixes; 4 full terminal simulations, 82 exact-score reuses |

Each fresh CLI process exited in strictly less than 300 seconds, so every proof meets
the five-minute wall-clock target as well as the solver-time target. The claim is deliberately
bounded to the frozen inventory, candidate filters, seed, formula version, and 4096
sample stream. It does not claim population-optimal Monte Carlo expectation for every
inventory or map.

Benchmark JSONL evidence:

```text
C:\Users\12566\AppData\Local\Temp\lbas-publish-6-5-20260724-202529.jsonl
C:\Users\12566\AppData\Local\Temp\lbas-publish-6-4-20260724-202943.jsonl
C:\Users\12566\AppData\Local\Temp\lbas-publish-event1-20260724-202943.jsonl
C:\Users\12566\AppData\Local\Temp\lbas-publish-event2-20260724-202943.jsonl
```

## Poi Acceptance

Poi 11.1.0 was restarted against the Junction and the live 6-5 M boss workflow was
checked with 4096 samples, detailed combat, two bases/four waves, carrier aircraft
excluded, and 95 owned candidates.

- A first feasible plan appeared in about 8.4 seconds.
- Unknown and known progress indicators moved while counters and elapsed time advanced.
- Importing the current plan did not stop the proof: afterward, countable progress advanced
  from 366 / 21,202 (2%) to 2,014 / 21,202 (9%), while samples advanced from
  29,753,344 to 57,147,392 and the stop button remained available.
- Cancellation retained the incumbent and displayed an honest cancelled/unproven state.
- A new search started after cancellation and advanced under the new generation; no old
  worker event replaced it. A sub-second desktop snapshot can still show the previous
  terminal state before React's next paint, but it does not persist.
- The normal Poi pane kept the controls reachable without horizontal overflow.
- The plugin Junction resolves to this repository.
- The Poi bridge port file resolved successfully and `/health` returned
  `{"status":"ok"}`.
- No repository benchmark Node process remained after acceptance.

## CLI And Proof Semantics

- `validate`, `simulate`, `optimize`, map/enemy/equipment search, and JSONL events remain
  deterministic interfaces for scripts and later MCP control.
- `optimal` means the declared search space is fully proven.
- `infeasible` is emitted only after complete proof.
- `budget_exhausted` and `cancelled` may retain a feasible incumbent but always keep
  `provenOptimal=false`; the CLI exits non-zero for an unproven optimize result.
- Detailed `provenOptimal=true` is exact only for the declared fixed sample stream.

## Remaining Empirical Boundaries

- Several hit/evasion/contact constants are established simulator assumptions rather
  than official formulas; their metadata remains versioned and visible in code.
- Enemy anti-air cut-ins and ordinary fleet Stage 2 are outside this LBAS-only combat
  model.
- Map data can lag game updates; custom enemy ships/slots and multiplier rules remain the
  explicit override path.

## Completion Gates

- [x] 6-5 no longer reports immediate infeasibility when fighters remain available.
- [x] Filter-caused infeasibility has an actionable, narrowly scoped explanation.
- [x] Progress visibly advances for unknown and known totals.
- [x] Import does not interrupt optimization.
- [x] First incumbent appears quickly and cancellation preserves it.
- [x] Land recon, contact, flagship, submarine/Toukai, PT/special, event multiplier, and
  equipment tag/lock behavior are implemented with regression coverage.
- [x] Exhaustive random small cases match production search.
- [x] Four real fixtures prove the 4096-sample optimum; the three eligible two-base
  fixtures use four workers, the single-base 6-4 fixture uses grouped exhaustive, and
  all are under five minutes.
- [x] Poi, Junction, bridge, controls, restart-after-cancel, and process cleanup were
  checked on the live installation.
- [x] Reachable Git identity history is clean and does not require rewriting.
- [x] Final verification, read-only review, explicit staging, commit, and push are part of
  the publishing workflow for this handoff.
