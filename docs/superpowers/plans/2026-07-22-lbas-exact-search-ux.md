# LBAS Exact Search and Enemy Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the attacker-first bounded recommendation with a background exact optimizer that publishes feasible incumbents and proof progress, add map/enemy-ship selection, and expose the same engine through a headless CLI.

**Architecture:** Keep formulas and scoring pure, add an event-producing search core, and run it in a Node worker so Poi remains responsive. Normalize Poi/Navy Album/noro6 data behind catalog adapters. The React UI and JSONL CLI consume the same scenario and search-event contracts.

**Tech Stack:** CommonJS, React 18, Node `worker_threads`, Vitest, Poi Redux master data, Navy Album abyssal data, noro6 map/master JSON, existing Poi HTTP/MCP bridge.

---

### Task 1: Lock the Failure Into Regression Tests

**Files:**
- Create: `test/search-session.test.js`
- Modify: `test/optimizer.test.js`
- Modify: `test/poi-data.test.js`

- [ ] **Step 1: Add the 365-air four-wave regression**

Create a two-base fixture containing reachable fighters, land attackers, and more than ten damage-first distractions. Assert that the first emitted incumbent contains a fighter, has non-zero all-wave fulfillment, and that the final result is proved optimal.

```js
const scenario = detailedParityScenario({ enemyAir: 365, baseCount: 2 });
const events = collectSearchEvents({
  ...scenario,
  equipment: fighterCapableInventory(),
  simulationOptions: { seed: '365-parity', sampleCount: 64 },
});

expect(events.find((event) => event.type === 'incumbent').plan)
  .toSatisfy((plan) => plan.bases.flatMap((base) => base.loadout)
    .some((plane) => plane?.isFighter));
expect(events.at(-1)).toMatchObject({
  type: 'completed',
  result: { search: { status: 'optimal', provenOptimal: true } },
});
```

- [ ] **Step 2: Prove the current implementation fails**

Run:

```powershell
npx vitest run test/search-session.test.js test/optimizer.test.js -t "365-air|sample count"
```

Expected: FAIL because no search-session API exists and detailed simulation still stops after ten full candidates.

- [ ] **Step 3: Add inventory-order and exhaustive-oracle assertions**

For a reduced inventory, compare the production result with `optimizeLoadoutsExhaustive`. Repeat with reversed equipment order and require identical `canonicalKey` and score.

- [ ] **Step 4: Add the theoretical-expansion regression**

Assert that a three-base theoretical catalog reports grouped quantities and does not return eleven copies of the same missing master item unless the configured missing-copy limit permits it.

- [ ] **Step 5: Commit the red tests**

```powershell
git add test/search-session.test.js test/optimizer.test.js test/poi-data.test.js
git commit -m "test: capture exact LBAS search regressions"
```

### Task 2: Add the Search Event and Cancellation Contract

**Files:**
- Create: `src/search-events.js`
- Create: `src/search-session.js`
- Test: `test/search-session.test.js`

- [ ] **Step 1: Define immutable event factories**

Implement and export:

```js
const SEARCH_PHASES = Object.freeze({
  FINDING_FEASIBLE: 'finding_feasible',
  IMPROVING: 'improving',
  PROVING_OPTIMAL: 'proving_optimal',
});

function progressEvent(state) {
  return Object.freeze({
    type: 'progress',
    phase: state.phase,
    nodesExplored: state.nodesExplored,
    nodesPruned: state.nodesPruned,
    candidatesEvaluated: state.candidatesEvaluated,
    simulationSamplesEvaluated: state.simulationSamplesEvaluated,
    elapsedMs: state.elapsedMs,
    completedWork: state.completedWork,
    totalWork: state.totalWork,
  });
}
```

- [ ] **Step 2: Create a synchronous event collector around the optimizer**

`runSearchSession(options)` returns `{ events, result }` for unit tests. It injects callbacks into `optimizeLoadouts`, records `started`, `phase_changed`, `progress`, `incumbent`, and final events, and accepts `isCancelled()`.

- [ ] **Step 3: Make cancellation honest**

When cancellation becomes true, preserve the last incumbent and return:

```js
{
  search: {
    status: 'cancelled',
    provenOptimal: false,
  },
  results: incumbent ? [incumbent] : [],
}
```

- [ ] **Step 4: Run focused tests**

```powershell
npx vitest run test/search-session.test.js
```

