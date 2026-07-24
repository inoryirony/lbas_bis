# Infeasible Filter Diagnostics And Live Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain the real equipment-filter conflict behind the 6-5 infeasible result and make unbounded exact-search progress visibly active.

**Architecture:** Keep hard optimizer constraints unchanged. Detect the narrow UI-only case where filters remove every fighter, append an actionable message only after the solver proves infeasibility, and drive progress activity from streamed elapsed time so animation remains visible in Poi. Countable phases retain an exact percentage plus activity marker; unknown-total phases use a moving pulse.

**Tech Stack:** CommonJS, React `createElement`, Vitest, TypeScript checking.

---

### Task 1: Reproduce both UI failures

**Files:**
- Modify: `test/index.test.js`

- [x] **Step 1: Add a failing filter-conflict integration test**

Create a Poi inventory containing a carrier fighter, a land-based fighter, and a land attacker. Start a search with carrier aircraft disabled and equipment type 48 blacklisted, emit an `infeasible` completion, and assert that the rendered message tells the player to restore fighter candidates.

- [x] **Step 2: Add a failing live-progress test**

Render two live search snapshots without `totalWork` and assert that the application-driven pulse moves as `elapsedMs` advances. Add a countable-work assertion that preserves exact percentage semantics while its activity marker also moves.

- [x] **Step 3: Run the focused tests and verify RED**

Run: `npx vitest run test/index.test.js`

Expected: FAIL because the filter diagnostic is absent and the live progress indicator is a static nested `div`.

### Task 2: Implement the minimum UI fix

**Files:**
- Modify: `index.js`
- Modify: `src/ui/OptimizerPanel.js`
- Modify: `i18n/en-US.json`
- Modify: `i18n/ja-JP.json`
- Modify: `i18n/zh-CN.json`
- Modify: `i18n/zh-TW.json`

- [x] **Step 1: Preserve filter evidence for the active search**

At search start, record a diagnostic only when the unfiltered inventory contains fighters but the filtered candidate list contains none. On an `infeasible` completion, append the localized action message without changing optimizer constraints or results.

- [x] **Step 2: Render honest live progress**

Render an ARIA `progressbar` track. For countable phases, set `aria-valuenow`/`aria-valuemax`, an exact fill, and a moving activity marker. For unknown-total phases, omit numeric ARIA values and move a pulse from streamed `elapsedMs`. Remove the fixed `38%` fallback and do not depend on Chromium's native animation.

- [x] **Step 3: Run the focused tests and verify GREEN**

Run: `npx vitest run test/index.test.js`

Expected: PASS.

### Task 3: Verify the whole change

**Files:**
- Test: `test/index.test.js`

- [x] **Step 1: Run the full suite**

Run: `npm test`

Expected: all tests pass.

- [x] **Step 2: Run type checking**

Run: `npm run typecheck`

Expected: exit code 0.

- [x] **Step 3: Check whitespace and the exact diff**

Run: `git diff --check`

Expected: no new whitespace errors; pre-existing line-ending warnings may remain.
