# LBAS Simulator UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Poi 插件「陆航优化」从单纯表单优化器改成“上方手动可改的陆航制空模拟器，下方优化结果与一键导入”的内嵌插件界面。

**Architecture:** 上方模拟器状态作为唯一界面事实来源，纯函数负责状态归一化、制空线、6 波摘要和导入合并；优化器只接收模拟器导出的约束，包括目标半径、敌制空、每波目标状态、锁定槽位和候选装备模式。UI 保持 Poi `reactClass` 内嵌，不新开页面，并把现在膨胀的 `index.js` 拆成小的 CommonJS React 组件。

**Tech Stack:** Poi plugin CommonJS entry, React 18 `React.createElement`, Vitest, TypeScript `checkJs` style typecheck, existing pure JS calculation modules.

## Global Constraints

- 默认界面语言为中文；所有新增文案同步维护 `zh-CN`、`zh-TW`、`en-US`、`ja-JP`。
- 插件名继续使用「陆航优化」，Poi 插件 id 继续使用 `lbas_bis`。
- 不新开独立页面，不使用浏览器新窗口；继续通过 Poi 插件页嵌入。
- 不做地图/节点预设；敌舰队与敌制空先允许用户手动输入。
- 上方是玩家可手动编辑的模拟器；下方是优化候选结果与导入按钮。
- 默认优化只使用玩家持有装备；“包含未持有理论装备”必须是显式开关。
- 1 个基地航空队按 2 波计算，最多 3 个基地共 6 波。
- 导入优化结果只覆盖未锁定槽位；锁定槽位必须保留原装备。
- 优化时必须支持锁定特定装备/槽位参与计算。
- 本阶段不模拟每波陆航削弱后的敌机连续损耗；相关复选框可以保留为禁用或提示“后续实现”，不能默认参与计算。

---

## Target UI Shape

首屏布局应该接近参考站的“表格模拟器”而不是当前横向表单：

```text
┌──────────────────────────── 基地航空队模拟器 ────────────────────────────┬──────────── 敌舰队 / 目标 ────────────┐
│ 目标半径 [7]   基地队数 [1|2|3]   显示波数: 2/4/6   [清空编成]             │ 敌制空 [72]  海域 [手动]  节点 [手动]  │
├──────────┬──────────────────────────────┬──────┬──────┬──────────────────┼──────────────────────────┬──────┤
│ 基地     │ 装备                         │ 锁定 │ 熟练 │ 本队制空/半径/伤害 │ 敌舰名                   │ 制空 │
├──────────┼──────────────────────────────┼──────┼──────┼──────────────────┼──────────────────────────┼──────┤
│ 第一基地 │ [装备选择]                   │ [ ]  │ [>>] │ 42 / 9 / 180      │ [敌舰选择/手动名称]      │ [72] │
│          │ [装备选择]                   │ [ ]  │ [>>] │                  │ [敌舰选择/手动名称]      │ [0]  │
│          │ [装备选择]                   │ [ ]  │ [>>] │                  │ [敌舰选择/手动名称]      │ [0]  │
│          │ [装备选择]                   │ [ ]  │ [>>] │                  │ [敌舰选择/手动名称]      │ [0]  │
├──────────┴──────────────────────────────┴──────┴──────┴──────────────────┼──────────────────────────┴──────┤
│ 波次状态: 第1波 [均势]  第2波 [均势]  第3波 ... 第6波 ...                  │ 必要线: 确保 216 / 优势 108 / 均势 49 / 劣势 25 │
│ 当前状态: 均势  | 自舰队制空值 42 | 敌舰队制空值 72                         │                                      │
└──────────────────────────────────────────────────────────────────────────┴────────────────────────────────────┘

┌────────────────────────────── 配装优化 ───────────────────────────────┐
│ 候选装备: [仅持有装备] [包含未持有理论装备]   目标: 以模拟器当前设置计算   [计算优化] │
│ 方案表: 排名 / 基地 / 装备 / 锁定冲突 / 6波状态 / 伤害基准 / 缺少装备 / [导入到模拟器] │
└──────────────────────────────────────────────────────────────────────┘
```

