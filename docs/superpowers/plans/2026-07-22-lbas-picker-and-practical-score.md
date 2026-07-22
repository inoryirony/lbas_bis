# LBAS Picker and Practical Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make aircraft selection usable with a large Poi inventory, align blacklists and air-state controls with user expectations, preserve honest search progress, and rank E3P1/E2P3 loadouts with a reference-backed practical score.

**Architecture:** Add a focused searchable-picker module consumed by `BaseTable`, keep filter enforcement in `index.js`, and extend the existing damage adapter rather than embedding formulas in UI code. Search-event and seed changes remain inside their current ownership boundaries.

**Tech Stack:** CommonJS, React 18, Vitest, TypeScript check-JS, Poi HTTP bridge.

---

### Task 1: State and picker behavior

**Files:**
- Create: `src/equipment-search.js`
- Create: `src/ui/EquipmentPicker.js`
- Modify: `src/ui/BaseTable.js`
- Modify: `src/ui/SimulatorPanel.js`
- Modify: `src/equipment-filter.js`
- Modify: `index.js`
- Modify: `src/simulator-state.js`
- Modify: `src/ui/WaveStatusTable.js`
- Modify: `i18n/*.json`
- Test: `test/equipment-search.test.js`
- Test: `test/index.test.js`

- [ ] Write tests that require `loss` parsing/rendering, type/name ordering,
  case/width/simplified-traditional/fuzzy matching, and a preserved but disabled
  blacklisted current aircraft.
- [ ] Run `npx vitest run test/equipment-search.test.js test/index.test.js` and
  confirm the new assertions fail for the missing behavior.
- [ ] Implement `normalizeEquipmentQuery`, `rankEquipmentMatches`, and
  `sortEquipmentChoices` as pure functions, then build `EquipmentPicker` on those
  functions and pass filter state through `SimulatorPanel`.
- [ ] Reject excluded IDs in `updateSlotPlane` after resolving current effective
  filters; retain an already selected excluded plane only until it is changed.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Monotonic progress and prompt incumbent

**Files:**
- Modify: `src/search-events.js`
- Modify: `src/detailed-exact-solver.js`
- Test: `test/search-session.test.js`
- Test: `test/optimizer.test.js`

- [ ] Add an event-chain test that fails unless `totalNodesExplored` survives
  `progressEvent` and never decreases between seed and proof.
- [ ] Add a large distinct-inventory regression that records work before the
  first incumbent and fails when the static seed consumes its old multi-million
  node allowance without publishing a plan.
- [ ] Forward cumulative counters in search events and split feasible seeding
  from post-incumbent improvement so the fallback has a strict first-result work
  bound.
- [ ] Run `npx vitest run test/search-session.test.js test/optimizer.test.js` and
  confirm both regressions and existing exact-proof tests pass.

### Task 3: Reference-backed practical score

**Files:**
- Modify: `src/poi-data.js`
- Modify: `src/damage.js`
- Modify: `src/wave-simulator.js`
- Modify: `src/search-score.js`
- Modify: `src/static-exact-solver.js`
- Modify: `src/detailed-exact-solver.js`
- Test: `test/poi-data.test.js`
- Test: `test/damage.test.js`
- Test: `test/reference-fixtures.test.js`
- Test: `test/optimizer.test.js`

- [ ] Pin the official accuracy field and owned `+10 銀河` / `銀河(江草隊)`
  score components in failing tests.
- [ ] Implement only accuracy and proficiency expectation terms verified against
  kc-web/KC3; expose raw power and expectation factors for explanation.
- [ ] Apply the same practical score to candidate ordering, upper bounds, full
  simulation, and final comparison, retaining admissible bounds.
- [ ] Run the focused damage, reference, and optimizer suites.

### Task 4: Real-scenario comparison and release

**Files:**
- Create or modify: `examples/poi-event-e3-p1.json`
- Create or modify: `examples/poi-event-e2-p3.json`
- Modify: `README.md`
- Test: `test/cli.test.js`

- [ ] Add a CLI comparison path or fixture runner that evaluates a supplied
  loadout without searching, using the same simulator score as optimization.
- [ ] Compare the guide and optimizer E2P3 loadouts under identical map,
  formation, targets, proficiency, and multiplier inputs; record why the winner
  wins and do not claim superiority on incomplete data.
- [ ] Run live Poi serial checks for 6-4, 6-5, E3P1, and E2P3, allowing every
  proof process to exit before starting the next.
- [ ] Run `npm test`, `npm run typecheck`, `npm pack --dry-run`, and
  `git diff --check`; confirm no repository Node process remains.
- [ ] Restart Poi, verify the picker and imported plans in the installed plugin,
  review the final diff, commit intended files excluding the pre-existing
  `bin/lbas-bis.js` line-ending change, push `main`, and attempt npm publish.
