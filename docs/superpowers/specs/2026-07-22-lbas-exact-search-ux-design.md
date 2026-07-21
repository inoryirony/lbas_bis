# LBAS Exact Search, Enemy Catalog, and Automation Design

## Problem

The 0.2.0 detailed optimizer is not usable for ordinary high-air-power targets. A
1,000-sample run has a fixed 10,000-sample work budget, so it evaluates at most
ten complete loadouts. Detailed branch ordering ranks one-plane damage before
air-state fulfillment, and theoretical inventory expands every missing master
item into as many as twelve concrete instances. The result is predictable:
attacker-heavy 0% plans appear, fighters are not reached, and the UI reports
budget exhaustion without producing a useful answer.

Enemy input has the same product-shape problem. The default detailed editor is a
raw aircraft-slot table. Users must type enemy aircraft anti-air and slot size by
hand even though Poi and Navy Album already contain most of the required master
data.

## Goals

1. Find and display the first target-feasible loadout as soon as possible.
2. Continue searching in the background until global optimality is proved.
3. Show honest, monotonic progress and the current incumbent while searching.
4. Never label an interrupted, bounded, or incomplete search as optimal.
5. Make map presets and searchable enemy-ship selection the normal input path.
6. Keep manual total-air and advanced per-slot overrides as explicit fallbacks.
7. Provide a headless CLI using the same engine and live Poi data through the
   existing MCP/HTTP bridge.
8. Validate formulas and optimization against real 6-4, 6-5, and event fleets.
9. Leave explicit extension points for enemy damage multipliers and equipment
   reservation/lock rules such as dedicated ASW aircraft.

## Definition of Optimal

Hard constraints are evaluated first:

- target radius;
- inventory quantities and missing-equipment policy;
- locked item and locked empty slots;
- base count and sortie order;
- per-wave requested air state.

Static mode treats the selected air state as a deterministic hard constraint.
Detailed mode rejects plans that cannot reach the target before stochastic
losses, then compares complete plans lexicographically under a fixed,
reproducible sample set:

1. all-wave target-fulfillment probability;
2. expected damage after applicable target multipliers;
3. expected aircraft loss and sortie resource cost;
4. missing-equipment count and inventory scarcity;
5. deterministic canonical key.

"Proved optimal" means every feasible grouped assignment was evaluated or was
discarded by a valid upper bound that cannot beat the incumbent under this exact
ordering. A fixed Monte Carlo sample set makes the optimization result
reproducible; the UI must separately disclose that it estimates the underlying
game probability.

## Search Architecture

### Grouped inventory

Concrete instances are grouped only when every formula, availability, and lock
property is equivalent. Theoretical equipment is represented as a group plus a
quantity, never thousands of duplicated UI instances. The result materializer
maps grouped counts back to stable owned IDs and explicit missing placeholders.

### Phase 1: feasible seed

A constraint-first search orders branches by target-air deficit, range support,
and locked scarcity before damage. It stops only to publish the first feasible
incumbent, not to finish the task. This prevents the current attacker-first
failure and gives the user a useful plan quickly.

### Phase 2: exact proof

The same search continues with branch-and-bound. Partial assignments carry
upper bounds for:

- reachable air power per remaining base;
- reachable radius with available recon;
- maximum target-fulfillment probability;
- maximum damage after hard constraints;
- minimum loss, resource, missing, and scarcity costs.

A branch is pruned only when its complete optimistic score cannot beat the
incumbent. There is no automatic node or simulation budget in the default
"prove optimal" mode. The user may cancel; cancellation preserves the current
best plan and reports `cancelled`, never `optimal` or `infeasible`.

Detailed simulation work is not a second global cap. Candidate screening may use
deterministic bounds and a smaller fixed sample prefix, but any candidate that
can still beat the incumbent is evaluated with the full selected sample set
before it is pruned or ranked.

### Background execution and progress

Search runs outside the React render thread. The engine exposes an async event
stream with these event types:

```text
started
phase_changed
progress
incumbent
completed
cancelled
failed
```

Progress contains phase, explored nodes, pruned nodes, complete candidates,
simulation samples, elapsed time, estimated total work when known, and a proof
gap/status. The UI states are `finding_feasible`, `improving`,
`proving_optimal`, `optimal`, `infeasible`, `cancelled`, and `failed`.