响应式收缩规则：

- 宽屏使用左右表格，左侧基地航空队占主要宽度，右侧敌舰队与必要线固定较窄宽度。
- 窄屏按顺序纵向排列：基地航空队、敌舰队、波次状态、配装优化。
- 表格单元格不能依赖内容撑开高度；装备选择、锁定按钮、熟练度选择都应有稳定高度。

## Data Model

新增模拟器状态使用普通对象，方便 React state、测试和导入合并：

```js
const simulatorState = {
  targetRadius: 7,
  baseCount: 1,
  candidateMode: 'owned',
  enemy: {
    mode: 'manual',
    enemyAir: 72,
    areaId: null,
    nodeId: null,
    ships: [
      { id: null, name: '', airPower: 72 },
      { id: null, name: '', airPower: 0 },
      { id: null, name: '', airPower: 0 },
      { id: null, name: '', airPower: 0 },
      { id: null, name: '', airPower: 0 },
      { id: null, name: '', airPower: 0 },
    ],
  },
  bases: [
    {
      name: '第一基地',
      slots: [
        { plane: null, locked: false, proficiency: null, improvement: null },
        { plane: null, locked: false, proficiency: null, improvement: null },
        { plane: null, locked: false, proficiency: null, improvement: null },
        { plane: null, locked: false, proficiency: null, improvement: null },
      ],
    },
  ],
  waves: [
    { baseIndex: 0, waveInBase: 0, targetState: 'parity' },
    { baseIndex: 0, waveInBase: 1, targetState: 'parity' },
  ],
};
```

优化器锁定输入使用更窄的数据结构：

```js
const lockedBases = [
  {
    slots: [
      { plane: planeObjectOrNull, locked: true },
      { plane: null, locked: false },
      { plane: null, locked: false },
      { plane: null, locked: false },
    ],
  },
];
```

---

### Task 1: 模拟器状态与制空摘要

**Files:**
- Create: `src/simulator-state.js`
- Create: `src/simulator-calc.js`
- Test: `test/simulator-state.test.js`
- Test: `test/simulator-calc.test.js`

**Interfaces:**
- Consumes: `calculateBaseAirPower(loadout)`, `calculateEffectiveRadius(loadout)`, `airStateFor(airPower, enemyAir)`, `requiredAirForState(enemyAir, stateKey)` from `src/air-power.js`; `calculateBaseDamagePower(loadout)` from `src/damage.js`.
- Produces:
  - `createEmptySimulatorState(baseCount = 1): SimulatorState`
  - `normalizeSimulatorState(state): SimulatorState`
  - `setBaseCount(state, baseCount): SimulatorState`
  - `setBaseSlot(state, baseIndex, slotIndex, slotPatch): SimulatorState`
  - `setSlotLock(state, baseIndex, slotIndex, locked): SimulatorState`
  - `setWaveTarget(state, waveIndex, targetState): SimulatorState`
  - `simulatorToOptimizerInput(state): { baseCount, targetRadius, enemyAir, targetStates, lockedBases }`
  - `calculateEnemyAirLines(enemyAir): { supremacy, superiority, parity, denial }`
  - `calculateSimulatorSummary(state): { bases, waves, enemyAirLines, totalAirPower, statusKey }`

- [ ] **Step 1: Write failing state tests**

Add `test/simulator-state.test.js`:

