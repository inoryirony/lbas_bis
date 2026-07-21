# LBAS Correctness And Continuous Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LBAS formulas, inventory constraints, optimization status, empty slots, and sequential wave simulation correct and explicit.

**Architecture:** Normalize Poi equipment into an independent capability model used by every formula. Replace fixed candidate truncation with grouped branch-and-bound plus a small exhaustive oracle, then add a seeded sequential simulator that uses detailed enemy slots when available and labels total-air-only input as static estimation.

**Tech Stack:** CommonJS JavaScript, React 18 `createElement`, Vitest, TypeScript `checkJs`, Poi equipment state.

---

### Task 1: Aircraft Capabilities And Formula Corrections

**Files:**
- Create: `src/aircraft.js`
- Modify: `src/poi-data.js`
- Modify: `src/air-power.js`
- Modify: `src/damage.js`
- Test: `test/aircraft.test.js`
- Test: `test/poi-data.test.js`
- Test: `test/air-power.test.js`
- Test: `test/damage.test.js`

- [ ] **Step 1: Add failing capability and formula tests**

Add fixtures for API type 53 heavy land attackers, type 49 land recon, type 41 flying boats, types 25/26 ASW patrol, type 56 fighters, type 57 jets, and known bakusen IDs. Add negative fixtures proving types 54/58/59 are not aircraft. Assert:

```js
expect(capabilitiesFor({ masterId: 500, equipType: 53 })).toEqual(expect.objectContaining({
  isPlane: true,
  isAttacker: true,
  isLandAttacker: true,
  isHeavyLandAttacker: true,
}));
expect(defaultSlotSizeForPlane(heavyLandAttacker)).toBe(9);
expect(defaultSlotSizeForPlane(landRecon)).toBe(4);
expect(defaultSlotSizeForPlane(normalLandAttacker)).toBe(18);
expect(calculateEffectiveRadius([shortRecon, longFighter])).toBe(shortRecon.radius);
expect(calculateEffectiveRadius([longRecon, shortFighter])).toBe(extendedRadius);
expect(calculateEffectiveRadius([longRecon, shortFighter, nonAttackingAswPatrol])).toBe(shortestRadius);
```