Expected: all event-order, monotonic-progress, and cancellation tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/search-events.js src/search-session.js test/search-session.test.js
git commit -m "feat: add LBAS search session events"
```

### Task 3: Fix Detailed Ordering and Remove the Ten-Candidate Cap

**Files:**
- Modify: `src/optimizer.js`
- Modify: `src/search-score.js`
- Modify: `src/wave-simulator.js`
- Test: `test/optimizer.test.js`
- Test: `test/search-session.test.js`

- [ ] **Step 1: Apply target air as a detailed-search necessary bound**

In `walkBaseAssignments`, compute `requiredAir` for both static and detailed searches from the first wave assigned to the base. Detailed mode may use it only as a necessary initial-state bound; stochastic simulation remains the final comparator.

```js
const requiredAir = requiredAirForState(
  prepared.enemyAir,
  targetStateForBase(prepared.waveTargets, baseIndex),
);
```

- [ ] **Step 2: Order detailed branches by target deficit before damage**

Add `detailedGroupOrderScore(group, requiredAir)` returning this lexicographic shape:

```js
{
  feasibility: Math.min(requiredAir, group.slotAirPower),
  range: Number(group.representative.radius) || 0,
  damage: group.damagePower,
  scarcity: -1 / Math.max(1, group.instances.length),
  canonicalKey: group.key,
}
```

Use this score for detailed branch order. Complete-plan ranking remains unchanged.

- [ ] **Step 3: Remove the default detailed simulation work cap**

`simulationWorkBudget` defaults to `Infinity`. Keep a finite value only when a caller explicitly requests a bounded diagnostic run. Sample count controls precision, not how many candidate loadouts may be considered.

- [ ] **Step 4: Emit incumbent and progress callbacks**

Accept `onProgress`, `onIncumbent`, and `isCancelled` in optimizer options. Call `onIncumbent(plan, searchState)` only when `retainPlan` changes rank 1. Emit throttled progress every 2,048 consumed nodes and on each phase change.

- [ ] **Step 5: Stop evaluating a fixed sample candidate once it cannot win**

Extend detailed simulation with `incumbentScore` and evaluate deterministic sample coordinates incrementally. If:

```js
(successfulSamples + remainingSamples) / totalSamples < incumbentFulfillment
```

stop that candidate and return a score marked `prunedBySimulationBound`. Never use statistical confidence as a proof bound.

- [ ] **Step 6: Run optimizer and exhaustive tests**

```powershell
npx vitest run test/optimizer.test.js test/exhaustive-optimizer.test.js test/search-session.test.js
```

Expected: 365-air regression passes, production equals exhaustive on reduced fixtures, and no default `budget_exhausted` remains.

- [ ] **Step 7: Commit**

```powershell
git add src/optimizer.js src/search-score.js src/wave-simulator.js test/optimizer.test.js test/search-session.test.js
git commit -m "fix: prove detailed LBAS optima without attacker bias"
```

### Task 4: Run Search in a Worker and Render Progress

**Files:**
- Create: `src/optimizer-worker.js`
- Create: `src/search-runner.js`
- Modify: `index.js`
- Modify: `src/ui/OptimizerPanel.js`
- Modify: `i18n/en-US.json`
- Modify: `i18n/ja-JP.json`
- Modify: `i18n/zh-CN.json`
- Modify: `i18n/zh-TW.json`
- Test: `test/search-runner.test.js`
- Test: `test/index.test.js`

- [ ] **Step 1: Add the worker protocol**

The worker accepts `{ type: 'start', requestId, options }`, runs `runSearchSession`, and posts every search event with the same `requestId`. It accepts `{ type: 'cancel', requestId }` and flips the session cancellation flag.

- [ ] **Step 2: Add a testable runner**

`createSearchRunner({ WorkerClass })` exposes:

```js
{
  start(options, onEvent),
  cancel(),
  dispose(),
}
```

The test fake worker verifies stale request events are ignored and dispose terminates the worker.

- [ ] **Step 3: Replace synchronous `runOptimizer`**

Store `searchProgress`, `searchPhase`, `isSearching`, and `results` in component state. The optimize button becomes a cancel button while active. An incumbent event immediately replaces the prominent result. A completed event sets `provenOptimal: true`.

- [ ] **Step 4: Render honest progress**

Show phase label, elapsed time, nodes, pruned nodes, candidates, and simulations. Render a determinate progress bar only when `totalWork` is finite; otherwise use a stable indeterminate bar and numeric counters. Do not render a list of 0% plans before a feasible incumbent exists.

- [ ] **Step 5: Add translations**

Add keys for finding a feasible plan, improving, proving optimal, cancelling, cancelled, elapsed time, pruned nodes, complete candidates, and current best.

- [ ] **Step 6: Run focused tests and typecheck**

```powershell
npx vitest run test/search-runner.test.js test/index.test.js
npm run typecheck
```

- [ ] **Step 7: Commit**

```powershell
git add src/optimizer-worker.js src/search-runner.js src/ui/OptimizerPanel.js index.js i18n test/search-runner.test.js test/index.test.js
git commit -m "feat: run exact LBAS search with live progress"
```

### Task 5: Normalize Theoretical Inventory Policy

**Files:**
- Modify: `src/poi-data.js`
- Modify: `src/search-score.js`
- Modify: `src/ui/OptimizerPanel.js`
- Test: `test/poi-data.test.js`
- Test: `test/search-score.test.js`

- [ ] **Step 1: Introduce an explicit missing-copy policy**

`extractOptimizationPlanes` accepts `missingCopiesPerMaster`, defaulting to `1`. Owned copies remain exact. Missing placeholders carry `missingQuantityPolicy: 1`; increasing the policy is an advanced user choice and part of the scenario/proof definition.

- [ ] **Step 2: Prefer target feasibility before theoretical extremity**

Add `missingCount` to plan summaries. Compare target fulfillment first, then expected damage, then loss/resource, then missing count/scarcity as specified. Display missing count and collapsed per-master quantities on result cards.

- [ ] **Step 3: Make candidate counts meaningful**

The UI shows owned concrete count, unique candidate group count, and missing-copy policy instead of labeling 3,295 placeholders as planes.

- [ ] **Step 4: Run tests**

```powershell
npx vitest run test/poi-data.test.js test/search-score.test.js test/optimizer.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add src/poi-data.js src/search-score.js src/ui/OptimizerPanel.js test/poi-data.test.js test/search-score.test.js test/optimizer.test.js
git commit -m "fix: bound and explain theoretical equipment copies"
```

### Task 6: Add the Enemy Ship Catalog and Advanced Overrides

**Files:**
- Create: `src/enemy-catalog.js`
- Create: `src/ui/EnemyShipPicker.js`
- Modify: `src/poi-data.js`
- Modify: `src/enemy-slots.js`
- Modify: `src/simulator-state.js`
- Modify: `src/ui/EnemyPanel.js`
- Modify: `index.js`
- Test: `test/enemy-catalog.test.js`
- Test: `test/enemy-slots.test.js`
- Test: `test/simulator-state.test.js`

- [ ] **Step 1: Write failing catalog tests**

Fixtures contain `$ships`, `$shipTypes`, `$equips`, and Navy Album records. Assert search by ID/name/reading/type and automatic slot generation:

```js
expect(buildEnemySlots(catalog.byId.get(1764))).toEqual([
  expect.objectContaining({ equipmentMasterId: 1619, currentSlot: 32 }),
  expect.objectContaining({ currentSlot: 30 }),
  expect.objectContaining({ currentSlot: 28 }),
]);
```

- [ ] **Step 2: Implement the adapter**

`buildEnemyCatalog(poiState, { abyssalData })` filters abyssal master IDs, resolves names/types/equipment, records warnings, and exposes `ships`, `byId`, `search(query)`, and `slotsForShip(id)`.

- [ ] **Step 3: Load Navy Album defensively**

Use `require.resolve('poi-plugin-navy-album/assets/abyssal.json')` inside `try/catch`. Also support dependency injection for tests. Missing data returns a catalog warning and never fabricated slots.

- [ ] **Step 4: Preserve override metadata**

Normalize and retain `sourceShipIndex`, `sourceSlotIndex`, `equipmentMasterId`, and `overridden`. Master refresh updates only fields where `overridden !== true`.

- [ ] **Step 5: Replace the raw default table**

Render six searchable enemy-ship combobox rows with name, type, ID, and per-ship air. Put the current slot table in a collapsed "advanced slot overrides" section. Selecting a ship replaces only that ship's generated slots.

- [ ] **Step 6: Run tests and typecheck**

```powershell
npx vitest run test/enemy-catalog.test.js test/enemy-slots.test.js test/simulator-state.test.js test/index.test.js
npm run typecheck
```

- [ ] **Step 7: Commit**

```powershell
git add src/enemy-catalog.js src/ui/EnemyShipPicker.js src/poi-data.js src/enemy-slots.js src/simulator-state.js src/ui/EnemyPanel.js index.js test
git commit -m "feat: select enemy ships from Poi master data"
```

### Task 7: Add Map and Formation Presets

**Files:**
- Create: `src/map-catalog.js`
- Create: `src/map-cache.js`
- Create: `src/ui/MapPresetPicker.js`
- Create: `test/fixtures/noro6/cells-subset.json`
- Create: `test/fixtures/noro6/master-subset.json`
- Modify: `src/ui/EnemyPanel.js`
- Modify: `index.js`
- Test: `test/map-catalog.test.js`

- [ ] **Step 1: Pin real fixtures**

Store source URL, retrieval timestamp, and only the records needed for 6-4 boss, 6-5 boss, 2026 E-3 A1, and at least three high-air event boss points. Preserve original IDs and formation records.

- [ ] **Step 2: Parse noro6 records**

`buildMapCatalog({ cells, master })` exposes cascading `worlds`, `nodes(world)`, `difficulties(node)`, and `formations(node, difficulty)`. Applying a formation returns normalized enemy ship IDs, battle type, radius, fleet anti-air, enemy slots, enemy air, and threshold lines.

- [ ] **Step 3: Add a cached remote loader**

Fetch the documented Firebase `cells.json` and `master.json`, validate top-level shape, and atomically cache them under `%APPDATA%/poi/lbas-bis`. On failure, use the last valid cache and expose source age. Tests inject fetch and cache paths.

- [ ] **Step 4: Build the cascading picker**

Use compact selectors for world, node, difficulty, and formation tabs. Preview enemy air, radius, battle type, thresholds, and fleet ships before the user applies the preset.

- [ ] **Step 5: Verify real enemy air**

Assert all pinned cases match noro6 totals. Include the known E-3 A1 total `219` and thresholds `657/329/147/74`.

- [ ] **Step 6: Commit**

```powershell
git add src/map-catalog.js src/map-cache.js src/ui/MapPresetPicker.js src/ui/EnemyPanel.js index.js test/fixtures/noro6 test/map-catalog.test.js
git commit -m "feat: add noro6-compatible enemy map presets"
```

### Task 8: Add the Headless CLI and Poi MCP Input

**Files:**
- Create: `bin/lbas-bis.js`
- Create: `src/cli.js`
- Create: `src/poi-client.js`
- Modify: `package.json`
- Modify: `README.md`
- Test: `test/cli.test.js`
- Test: `test/poi-client.test.js`

- [ ] **Step 1: Add the package bin contract**

```json
{
  "bin": {
    "lbas-bis": "bin/lbas-bis.js"
  }
}
```

Add `bin` to `files` so npm includes the executable.

- [ ] **Step 2: Implement commands**

Support:

```text
lbas-bis validate --scenario <file>
lbas-bis optimize --scenario <file> [--poi <url>] [--jsonl]
lbas-bis enemy search --name <query> [--poi <url>]
```

`optimize --jsonl` writes one search event per line and exits code `0` only for a proved optimum, `2` for cancelled/incomplete, and `1` for invalid input or runtime failure.

- [ ] **Step 3: Read live Poi data**

`createPoiClient(baseUrl)` calls `/health`, `/equipment`, and `/master` with timeouts and shape validation. It converts the bridge payload through the same `poi-data` and enemy-catalog adapters used by the UI.

- [ ] **Step 4: Add process-level tests**

Spawn the CLI with fixture files. Assert JSONL event order, final proof metadata, invalid-input exit codes, and a mocked Poi HTTP server request sequence.

- [ ] **Step 5: Document AI use**

README examples show how to enable `poi-plugin-mcp`, locate its port file, export a scenario, run exact search, and inspect progress without clicking the UI.

- [ ] **Step 6: Run package verification**

```powershell
npx vitest run test/cli.test.js test/poi-client.test.js test/search-session.test.js
npm pack --dry-run
```

- [ ] **Step 7: Commit**

```powershell
git add bin src/cli.js src/poi-client.js package.json package-lock.json README.md test/cli.test.js test/poi-client.test.js
git commit -m "feat: expose LBAS optimizer through CLI"
```

### Task 9: Real-World Exactness and Runtime Release Gate

**Files:**
- Create: `test/real-map-optimizer.test.js`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add reduced exhaustive proofs for every real map case**

For 6-4 boss, 6-5 boss, and each pinned event boss, create a reduced representative inventory containing fighters, recon, land attackers, and scarce equipment. Require production and exhaustive optimizers to return identical rank-1 scores and canonical keys.

- [ ] **Step 2: Run full-size live-inventory scenarios through CLI**

Enable Poi MCP, run the CLI against the live 815-item inventory for each map case, retain JSONL logs outside the package, and require final `provenOptimal: true`. Record elapsed time, nodes, pruned nodes, and the fighter/attacker/recon composition.

- [ ] **Step 3: Inspect plausibility**

For every case verify target-air probabilities, initial air thresholds, radius, inventory use, missing markers, and fighter inclusion against noro6 input data. Any contradiction creates a new regression test before code changes.

- [ ] **Step 4: Run all gates**

```powershell
npm test
npm run typecheck
npm pack --dry-run
git diff --check
```

Expected: all tests pass, package includes CLI/fixtures/source, and the worktree is clean after commit.

- [ ] **Step 5: Install and verify in Poi**

Install the repository into `%APPDATA%/poi/plugins`, restart Poi, select 6-4/6-5/event fleets, observe an early feasible incumbent, watch progress continue, and require the UI to finish at `proved optimal`. Verify enemy ship search and advanced overrides in the actual window.

- [ ] **Step 6: Bump and publish**

Bump to `0.3.0`, rerun all gates after the version change, commit, push `codex/lbas-exact-search-ux`, merge/push `main` in the requested release flow, publish npm, and verify registry `latest` plus Poi's installed package version.