```js
import { describe, expect, test } from 'vitest';
import stateModule from '../src/simulator-state.js';

const {
  createEmptySimulatorState,
  setBaseCount,
  setBaseSlot,
  setSlotLock,
  setWaveTarget,
  simulatorToOptimizerInput,
} = stateModule;

describe('simulator state', () => {
  test('creates one base and two waves by default', () => {
    const state = createEmptySimulatorState();

    expect(state.baseCount).toBe(1);
    expect(state.bases).toHaveLength(1);
    expect(state.bases[0].slots).toHaveLength(4);
    expect(state.waves.map((wave) => [wave.baseIndex, wave.waveInBase])).toEqual([[0, 0], [0, 1]]);
    expect(state.enemy.enemyAir).toBe(72);
  });

  test('expands to three bases and six waves without losing first-base slots', () => {
    const ginga = plane('owned-ginga', { masterId: 187, name: '银河', radius: 9 });
    const oneBase = setBaseSlot(createEmptySimulatorState(), 0, 0, { plane: ginga });

    const state = setBaseCount(oneBase, 3);

    expect(state.baseCount).toBe(3);
    expect(state.bases).toHaveLength(3);
    expect(state.bases[0].slots[0].plane).toEqual(ginga);
    expect(state.waves).toHaveLength(6);
    expect(state.waves.map((wave) => wave.baseIndex)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  test('shrinks base count and keeps only matching wave targets', () => {
    const state = setWaveTarget(setBaseCount(createEmptySimulatorState(), 3), 5, 'supremacy');

    const shrunk = setBaseCount(state, 1);

    expect(shrunk.baseCount).toBe(1);
    expect(shrunk.bases).toHaveLength(1);
    expect(shrunk.waves).toHaveLength(2);
    expect(shrunk.waves.map((wave) => wave.targetState)).toEqual(['parity', 'parity']);
  });

  test('exports locked slots and wave targets for optimizer', () => {
    const hayabusa = plane('owned-hayabusa', { masterId: 225, name: '隼64', radius: 7 });
    const state = setWaveTarget(
      setSlotLock(setBaseSlot(createEmptySimulatorState(), 0, 0, { plane: hayabusa }), 0, 0, true),
      1,
      'superiority',
    );

    expect(simulatorToOptimizerInput(state)).toEqual({
      baseCount: 1,
      targetRadius: 7,
      enemyAir: 72,
      targetStates: ['parity', 'superiority'],
      lockedBases: [
        {
          slots: [
            { plane: hayabusa, locked: true },
            { plane: null, locked: false },
            { plane: null, locked: false },
            { plane: null, locked: false },
          ],
        },
      ],
    });
  });
});

function plane(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: 1,
    name: instanceId,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 7,
    improvement: 0,
    proficiency: 7,
    role: 'attacker',
    isLandBased: true,
    torpedo: 14,
    bombing: 14,
    available: true,
    missing: false,
    ...overrides,
  };
}
```

- [ ] **Step 2: Run state test and verify it fails**

Run:

```bash
npm test -- test/simulator-state.test.js
```

Expected: FAIL because `src/simulator-state.js` does not exist.

- [ ] **Step 3: Implement simulator state helpers**

Create `src/simulator-state.js` with CommonJS exports and no React imports. Keep all updates immutable: copy arrays and objects before changing them. Clamp base count to `1..3`; normalize waves to exactly `baseCount * 2`; normalize bases to exactly `baseCount`; normalize slots to exactly `4`.

- [ ] **Step 4: Run state tests and verify they pass**

Run:

```bash
npm test -- test/simulator-state.test.js
```

Expected: PASS.

- [ ] **Step 5: Write failing calculation tests**

Add `test/simulator-calc.test.js`:

