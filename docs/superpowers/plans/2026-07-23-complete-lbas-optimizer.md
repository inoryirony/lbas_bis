# Complete LBAS Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every completion gate in `handoff.md`, verify the exact optimizer against real Poi inventory, and publish the result with clean Git identity.

**Architecture:** Preserve one deterministic fixed-sample combat model shared by simulation, exact-search scoring, and certified optimistic bounds. Keep the main thread as the only writer and Git owner; performance work follows a one-change look/try/check/keep-or-undo loop, while model additions require source metadata and exact-vs-exhaustive regression fixtures.

**Tech Stack:** CommonJS, React 18, Vitest, TypeScript check-JS, deterministic JSON/JSONL CLI, Poi HTTP bridge, Git/GitHub CLI.

---

### Task 1: Repair land-recon HP damage without weakening proof safety

**Files:**
- Modify: `src/combat-resolution.js`
- Modify: `src/wave-simulator.js`
- Modify: `src/combat-exact-solver.js`
- Test: `test/combat-resolution.test.js`
- Test: `test/wave-simulator.test.js`
- Test: `test/optimizer.test.js`
- Test: `test/exhaustive-optimizer.test.js`

- [x] **Step 1: Add three failing regressions**

Add a primitive assertion that `reconModifier: 1.15` changes attack power from 149 to 172, a two-wave assertion that master 312 changes HP damage from 298 to 344, and an exact-vs-exhaustive allocation counterexample where the skilled recon belongs with the stronger attacker.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run test/combat-resolution.test.js test/wave-simulator.test.js test/optimizer.test.js test/exhaustive-optimizer.test.js
```

Expected: the primitive and wave tests report equal damage with and without recon; the bound counterexample selects the lower-scoring seed or mismatches exhaustive search.

- [x] **Step 3: Connect one shared modifier through real combat and the bound**

Use the filtered canonical base planes and pass the base modifier explicitly:

```js
const reconModifier = landBasedReconDamageModifier(planes);
const result = resolveAttackSequence({
  planes,
  ships,
  reconModifier,
  combatContext: options.combatContext,
});
```

In `resolveAttackSequence()` and `maximumFixedSampleCombatScore()` pass:

```js
reconModifier,
```

to `calculatePlaneTargetAttackPower()`. Precompute one modifier per base before the target matrix is built.

- [x] **Step 4: Run focused and full verification**

Run the focused command, then `npm test` and `npm run typecheck`; all must pass.

### Task 2: Lock in import-without-cancellation behavior

**Files:**
- Modify: `test/index.test.js`
- Verify: `index.js`

- [x] **Step 1: Strengthen the existing integration regression**

Start the real panel search callback, emit an incumbent, click the rendered import button, then emit `completed`. Assert that `searchGeneration` is unchanged, `cancel()` is not called, the simulator receives the plan, and the final optimal event is accepted.

- [x] **Step 2: Prove the regression detects the historical implementation**

Temporarily replace `importPlan()` with `this.updateSimulator(...)`, run the single test and observe failure, then restore the current direct `setState()` implementation and rerun green.

### Task 3: Prove 4096-sample 6-5 combat within five minutes

**Files:**
- Modify: `src/combat-exact-solver.js`
- Modify only if evidence requires: `src/wave-simulator.js`
- Test: `test/optimizer.test.js`
- Test: `test/exhaustive-optimizer.test.js`
- Fixture: `examples/poi-6-5-combat.json`
- Record: `handoff.md`

- [x] **Step 1: Freeze the evaluator**

Use live owned inventory, 6-5 M formation index 0, two bases, four parity waves, combat objective, seed `poi-6-5-m-combat-v1`, 4096 samples, unlimited node and simulation budgets, and a 300-second external timeout. Success requires exit code 0, `status=optimal`, `provenOptimal=true`, and all-wave fulfillment 1.

- [x] **Step 2: Measure the post-recon baseline**

Record elapsed time, nodes, candidates, each prune counter, sample evaluations, peak RSS, incumbent score, and process cleanup.

- [x] **Step 3: Reuse first-base continuation state**

Represent each complete first-base frontier item as:

```js
{
  selectedCounts,
  enemySlotStateBySample,
  enemyHpStateBySample,
  scoreUpperBound,
}
```

Evaluate second-base assignments from this continuation instead of replaying first-base waves. Canonicalize equal continuation states and keep only nondominated frontier entries. Every retained optimization must match exhaustive random fixtures before benchmarking.

- [x] **Step 4: Add a safe partial-branch combat ceiling if continuation reuse is insufficient**

The ceiling may assume perfect targeting, full initial slots, maximum reachable recon modifier, zero armor, and no losses. Prune only on strict lexicographic loss to the incumbent; equal sink/HP bounds must survive for lower-priority tie-breakers.

- [x] **Step 5: Keep only attributable wins**

After each single change, run oracle tests and the frozen 6-5 evaluator. Revert a change that alters the winner, weakens proof semantics, increases wall time materially, or fails to reduce the dominant work counter.

### Task 4: Complete the declared combat model

**Files:**
- Modify: `src/combat-resolution.js`
- Modify: `src/damage.js`
- Modify: `src/wave-simulator.js`
- Modify: `src/combat-context.js`
- Modify: `src/simulator-state.js`
- Modify: `src/ui/MultiplierRuleEditor.js`
- Test: `test/combat-resolution.test.js`
- Test: `test/damage.test.js`
- Test: `test/wave-simulator.test.js`
- Test: `test/combat-context.test.js`
- Test: `test/exhaustive-optimizer.test.js`

- [x] **Step 1: Implement ordinary contact with reserved deterministic coordinates**

Add a versioned contact resolver returning `{ triggered, multiplier, source }`, use the fixed-sample `combat-contact` coordinate, carry contact across the two waves according to the sourced rule, and include the maximum legal contact multiplier in the bound.

- [x] **Step 2: Implement flagship protection**

When a non-flagship target is selected, use a dedicated `combat-flagship-protection` draw and the sourced eligibility/probability rule to redirect to the living flagship. Add main/escort and ineligible-target fixtures.

- [x] **Step 3: Complete submarine and Toukai target eligibility**

Replace the current ASW>=7 patrol-only predicate with an explicit aircraft capability table covering Toukai, land attackers, patrol planes, mixed surface/submarine fleets, and installation exclusions. Add target-dilution and no-eligible-target fixtures.

- [x] **Step 4: Implement special enemy post-cap and PT rules**

Add target tags and sourced post-cap transforms for PT/special enemies after target-specific pre-cap power. Test the complete equipment-by-target matrix and include the maximum transform in the bound.

- [x] **Step 5: Finish event multipliers and lock/tag constraints**

Keep multiplier rules data-driven through `combatContext`; add ship/equipment lock tags as explicit optimizer constraints rather than name-based routing. Validate malformed selectors and prove exact-vs-exhaustive equality with tagged inventories.

- [x] **Step 6: Remove limitation codes only after their fixtures pass**

Delete `FLAGSHIP_PROTECTION_OMITTED`, `CONTACT_OMITTED`, `SPECIAL_ENEMY_POSTCAP_OMITTED`, and `SUBMARINE_TARGETING_PARTIAL` individually when the corresponding focused, oracle, full, and typecheck commands are green.

### Task 5: Add real combat proof fixtures

**Files:**
- Create: `examples/poi-6-4-combat.json`
- Modify: `examples/poi-6-5-combat.json`
- Create: `examples/poi-event-high-air-1-combat.json`
- Create: `examples/poi-event-high-air-2-combat.json`
- Modify: `test/cli.test.js`
- Modify: `README.md`

- [x] **Step 1: Resolve each fixture from map data and live Poi inventory**

Every fixture must contain a concrete `mapSelection`, `optimizationObjective: "combat"`, 4096 fixed samples, deterministic seed, unlimited proof budgets, and no hand-entered replacement for map HP/armor/slots.

- [x] **Step 2: Run all fixtures to strict proof**

For each fixture require `provenOptimal=true`, all-wave fulfillment 1, plausible fighter/attacker/recon composition, and recorded sink/HP/air/loss/resource metrics. A proven infeasible fixture is acceptable only when an independent maximum-air calculation confirms it.

- [x] **Step 3: Add CLI validation coverage**

Validate fixture hydration, deterministic repeatability, combat objective selection, and exit-code semantics in `test/cli.test.js`.

### Task 6: Reload and verify the real Poi workflow

**Files:**
- Verify junction: `C:\Users\12566\AppData\Roaming\poi\plugins\node_modules\poi-plugin-lbas-bis`
- Verify runtime: current Poi process and local bridge health

- [x] **Step 1: Restart Poi only after preserving current game state**

Confirm no repository benchmark process remains, restart Poi, then verify the junction target and `/health` response.

- [x] **Step 2: Exercise the normal narrow-window workflow**

At the user's current narrow pane size, select maps, keep carrier aircraft excluded, resolve the fighter-blacklist warning, obtain the first incumbent, observe animated proof progress, import the incumbent without stopping proof, cancel once, rerun to completion, and confirm no horizontal overflow or unreachable controls.

### Task 7: Document, review, commit, and push

**Files:**
- Modify: `README.md`
- Modify: `handoff.md`
- Modify: `docs/superpowers/specs/2026-07-23-lbas-combat-resolution-design.md`
- Exclude from staging: `bin/lbas-bis.js`

- [x] **Step 1: Update evidence boundaries and remove stale claims**

Document implemented formulas, remaining empirical assumptions, exact proof scope, real fixture results, and the already-clean Git identity history.

- [ ] **Step 2: Run final verification and code review**

Run focused tests, `npm test`, `npm run typecheck`, `git diff --check`, all strict proof fixtures, JSON parsing, repository process audit, and an independent code review. Resolve every actionable finding.

- [ ] **Step 3: Commit explicit paths with the required identity**

Set repository-local author/committer to `inoryirony <82687061+inoryirony@users.noreply.github.com>`, stage explicit verified paths only, confirm `bin/lbas-bis.js` is unstaged, and commit.

- [ ] **Step 4: Audit and push**

Verify every reachable author/committer identity, confirm the GitHub remote, push `main`, compare local and remote commit IDs, and report the exact published state.