Only one incumbent card is prominent during search. Additional plans appear
after completion or behind an explicit comparison control. A 0%-fulfillment
plan is not shown as a useful solution when a target-feasible incumbent has not
yet been found.

## Enemy Data and Interaction

Enemy input has three modes:

1. **Map preset**: world, node, difficulty, and formation selectors populate a
   real enemy fleet and show radius, battle type, enemy air, and thresholds
   before applying it.
2. **Fleet composition**: six searchable enemy-ship comboboxes accept master ID,
   name, reading, and ship type. Duplicate ships are allowed.
3. **Manual total air**: a single enemy-air value for static estimates or missing
   data.

Per-slot rows are moved into a collapsed advanced editor. Selecting an enemy
ship automatically builds slots from:

- `state.const.$ships` for name, reading, type, and slot count;
- `state.const.$equips` for enemy equipment name, type, and `api_tyku`;
- `poi-plugin-navy-album/assets/abyssal.json` for `SLOTS` and `EQUIPS`.

The Navy Album asset is a private cross-plugin dependency and must be loaded
behind an adapter with `try/catch`. Missing or stale records remain selectable
but are marked "slot data unavailable". The plugin must not invent slot sizes.
Manual total air and advanced slot input remain available.

Map presets follow noro6's cascading world/node/difficulty/formation flow.
Remote `cells.json` and `master.json` are cached locally with source and update
timestamps. A pinned test fixture is used for regression tests so remote updates
cannot silently change expected results.

Advanced overrides preserve source ship/slot/equipment IDs and an `overridden`
flag. Master refreshes update only untouched fields. Partial or mismatched Navy
Album arrays produce a visible warning rather than overwriting user edits.

## CLI and MCP Integration

The package adds a CLI entry point:

```text
lbas-bis optimize --scenario scenario.json --poi http://127.0.0.1:17777 --jsonl
lbas-bis validate --scenario scenario.json
lbas-bis enemy search --name "空母棲姫"
```

The CLI reads live owned equipment and master data from `poi-plugin-mcp` when
available, with JSON fixture input as an offline fallback. It emits the same
progress events as JSON Lines and exits successfully only after `completed` with
`provenOptimal: true`. This is the primary AI/debug interface; the UI and CLI
must call the same state adapters and search engine.

No unauthenticated write-capable network server is added. If a future MCP write
tool is needed, it will wrap the same scenario commands and require explicit
local enablement.

## Future Rules

Damage scoring receives a `combatContext` containing enemy tags and multiplier
rules. Equipment constraints receive named reservation policies and capability
requirements. This permits later implementation of event multipliers,
ship/equipment locks, and ASW-specialized aircraft such as Toukai without
changing core enumeration or hiding those rules in branch ordering.

## Verification

### Search regressions

- A 365-air enemy, two-base/four-wave parity scenario finds a fighter-containing
  feasible incumbent before proof completes and eventually proves the same
  optimum as the exhaustive oracle.
- Detailed sample count no longer limits the number of candidate loadouts.
- Reversing inventory order does not change the optimum or proof result.
- Theoretical inventory stays grouped and does not create thousands of concrete
  candidates or repeated `missing-*` output.
- Cancellation returns `cancelled` with the incumbent and never claims optimality.
- Progress counts are monotonic and completion reaches 100% when total work is
  known.

### Enemy-data regressions

- Selecting a known abyssal ship creates the expected equipment slots and air
  power from Navy Album plus Poi master data.
- Unknown new-event ships display a missing-data warning and no fabricated air.
- Manual slot overrides survive normalization and master refresh.
- 6-4 boss, 6-5 boss, and at least three high-air event boss fixtures reproduce
  noro6 enemy-air totals and threshold lines.

### End-to-end verification

- Run the CLI against pinned fixtures and a live Poi MCP inventory snapshot.
- Compare production exact-search output with the exhaustive oracle on reduced
  versions of every real-map case.
- Run full unit/type/package checks.
- Install the development package into Poi, restart Poi, select fleets through
  the new controls, and verify progress, incumbent updates, completion, and
  imported loadouts in the actual window.

## Release

The feature is developed on `codex/lbas-exact-search-ux`. After all gates pass,
the branch is pushed, merged to `main` only with the user's requested release
flow, installed into Poi for runtime verification, and published as the next
minor npm release because the interaction and automation surfaces are additive
but substantial.