```js
import { describe, expect, test } from 'vitest';
import stateModule from '../src/simulator-state.js';
import calcModule from '../src/simulator-calc.js';

const { createEmptySimulatorState, setBaseSlot, setWaveTarget } = stateModule;
const { calculateEnemyAirLines, calculateSimulatorSummary } = calcModule;

describe('simulator calculations', () => {
  test('calculates reference-style necessary air lines for enemy air 72', () => {
    expect(calculateEnemyAirLines(72)).toEqual({
      supremacy: 216,
      superiority: 108,
      parity: 49,
      denial: 25,
    });
  });

  test('summarizes base air power, radius, damage, and two waves', () => {
    let state = createEmptySimulatorState();
    state = setBaseSlot(state, 0, 0, { plane: plane('ginga-1') });
    state = setBaseSlot(state, 0, 1, { plane: plane('ginga-2') });
    state = setBaseSlot(state, 0, 2, { plane: plane('ginga-3') });
    state = setBaseSlot(state, 0, 3, { plane: plane('ginga-4') });
    state = setWaveTarget(state, 0, 'parity');
    state = setWaveTarget(state, 1, 'parity');

    const summary = calculateSimulatorSummary(state);

    expect(summary.bases).toHaveLength(1);
    expect(summary.bases[0].radius).toBe(9);
    expect(summary.bases[0].airPower).toBeGreaterThan(0);
    expect(summary.bases[0].damagePower).toBeGreaterThan(0);
    expect(summary.waves).toHaveLength(2);
    expect(summary.waves[0]).toEqual(expect.objectContaining({
      waveIndex: 0,
      baseIndex: 0,
      targetState: 'parity',
    }));
  });
});

function plane(instanceId) {
  return {
    instanceId,
    masterId: 187,
    name: '银河',
    antiAir: 3,
    intercept: 0,
    antiBomber: 0,
    radius: 9,
    improvement: 0,
    proficiency: 7,
    role: 'attacker',
    isLandBased: true,
    torpedo: 14,
    bombing: 14,
    available: true,
    missing: false,
  };
}
```

- [ ] **Step 6: Run calculation test and verify it fails**

Run:

```bash
npm test -- test/simulator-calc.test.js
```

Expected: FAIL because `src/simulator-calc.js` does not exist.

- [ ] **Step 7: Implement calculation helpers**

Create `src/simulator-calc.js`. Use existing air-power and damage modules; do not duplicate formulas. `calculateEnemyAirLines(72)` must return `216/108/49/25`. Empty slots are ignored for base air power, radius, and damage. If a base has no plane, base radius should be `0`, air power `0`, damage `0`, and state from `airStateFor(0, enemyAir)`.

- [ ] **Step 8: Run task tests**

Run:

```bash
npm test -- test/simulator-state.test.js test/simulator-calc.test.js
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/simulator-state.js src/simulator-calc.js test/simulator-state.test.js test/simulator-calc.test.js
git commit -m "feat: add lbas simulator state model"
```

---

### Task 2: 持有/理论装备候选开关

**Files:**
- Modify: `src/poi-data.js`
- Modify: `test/poi-data.test.js`

**Interfaces:**
- Consumes: existing `extractOwnedPlanes(poiState)`.
- Produces: `extractOptimizationPlanes(poiState, { includeMissing = false, maxCopiesPerMaster = 4, missingProficiency = 7 })`.

- [ ] **Step 1: Add failing tests for default owned-only behavior**

Append to `test/poi-data.test.js`:

```js
test('defaults optimization candidates to owned equipment only', () => {
  const planes = extractOptimizationPlanes(samplePoiStateWithOneGinga(), { maxCopiesPerMaster: 4 });

  expect(planes).toHaveLength(1);
  expect(planes[0]).toEqual(expect.objectContaining({
    instanceId: 1002,
    masterId: 187,
    available: true,
    missing: false,
  }));
});

test('adds theoretical missing copies only when includeMissing is true', () => {
  const planes = extractOptimizationPlanes(samplePoiStateWithOneGinga(), {
    includeMissing: true,
    maxCopiesPerMaster: 4,
  });

  expect(planes).toHaveLength(4);
  expect(planes.filter((plane) => plane.available)).toHaveLength(1);
  expect(planes.filter((plane) => plane.missing)).toHaveLength(3);
});

function samplePoiStateWithOneGinga() {
  return {
    const: {
      $equips: {
        187: {
          api_id: 187,
          api_name: 'Ginga',
          api_type: [21, 38, 47, 37, 4],
          api_tyku: 3,
          api_houk: 0,
          api_bakk: 0,
          api_distance: 9,
          api_raig: 14,
          api_baku: 14,
        },
      },
    },
    info: {
      equips: {
        1002: {
          api_id: 1002,
          api_slotitem_id: 187,
          api_level: 0,
          api_alv: 2,
        },
      },
    },
  };
}
```

