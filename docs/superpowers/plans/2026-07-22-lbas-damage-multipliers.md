# LBAS Damage Multipliers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact, custom target/equipment damage multiplier rules shared by the UI, CLI, simulator, and optimizer.

**Architecture:** A focused `combat-context` module owns normalization, validation, matching, and stacking. Existing damage helpers consume that normalized context, and every exact-search and simulation path forwards it. Simulator state owns the editable scenario context; the enemy panel renders a collapsed custom editor.

**Tech Stack:** CommonJS JavaScript, React without JSX, Vitest, Node worker threads, Poi plugin runtime.

---

### Task 1: Combat Context Rule Engine

**Files:**
- Create: `src/combat-context.js`
- Create: `test/combat-context.test.js`

- [ ] **Step 1: Write failing tests for normalization, validation, matching, and stacking**

Test that same-group rules take the maximum, separate groups multiply, target
tags and equipment selectors are both required, no matches return `1`, and
invalid selectors/multipliers return validation errors.

- [ ] **Step 2: Verify the focused tests fail**

Run: `npx vitest run test/combat-context.test.js`
Expected: FAIL because `src/combat-context.js` does not exist.

- [ ] **Step 3: Implement the minimal rule engine**

Export `normalizeCombatContext`, `validateCombatContext`, and
`equipmentDamageMultiplier`. Normalize tags and numeric lists without mutating
input. Match all target tags and either equipment selector. Group by explicit
group or rule ID, take the maximum per group, and multiply groups.

- [ ] **Step 4: Verify focused tests pass**

Run: `npx vitest run test/combat-context.test.js`
Expected: PASS.

### Task 2: Damage and Exact Search Integration

**Files:**
- Modify: `src/damage.js`
- Modify: `src/optimizer.js`
- Modify: `src/search-score.js`
- Modify: `src/wave-simulator.js`
- Modify: `test/damage.test.js`
- Modify: `test/optimizer.test.js`
- Modify: `test/exhaustive-optimizer.test.js`
- Modify: `test/wave-simulator.test.js`

- [ ] **Step 1: Write failing damage and optimizer tests**

Add a post-cap multiplier assertion, a scenario where a bonus changes the proved
static optimum, and a reduced detailed case whose production score matches the
exhaustive oracle.

- [ ] **Step 2: Verify the focused tests fail for missing multiplier behavior**

Run: `npx vitest run test/damage.test.js test/optimizer.test.js test/exhaustive-optimizer.test.js test/wave-simulator.test.js`
Expected: FAIL on bonus-adjusted damage/plan assertions.

- [ ] **Step 3: Forward `combatContext` through every damage path**

Apply `equipmentDamageMultiplier` after existing post-cap modifiers. Store the
normalized context in prepared optimizer input. Pass it through grouped features,
candidate summaries, exact branch bounds, optimistic scores, and fixed-sample
simulation maximums. Do not alter air-power constraints.

- [ ] **Step 4: Verify exact-search tests pass**

Run the same focused Vitest command.
Expected: PASS, including exhaustive equality.

### Task 3: Scenario State, CLI, and Worker Transport

**Files:**
- Modify: `src/simulator-state.js`
- Modify: `src/cli.js`
- Modify: `test/simulator-state.test.js`
- Modify: `test/cli.test.js`
- Add: `examples/cli-custom-multipliers.json`

- [ ] **Step 1: Write failing state and CLI tests**

Assert that state normalization preserves a custom context, optimizer export
contains it, invalid rules make CLI validation fail, and a valid CLI scenario
streams a proved optimal multiplier-aware result.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run test/simulator-state.test.js test/cli.test.js`
Expected: FAIL because `combatContext` is not exported or validated.

- [ ] **Step 3: Implement state and CLI propagation**

Normalize `combatContext` in simulator state, include it in optimizer input for
both enemy modes, and validate it before CLI optimize/validate. Worker messages
already clone plain scenario data and require no alternate model.

- [ ] **Step 4: Verify state and CLI tests pass**

Run the same focused Vitest command.
Expected: PASS.

### Task 4: Custom Multiplier UI

**Files:**
- Create: `src/ui/MultiplierRuleEditor.js`
- Modify: `src/ui/EnemyPanel.js`
- Modify: `src/ui/SimulatorPanel.js`
- Modify: `index.js`
- Modify: `i18n/zh-CN.json`
- Modify: `i18n/zh-TW.json`
- Modify: `i18n/ja-JP.json`
- Modify: `i18n/en-US.json`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write failing panel interaction tests**

Render the editor, add a custom rule, edit target tags/master IDs/group/multiplier,
disable it, remove it, and assert the shared scenario payload contains normalized
values.

- [ ] **Step 2: Verify the UI tests fail**

Run: `npx vitest run test/index.test.js`
Expected: FAIL because the editor and handlers do not exist.

- [ ] **Step 3: Implement the collapsed editor and immutable handlers**

Use a `details` section, labeled inputs, a checkbox for enabled, and icon buttons
for add/remove. Every edit marks the rule custom/overridden. Keep dimensions
stable and reuse existing compact table styles.

- [ ] **Step 4: Verify UI tests pass**

Run: `npx vitest run test/index.test.js`
Expected: PASS.

### Task 5: Full Verification and Release Installation

**Files:**
- Modify only files required by failures found during verification.

- [ ] **Step 1: Run all automated gates**

Run: `npm test`, `npm run typecheck`, and `git diff --check`.
Expected: all tests pass, typecheck exits zero, and no whitespace errors.

- [ ] **Step 2: Run real CLI scenarios**

Run the 6-4, 6-5, event denial, and custom multiplier examples against the live
Poi inventory. Confirm every completed search reports `provenOptimal: true` and
that the multiplier fixture changes damage and the selected loadout as expected.

- [ ] **Step 3: Install into real Poi and perform UI smoke testing**

Install the local package under `%APPDATA%/poi/plugins`, restart Poi, edit one
custom multiplier rule, run optimization, observe an incumbent/progress/proved
optimal completion, and verify no worker remains.

- [ ] **Step 4: Commit and push**

Commit only multiplier-related changes and push `main` to `origin`.

- [ ] **Step 5: Publish and reinstall the npm package**

Publish the current version only when npm authentication permits, verify the
registry tarball/version, reinstall from the registry into Poi, and repeat the
smoke check. Never use credentials exposed in chat.