Add air-state assertions for `NONE`, visible-proficiency lower/upper bounds, heavy attacker air power, and damage using slot size 9.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npm test -- test/aircraft.test.js test/poi-data.test.js test/air-power.test.js test/damage.test.js`

Expected: failures for missing flags, heavy slot size, recon range, empty-base state, and proficiency bounds.

- [ ] **Step 3: Implement `src/aircraft.js`**

Export constants for API type sets and these documented pure functions:

```js
function capabilitiesFor({ masterId, equipType, iconType, antiAir, bombing, torpedo, asw })
function applyAircraftCapabilities(plane)
function aircraftEquivalenceKey(plane)
```

The equivalence key must include every search-relevant property, improvement, proficiency/internal proficiency, availability, and missing status, but not `instanceId`.

- [ ] **Step 4: Update Poi extraction and formulas**

Populate `equipType`, `iconType`, `asw`, `scout`, independent flags, and optional `internalProficiency`. Split type 26 into bombing 0, 1-3, and 4+ behavior and derive `blocksRangeExtension`. Keep `role` only for compatibility. In `air-power.js`, add `AIR_STATES.none`, `airStateFor(airPower, enemyAir, hasPlane = true)`, proficiency band helpers, capability-based improvement rules, all-plane minimum range, and the ASW extension prohibition. Land-recon air-power coefficients use type 49 and scout 8/9, not master IDs. Hard target checks use visible-band lower bounds and summaries expose possible upper bounds.

In `damage.js`, treat this as a clearly named generic-surface-target power proxy: use nullish current slot handling so slot 0 remains 0; use actual torpedo/bombing plus applicable improvement; use type-specific pre-cap formulas (type 47 uses `0.8 * stat * sqrt(1.8 * slot) + 20`, type 53 uses `0.8 * stat * sqrt(1.8 * slot) + 25`, other supported attackers use their reference category multiplier); apply the 220 soft cap `floor(power > 220 ? 220 + sqrt(power - 220) : power)`; and apply the post-cap 1.8 multiplier only to type 47. Keep target-specific bonuses out and label the result a proxy.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```text
npm test -- test/aircraft.test.js test/poi-data.test.js test/air-power.test.js test/damage.test.js
npm run typecheck
```

Expected: all focused tests pass and typecheck exits 0.

### Task 2: Empty Slots, Global Locks, And Exact Search Status

**Files:**
- Create: `src/search-score.js`
- Create: `src/exhaustive-optimizer.js`
- Rewrite: `src/optimizer.js`
- Modify: `src/simulator-state.js`
- Test: `test/optimizer.test.js`
- Test: `test/exhaustive-optimizer.test.js`
- Test: `test/simulator-state.test.js`

- [ ] **Step 1: Add failing audit regression tests**

Add tests proving:

```js
expect(bestBase.loadout.filter(Boolean)).toHaveLength(3);
expect(bestBase.loadout[3]).toBeNull();
expect(lockedEmptyResult.results[0].bases[0].loadout[1]).toBeNull();
expect(allUsedIds.filter((id) => id === reservedId)).toHaveLength(1);
expect(budgeted.search).toEqual(expect.objectContaining({
  status: 'budget_exhausted',
  provenOptimal: false,
}));
expect(confirmedImpossible.search.status).toBe('infeasible');
expect(duplicateLocked.search.status).toBe('invalid_input');
```

Include a fixture with more than 72 distracting items where the only feasible target-air combination previously fell outside the pool, and a two-base scarce-fighter fixture whose known global optimum differs from greedy base-first selection.

- [ ] **Step 2: Run optimizer tests and confirm failure**

Run: `npm test -- test/optimizer.test.js test/exhaustive-optimizer.test.js test/simulator-state.test.js`

Expected: current forced-four-slot and fixed-truncation implementation fails the new assertions.

- [ ] **Step 3: Implement a shared lexicographic score**

`src/search-score.js` exports documented functions:

```js
function scorePlan(plan)
function comparePlanScores(left, right)
function optimisticPlanScore(partial, remainingGroups, context)
```

Static targets are hard constraints. The static tuple order is damage, negative expected loss/resource cost, margin, and negative scarcity/missing cost. Candidate ordering, bound checks, and final result sorting must use these functions. A canonical equivalence-count plan key is the deterministic final tie-break; Top K excludes plans that differ only by slot permutation or interchangeable instance IDs.

- [ ] **Step 4: Implement the exhaustive oracle**

`exhaustiveOptimize(options)` independently enumerates legal `null | equipment instance` assignments for up to the configured small-case limit, respects locked empty/equipment slots globally, canonicalizes equivalent plans, and returns the same `{ messages, results, search }` shape as the main optimizer. It shares formulas and the final comparator, but no production traversal or pruning code.

- [ ] **Step 5: Replace fixed truncation with grouped branch-and-bound**

Normalize four slot constraints without erasing locked nulls. Reserve every locked instance before searching. Group equivalent equipment by `aircraftEquivalenceKey`, recurse over counts and explicit empty slots, and track selected stable instance IDs only when materializing a result. Apply radius, inventory, locks, and target-air feasibility before score pruning.

Before recursion, normalize each slot to exactly one of `LOCKED_ITEM`, `LOCKED_EMPTY`, or `OPEN`. Duplicate or missing locked instance IDs return `invalid_input`. Return:

```js
search: {
  mode: 'branch-and-bound',
  status: 'optimal' | 'infeasible' | 'budget_exhausted' | 'invalid_input',
  nodesExplored,
  budget,
  provenOptimal,
}
```

Do not use equipment-pool, per-base-candidate, or found-result fixed stop constants. `maxResults` limits retained Top K output, not exploration. For every unassigned base, enumerate a relaxed single-base envelope from the current remaining groups while ignoring competition with other unassigned bases. The envelope exactly applies slots, radius, recon multiplier, slot size, and both static wave targets, and returns independent maximum damage and margin. Reusing a group in several base envelopes is deliberately optimistic. Prune only when an envelope is infeasible or `compareScore(upperBound, kthScore) < 0`; never prune equality.

- [ ] **Step 6: Add randomized oracle comparison**

Generate deterministic small inventories with a seeded test RNG. For at least 100 cases, compare feasibility, status, complete Top K scores, and canonical plan keys between `optimizeLoadouts({ nodeBudget: Infinity })` and `exhaustiveOptimize`. Also generate random partial search states, exhaustively enumerate their completions, and assert the production upper bound is never lower than the true best completion.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```text
npm test -- test/optimizer.test.js test/exhaustive-optimizer.test.js test/simulator-state.test.js
npm run typecheck
```

Expected: regressions and 100 randomized oracle comparisons pass.

### Task 3: Sequential Wave Simulation

**Files:**
- Create: `src/random.js`
- Create: `src/wave-simulator.js`
- Modify: `src/simulator-state.js`
- Modify: `src/simulator-calc.js`
- Modify: `src/optimizer.js`
- Test: `test/wave-simulator.test.js`
- Test: `test/simulator-calc.test.js`

- [ ] **Step 1: Add failing deterministic simulation tests**

Create a detailed enemy with two slots and fixed random samples. Assert the first wave changes enemy slot counts and enemy air power before wave two, a concentrated base does not lose its own aircraft until its second wave, a separately dispatched base loses aircraft after each wave, the same seed reproduces exactly, and total-air-only input returns `mode: 'static'` without slot mutation.

```js
expect(result.mode).toBe('detailed');
expect(result.waves[1].enemyAirBefore).toBe(result.waves[0].enemyAirAfter);
expect(result.waves[1].enemyAirBefore).toBeLessThan(result.waves[0].enemyAirBefore);
expect(simulateWaves(input)).toEqual(simulateWaves(input));
expect(staticResult.limitations).toContain('STATIC_ENEMY_AIR');
```

- [ ] **Step 2: Run simulation tests and confirm failure**

Run: `npm test -- test/wave-simulator.test.js test/simulator-calc.test.js`

Expected: missing simulator module and repeated fixed enemy air fail.

- [ ] **Step 3: Implement seeded random and stage-one loss formulas**

`src/random.js` exports `createSeededRandom(seed)` and a deterministic common-random-number helper keyed by `(seed, sample, wave, side, slot, draw)`. `src/wave-simulator.js` exports documented functions:

```js
function playerStageOneLoss(stateKey, slotSize, random)
function enemyStageOneLoss(stateKey, slotSize, random)
function simulateWaveSequence(options)
function monteCarloWaveSequence(options)
```

Use the reference formulas from `noro6/kc-web`: player constants `[1,3,5,7,10]` and enemy constants `[10,8,6,4,1]`, explicitly mapped from supremacy through loss rather than using rank as an array index. Player loss uses the reference 0.001-discrete random draw, jets multiply raw loss by 0.6, and non-attacking ASW patrol planes multiply it by 0.91. Clamp slots at zero and recompute air power from current slots after each wave. Enemy loss always occurs after a wave; own loss timing follows concentrated/separate dispatch semantics.

- [ ] **Step 4: Extend enemy state and summaries**

Detailed enemy slots use `{ instanceId, name, antiAir, currentSlot, maxSlot }`. Normalization validates finite nonnegative values. `calculateSimulatorSummary` delegates detailed mode to Monte Carlo and static mode to existing thresholds, always returning `calculationMode` and `limitations`.

- [ ] **Step 5: Integrate simulation metadata into plan summaries**

Plans receive wave probabilities and expected damage/loss metrics when detailed enemy data is present. Static plans remain branch-and-bound on deterministic hard thresholds and state `STATIC_ENEMY_AIR`. Detailed plan ranking is a pure function of plan plus simulation options; until a proven probability bound is implemented, it performs no score pruning and reports `provenOptimal: true` only after complete enumeration.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```text
npm test -- test/wave-simulator.test.js test/simulator-calc.test.js test/optimizer.test.js
npm run typecheck
```

Expected: deterministic sequence and integration tests pass.

### Task 4: UI Labels, Detailed Enemy Input, And Result Honesty

**Files:**
- Modify: `src/ui/EnemyPanel.js`
- Modify: `src/ui/BaseTable.js`
- Modify: `src/ui/OptimizerPanel.js`
- Modify: `src/ui/WaveStatusTable.js`
- Modify: `src/ui/SimulatorPanel.js`
- Modify: `index.js`
- Modify: `i18n/en-US.json`
- Modify: `i18n/ja-JP.json`
- Modify: `i18n/zh-CN.json`
- Modify: `i18n/zh-TW.json`
- Test: `test/index.test.js`
- Test: `test/import-plan.test.js`

- [ ] **Step 1: Add failing structural UI tests**

Assert rendered output contains Chinese labels for static estimate/detailed simulation, proven optimal/not proven, empty slot, and uniform minimum proficiency. Assert theoretical missing equipment retains `未持有` marking and import preserves locked null slots.

- [ ] **Step 2: Run UI tests and confirm failure**

Run: `npm test -- test/index.test.js test/import-plan.test.js`

Expected: new labels and locked-empty import behavior are missing.

- [ ] **Step 3: Add controls and metadata rendering**

Allow an empty equipment option and lock it. Enemy mode toggles between total air and detailed slot rows; detailed rows edit plane name, anti-air, and count. Display search `status`, `nodesExplored`, and `provenOptimal`. Rename the current minimum proficiency label to uniform minimum visible proficiency.

- [ ] **Step 4: Add all four locale keys and wire state updates**

Add equivalent strings in every locale and immutable enemy-slot state helpers in `simulator-state.js`. Keep controls compact and inside the existing table-oriented Poi UI.

- [ ] **Step 5: Run UI tests and typecheck**

Run:

```text
npm test -- test/index.test.js test/import-plan.test.js
npm run typecheck
```

Expected: UI smoke tests and typecheck pass.

### Task 5: Reference Fixtures, Documentation, And Release Verification

**Files:**
- Create: `test/reference-fixtures.test.js`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Add reference fixtures**

Encode source-cited fixtures for heavy slot 9, recon slot 4, all-plane minimum range, ASW no-extension, internal proficiency bands, air-state NONE, and stage-one loss boundaries. Include comments naming the matching `kc-web` source file/function.

- [ ] **Step 2: Update documentation and plugin copy**

Document detailed continuous simulation, static estimate limitations, search status meanings, empty/locked slots, missing-equipment display, and the uniform proficiency threshold. Remove claims that every result is globally optimal unless `provenOptimal` is true.

- [ ] **Step 3: Run complete verification**

Run:

```text
npm test
npm run typecheck
npm pack --dry-run
```

Expected: all tests pass, typecheck exits 0, and package output includes plugin entry, sources, locales, README, and license.

- [ ] **Step 4: Validate Poi installation**

Confirm `C:\Users\12566\AppData\Roaming\poi\plugins\node_modules\poi-plugin-lbas-bis` is a junction targeting this repository. Recreate only that exact junction if missing or incorrect. Restart Poi is left to the user if the process is open.

- [ ] **Step 5: Review, commit, and push**

Check `git status --short --branch`, `git diff --check`, and `git diff --stat`. Commit only intended files with a focused message, fetch `origin/main` via `http://127.0.0.1:7897`, rebase or resolve only if safe, then push the current branch. Never reset unrelated work.

## Self-Review

- Spec coverage: capability model and formulas are Task 1; empty slots, locks, exact-status search, grouping, branch-and-bound, exhaustive oracle, and random comparisons are Task 2; sequential state mutation and Monte Carlo are Task 3; user-visible honesty and controls are Task 4; cross-reference and release checks are Task 5.
- Placeholder scan: no deferred implementation markers or unspecified test steps remain.
- Type consistency: detailed enemy slots use `currentSlot/maxSlot`; search status uses `optimal/infeasible/budget_exhausted/invalid_input`; every optimizer path returns `{ messages, results, search }`; `provenOptimal` is true only for completed exhaustive or branch-and-bound search, and detailed score pruning is disabled until a proven bound exists.