Change the existing theoretical test to pass `includeMissing: true`.

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm test -- test/poi-data.test.js
```

Expected: FAIL because current `extractOptimizationPlanes` always adds missing copies.

- [ ] **Step 3: Implement `includeMissing`**

Update `src/poi-data.js` so:

```js
function extractOptimizationPlanes(poiState, options = {}) {
  const includeMissing = options.includeMissing === true;
  const ownedPlanes = extractOwnedPlanes(poiState).map((plane) => ({
    ...plane,
    available: true,
    missing: false,
  }));

  if (!includeMissing) {
    return ownedPlanes;
  }

  // existing theoretical copy generation continues here
}
```

Keep missing copies tagged `available: false` and `missing: true`.

- [ ] **Step 4: Run task tests**

Run:

```bash
npm test -- test/poi-data.test.js
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/poi-data.js test/poi-data.test.js
git commit -m "feat: default optimization to owned equipment"
```

---

### Task 3: 锁定槽位参与优化

**Files:**
- Modify: `src/optimizer.js`
- Modify: `test/optimizer.test.js`

**Interfaces:**
- Consumes: `lockedBases` from `simulatorToOptimizerInput(state)`.
- Produces: `optimizeLoadouts({ equipment, baseCount, targetRadius, enemyAir, targetStates, lockedBases, maxResults })` preserving locked slots.

- [ ] **Step 1: Add failing locked-slot optimizer tests**

Append to `test/optimizer.test.js`:

```js
test('keeps locked equipment in the requested base and fills remaining slots', () => {
  const lockedAttacker = plane('locked-ginga', {
    antiAir: 3,
    radius: 9,
    role: 'attacker',
    torpedo: 14,
    bombing: 14,
    isLandBased: true,
  });
  const result = optimizeLoadouts({
    equipment: [
      lockedAttacker,
      plane('fighter-1', { antiAir: 11, intercept: 5, radius: 7, role: 'fighter', isLandBased: true }),
      plane('attacker-1', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 14, bombing: 14, isLandBased: true }),
      plane('attacker-2', { antiAir: 3, radius: 9, role: 'attacker', torpedo: 13, bombing: 14, isLandBased: true }),
      plane('attacker-3', { antiAir: 2, radius: 8, role: 'attacker', torpedo: 11, bombing: 12, isLandBased: true }),
    ],
    baseCount: 1,
    targetRadius: 7,
    enemyAir: 72,
    targetStates: ['parity', 'parity'],
    lockedBases: [
      {
        slots: [
          { plane: lockedAttacker, locked: true },
          { plane: null, locked: false },
          { plane: null, locked: false },
          { plane: null, locked: false },
        ],
      },
    ],
    maxResults: 1,
  });

  expect(result.results).toHaveLength(1);
  expect(result.results[0].bases[0].loadout[0].instanceId).toBe('locked-ginga');
  expect(result.results[0].bases[0].loadout).toHaveLength(4);
});

test('does not reuse a locked equipment instance in another base', () => {
  const lockedFighter = plane('locked-fighter', {
    antiAir: 11,
    intercept: 5,
    radius: 7,
    role: 'fighter',
    isLandBased: true,
  });
  const equipment = [
    lockedFighter,
    ...Array.from({ length: 11 }, (_, index) =>
      plane(`plane-${index}`, {
        antiAir: index < 3 ? 10 : 3,
        radius: index < 3 ? 7 : 9,
        role: index < 3 ? 'fighter' : 'attacker',
        torpedo: index < 3 ? 0 : 14,
        bombing: index < 3 ? 0 : 14,
        isLandBased: true,
      }),
    ),
  ];

  const result = optimizeLoadouts({
    equipment,
    baseCount: 2,
    targetRadius: 7,
    enemyAir: 40,
    targetStates: ['parity', 'parity', 'parity', 'parity'],
    lockedBases: [
      {
        slots: [
          { plane: lockedFighter, locked: true },
          { plane: null, locked: false },
          { plane: null, locked: false },
          { plane: null, locked: false },
        ],
      },
      {
        slots: [
          { plane: null, locked: false },
          { plane: null, locked: false },
          { plane: null, locked: false },
          { plane: null, locked: false },
        ],
      },
    ],
    maxResults: 1,
  });

  const usedIds = result.results[0].bases.flatMap((base) =>
    base.loadout.map((item) => item.instanceId),
  );
  expect(usedIds.filter((id) => id === 'locked-fighter')).toHaveLength(1);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm test -- test/optimizer.test.js
```

Expected: FAIL because `lockedBases` is ignored.

- [ ] **Step 3: Implement locked candidate generation**

Modify `src/optimizer.js`:

- Read `lockedBases = []` from options.
- Normalize each base to four slot constraints.
- Pass the current base's constraints into candidate generation.
- `generateBaseCandidates(equipment, targetRadius, enemyAir, slotConstraints)` should:
  - Preserve locked planes at their slot index.
  - Fill only unlocked or empty slots.
  - Reject a candidate if a locked plane is missing, has duplicate `instanceId`, or cannot reach required radius after full loadout calculation.
  - Keep `candidate.loadout` ordered by slot index for UI import.
- During `combineBases`, initialize `usedIds` with earlier selected candidates as now, and rely on `overlaps(candidate, usedIds)` to avoid reusing locked equipment in later bases.

- [ ] **Step 4: Run optimizer tests**

Run:

```bash
npm test -- test/optimizer.test.js
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/optimizer.js test/optimizer.test.js
git commit -m "feat: support locked lbas optimizer slots"
```

---

### Task 4: 拆分并渲染上方模拟器 UI

**Files:**
- Create: `src/ui/i18n.js`
- Create: `src/ui/SimulatorPanel.js`
- Create: `src/ui/BaseTable.js`
- Create: `src/ui/EnemyPanel.js`
- Create: `src/ui/WaveStatusTable.js`
- Modify: `index.js`
- Modify: `i18n/zh-CN.json`
- Modify: `i18n/zh-TW.json`
- Modify: `i18n/en-US.json`
- Modify: `i18n/ja-JP.json`
- Test: `test/index.test.js`

**Interfaces:**
- Consumes: `createEmptySimulatorState`, `setBaseCount`, `setBaseSlot`, `setSlotLock`, `setWaveTarget`, `calculateSimulatorSummary`.
- Produces: A React tree where the top part is a reference-style simulator table and the old top form is removed.

- [ ] **Step 1: Add UI smoke tests**

Update `test/index.test.js` to assert:

```js
expect(renderedText).toContain('基地航空队模拟器');
expect(renderedText).toContain('敌舰队');
expect(renderedText).toContain('必要线');
expect(renderedText).toContain('配装优化');
expect(renderedText).toContain('仅持有装备');
expect(renderedText).not.toContain('Target radius');
```

Use the existing test style in `test/index.test.js`; keep it as a structural smoke test, not a browser visual test.

- [ ] **Step 2: Run UI test and verify it fails**

Run:

```bash
npm test -- test/index.test.js
```

Expected: FAIL because the current UI still renders the old form.

- [ ] **Step 3: Add component modules**

Create focused CommonJS modules:

- `src/ui/i18n.js`: exports `getLabel(t, key)` only if needed; otherwise keep translation lookup in `index.js`.
- `src/ui/SimulatorPanel.js`: layout container for simulator, receives `state`, `summary`, `equipment`, `onChange`.
- `src/ui/BaseTable.js`: renders base rows, 4 slots per base, equipment select, lock checkbox/button, proficiency select.
- `src/ui/EnemyPanel.js`: renders enemy air input, six manual enemy rows, and necessary lines.
- `src/ui/WaveStatusTable.js`: renders 2/4/6 wave target selects and calculated state labels.

Use `React.createElement`; do not introduce JSX/build tooling.

- [ ] **Step 4: Wire simulator state in `index.js`**

Replace old local fields `baseCount`, `enemyAir`, `targetRadius`, `targetStates` with:

```js
this.state = {
  simulator: createEmptySimulatorState(1),
  equipmentCount: 0,
  theoreticalCount: 0,
  messages: [],
  results: [],
};
```

Read Poi equipment once per render/run via current helper functions, pass it to `BaseTable` for equipment options, and keep all simulator updates through `setState((state) => ({ simulator: helper(state.simulator, ...) }))`.

- [ ] **Step 5: Add Chinese-first translation keys**

Add keys at least for:

```json
{
  "simulatorTitle": "基地航空队模拟器",
  "enemyFleet": "敌舰队",
  "necessaryLines": "必要线",
  "clearComposition": "清空编成",
  "firstBase": "第一基地",
  "secondBase": "第二基地",
  "thirdBase": "第三基地",
  "equipment": "装备",
  "lock": "锁定",
  "proficiency": "熟练",
  "baseSummary": "本队制空/半径/伤害",
  "enemyShipName": "敌舰名",
  "ownedOnly": "仅持有装备",
  "includeMissing": "包含未持有理论装备",
  "importToSimulator": "导入到模拟器"
}
```

Translate equivalent strings in `zh-TW`, `en-US`, `ja-JP`.

- [ ] **Step 6: Run task tests**

Run:

```bash
npm test -- test/index.test.js
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add index.js src/ui i18n test/index.test.js
git commit -m "feat: render lbas simulator panel"
```

---

### Task 5: 下方优化区与导入到模拟器

**Files:**
- Create: `src/import-plan.js`
- Create: `src/ui/OptimizerPanel.js`
- Modify: `index.js`
- Test: `test/import-plan.test.js`
- Modify: `test/index.test.js`

**Interfaces:**
- Consumes: optimizer `plan.bases[*].loadout`, simulator state, locked slots.
- Produces:
  - `applyPlanToSimulator(state, plan): SimulatorState`
  - UI button `导入到模拟器` that calls `applyPlanToSimulator`.

- [ ] **Step 1: Write failing import tests**

Create `test/import-plan.test.js`:

```js
import { describe, expect, test } from 'vitest';
import stateModule from '../src/simulator-state.js';
import importModule from '../src/import-plan.js';

const { createEmptySimulatorState, setBaseSlot, setSlotLock } = stateModule;
const { applyPlanToSimulator } = importModule;

describe('import optimizer plan into simulator', () => {
  test('imports plan loadout into empty simulator slots', () => {
    const plan = {
      bases: [
        { loadout: [plane('a'), plane('b'), plane('c'), plane('d')] },
      ],
    };

    const state = applyPlanToSimulator(createEmptySimulatorState(), plan);

    expect(state.bases[0].slots.map((slot) => slot.plane.instanceId)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('does not overwrite locked slots', () => {
    const locked = plane('locked');
    const original = setSlotLock(setBaseSlot(createEmptySimulatorState(), 0, 1, { plane: locked }), 0, 1, true);
    const plan = {
      bases: [
        { loadout: [plane('a'), plane('b'), plane('c'), plane('d')] },
      ],
    };

    const state = applyPlanToSimulator(original, plan);

    expect(state.bases[0].slots.map((slot) => slot.plane.instanceId)).toEqual(['a', 'locked', 'c', 'd']);
    expect(state.bases[0].slots[1].locked).toBe(true);
  });
});

function plane(instanceId) {
  return {
    instanceId,
    masterId: 1,
    name: instanceId,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 7,
    improvement: 0,
    proficiency: 7,
    role: 'attacker',
    isLandBased: true,
    torpedo: 14,
    bombing: 14,
    available: true,
    missing: false,
  };
}
```

- [ ] **Step 2: Run import test and verify it fails**

Run:

```bash
npm test -- test/import-plan.test.js
```

Expected: FAIL because `src/import-plan.js` does not exist.

- [ ] **Step 3: Implement import helper**

Create `src/import-plan.js`. It should:

- Normalize simulator state first.
- For each base and slot, keep the current slot when `locked === true`.
- Otherwise copy the matching `plan.bases[baseIndex].loadout[slotIndex]` into `slot.plane`.
- Preserve `proficiency` and `improvement` overrides only when the slot remains locked; imported planes use the plan plane fields.

- [ ] **Step 4: Implement `OptimizerPanel`**

Create `src/ui/OptimizerPanel.js` to render:

- Candidate mode segmented control or radio group: `仅持有装备` and `包含未持有理论装备`.
- `计算优化` button.
- Result rows showing rank, 6 wave states, total damage power, worst margin, missing equipment, and `导入到模拟器` button.
- Missing equipment visually marked with `未持有`.

- [ ] **Step 5: Wire optimizer run to simulator state**

Modify `index.js`:

- Use `simulatorToOptimizerInput(this.state.simulator)` to build optimizer options.
- Call `extractOptimizationPlanes(poiState, { includeMissing: this.state.simulator.candidateMode === 'theoretical', maxCopiesPerMaster: baseCount * 4 })`.
- Pass `lockedBases` into `optimizeLoadouts`.
- On import button, set `simulator: applyPlanToSimulator(state.simulator, plan)`.

- [ ] **Step 6: Run task tests**

Run:

```bash
npm test -- test/import-plan.test.js test/index.test.js test/optimizer.test.js
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/import-plan.js src/ui/OptimizerPanel.js index.js test/import-plan.test.js test/index.test.js
git commit -m "feat: import optimizer plans into simulator"
```

---

### Task 6: README、验收和 Poi 本地检查

**Files:**
- Modify: `README.md`
- Modify: `package.json` only if plugin description needs copy update.

**Interfaces:**
- Consumes: completed UI and optimizer behavior from Tasks 1-5.
- Produces: developer/user docs that match the new simulator-first behavior.

- [ ] **Step 1: Update README behavior description**

Revise `README.md`:

- 当前能力改成“上方模拟器 + 下方优化与导入”。
- 使用方式改成：
  1. 打开 Poi 插件「陆航优化」。
  2. 在上方模拟器手动选择基地数、目标半径、敌制空和每队 4 格装备。
  3. 需要固定装备时勾选对应槽位锁定。
  4. 在下方选择“仅持有装备”或“包含未持有理论装备”。
  5. 点击“计算优化”，检查结果后点击“导入到模拟器”。
- 暂不包含继续保留地图预设、连续敌机损耗、蓝字、最终扣甲伤害。

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm pack --dry-run
```

Expected:

- All Vitest tests pass.
- Typecheck passes.
- Pack dry run includes `index.js`, `src`, `i18n`, `README.md`, `LICENSE`.

- [ ] **Step 3: Check git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intended plugin files changed. Do not add unrelated untracked files such as the existing odd `AGENTS.md` unless the user explicitly asks.

- [ ] **Step 4: Optional local Poi smoke**

Because the plugin is installed as a symlink on this machine, restart Poi and open `陆航优化`. Confirm visually:

- Plugin opens inside Poi plugin page, not a new window.
- Top heading is `基地航空队模拟器`.
- Enemy panel shows `敌舰队` and `必要线`.
- Base count 3 shows 6 waves.
- “仅持有装备” is selected by default.
- Locking a slot then importing a result preserves that slot.

- [ ] **Step 5: Commit**

```bash
git add README.md package.json
git commit -m "docs: describe simulator-first lbas workflow"
```

---

## Self-Review

- Spec coverage:
  - 参考站上方表格式 UI: Task 4.
  - 上方玩家可改模拟器: Tasks 1 and 4.
  - 下方优化结果与一键导入: Task 5.
  - 理论未持有装备开关: Task 2 and Task 5.
  - 默认只考虑持有装备: Task 2.
  - 锁定特定装备优化: Task 3 and Task 5.
  - 1 base 两波，最多 6 波: Task 1 and Task 4.
  - 中文 UI 与多语言: Task 4.
  - 不做地图预设: Global Constraints and Task 6 docs.
- Placeholder scan: no placeholder markers; each task has concrete files, commands, and expected results.
- Type consistency:
  - `simulatorToOptimizerInput` produces `lockedBases`.
  - `optimizeLoadouts` consumes `lockedBases`.
  - `applyPlanToSimulator` consumes optimizer `plan.bases[*].loadout`.
  - UI reads and writes only `simulator` state plus optimizer result state.
