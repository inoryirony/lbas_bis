'use strict';

const React = require('react');
const { optimizeLoadouts } = require('./src/optimizer');
const { extractOptimizationPlanes, extractOwnedPlanes } = require('./src/poi-data');
const {
  createEmptySimulatorState,
  addDetailedEnemySlot,
  normalizeSimulatorState,
  removeDetailedEnemySlot,
  setBaseCount,
  setBaseSlot,
  setDetailedEnemySlot,
  setSlotLock,
  setWaveTarget,
  simulatorToOptimizerInput,
} = require('./src/simulator-state');
const { calculateSimulatorSummary } = require('./src/simulator-calc');
const { applyPlanToSimulator } = require('./src/import-plan');
const SimulatorPanel = require('./src/ui/SimulatorPanel');
const OptimizerPanel = require('./src/ui/OptimizerPanel');

const h = React.createElement;
const PLUGIN_ID = 'lbas_bis';
const STATE_OPTIONS = ['denial', 'parity', 'superiority', 'supremacy'];

const FALLBACK_ZH_CN = {
  title: '陆航优化',
  simulatorTitle: '基地航空队模拟器',
  optimizerTitle: '配装优化',
  targetRadius: '目标半径',
  enemyAir: '敌制空',
  baseCount: '基地队数',
  displayWaves: '显示波数',
  targetState: '目标状态',
  waveTarget: '第 {{base}} 队第 {{wave}} 波',
  wave: '第 {{index}} 波',
  optimize: '计算优化',
  availablePlanes: '可用飞机',
  candidatePlanes: '候选飞机',
  noResult: '暂无结果',
  noPoiState: '尚未读取到 Poi 数据，请在游戏数据加载后重试。',
  noCandidateRadius: '没有可达半径 {{radius}} 的候选配装。',
  plan: '方案',
  attack: '攻击',
  damagePower: '伤害基准',
  worstMargin: '最小余量',
  base: '第 {{index}} 队',
  airPower: '制空',
  radius: '半径',
  denial: '劣势',
  parity: '均势',
  superiority: '优势',
  supremacy: '确保',
  loss: '丧失',
  role_fighter: '制空',
  role_attacker: '攻击',
  role_recon: '侦察/延程',
  role_unknown: '其他',
  theoreticalPlanes: '理论候选',
  minimumProficiency: '最低熟练度',
  uniformMinimumProficiency: '统一最低可见熟练度',
  missingEquipment: '缺少装备',
  missing: '未持有',
  role_seaplaneBomber: '水爆',
  enemyFleet: '敌舰队',
  necessaryLines: '必要线',
  clearComposition: '编成清空',
  equipment: '装备',
  lock: '锁定',
  proficiency: '熟练',
  baseSummary: '本队制空/半径/伤害',
  baseColumn: '基地',
  enemyShipName: '敌舰名',
  ownedOnly: '仅持有装备',
  includeMissing: '包含未持有理论装备',
  importToSimulator: '导入到模拟器',
  sixWaveState: '6波状态',
  manualMode: '手动',
  none: '无',
  emptySlot: '空槽',
  staticEstimate: '静态估算',
  detailedSimulation: '详细逐波模拟',
  provenOptimal: '已证明最优',
  notProvenOptimal: '未证明最优',
  searchNodes: '搜索节点',
  searchStatus_optimal: '搜索完成',
  searchStatus_infeasible: '确认无解',
  searchStatus_budget_exhausted: '预算耗尽',
  searchStatus_invalid_input: '输入无效',
  enemyPlaneName: '敌机名',
  sortieAntiAir: '出击对空',
  currentSlot: '当前搭载',
  maxSlot: '最大搭载',
  addEnemySlot: '增加敌机槽',
  removeEnemySlot: '删除敌机槽',
  airRaidCell: '空袭格',
  sampleCount: '采样数',
  randomSeed: '随机种子',
  invalidDetailedEnemy: '详细敌机槽输入无效',
  targetFulfillment: '达标概率',
  expectedAir: '期望制空',
  noTargetAirSolution: '没有配装能满足目标制空状态。',
  noCombinedConstraintSolution: '没有配装能同时满足航程、制空、库存和锁定约束。',
  budgetExhaustedMessage: '搜索或模拟预算已耗尽，尚未证明最优。',
};

class LbasOptimizerPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      simulator: createEmptySimulatorState(1),
      equipmentCount: 0,
      theoreticalCount: 0,
      messages: [],
      results: [],
      search: null,
    };
  }

  runOptimizer = () => {
    const t = getT();
    const poiState = readPoiState();
    if (!poiState) {
      this.setState({
        messages: [t('noPoiState')],
        results: [],
        equipmentCount: 0,
        theoreticalCount: 0,
      });
      return;
    }

    const simulator = normalizeSimulatorState(this.state.simulator);
    const optimizerInput = simulatorToOptimizerInput(simulator);
    const ownedEquipment = extractOwnedPlanes(poiState);
    const equipment = extractOptimizationPlanes(poiState, {
      includeMissing: simulator.candidateMode === 'theoretical',
      maxCopiesPerMaster: Number(simulator.baseCount) * 4,
    });
    const result = optimizeLoadouts({
      ...optimizerInput,
      equipment,
      maxResults: 10,
    });

    this.setState({
      simulator,
      equipmentCount: ownedEquipment.length,
      theoreticalCount: equipment.length,
      messages: localizeMessages(result.messages, t),
      results: result.results,
      search: result.search,
    });
  };

  updateSimulator = (updater) => {
    this.setState((state) => ({
      simulator: normalizeSimulatorState(updater(state.simulator)),
    }));
  };

  updateBaseCount = (baseCount) => {
    this.updateSimulator((simulator) => setBaseCount(simulator, baseCount));
  };

  updateTargetRadius = (targetRadius) => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      targetRadius,
    }));
  };

  updateEnemyAir = (enemyAir) => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      enemy: {
        ...simulator.enemy,
        enemyAir,
        ships: simulator.enemy.ships.map((ship, index) =>
          index === 0 ? { ...ship, airPower: enemyAir } : ship,
        ),
      },
    }));
  };

  /** Switches between static total air and detailed enemy-slot simulation. */
  updateEnemyMode = (mode) => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      enemy: mode === 'detailed'
        ? {
          ...simulator.enemy,
          mode: 'detailed',
          slots: simulator.enemy.slots.length
            ? simulator.enemy.slots
            : [createEnemySlot(0)],
        }
        : {
          ...simulator.enemy,
          mode: 'manual',
          slots: [],
        },
    }));
  };

  /** Updates one detailed enemy aircraft slot. */
  updateEnemySlot = (slotIndex, slotPatch) => {
    this.updateSimulator((simulator) =>
      setDetailedEnemySlot(simulator, slotIndex, slotPatch));
  };

  /** Appends one editable detailed enemy aircraft slot. */
  addEnemySlot = () => {
    this.updateSimulator((simulator) =>
      addDetailedEnemySlot(simulator, createEnemySlot(simulator.enemy.slots.length)));
  };

  /** Removes one detailed enemy aircraft slot. */
  removeEnemySlot = (slotIndex) => {
    this.updateSimulator((simulator) => removeDetailedEnemySlot(simulator, slotIndex));
  };

  /** Toggles air-raid-cell rules for jet assault. */
  updateAirRaidCell = (isAirRaidCell) => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      enemy: { ...simulator.enemy, isAirRaidCell: Boolean(isAirRaidCell) },
    }));
  };

  /** Updates deterministic Monte Carlo controls. */
  updateSimulationOption = (field, value) => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      simulationOptions: { ...simulator.simulationOptions, [field]: value },
    }));
  };

  updateCandidateMode = (candidateMode) => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      candidateMode,
    }));
  };

  updateSlotPlane = (baseIndex, slotIndex, instanceId) => {
    const plane = findSelectablePlane(this.currentOwnedEquipment(), this.state.simulator, instanceId);
    this.updateSimulator((simulator) => setBaseSlot(simulator, baseIndex, slotIndex, { plane }));
  };

  updateSlotLock = (baseIndex, slotIndex, locked) => {
    this.updateSimulator((simulator) => setSlotLock(simulator, baseIndex, slotIndex, locked));
  };

  updateWaveTarget = (waveIndex, targetState) => {
    this.updateSimulator((simulator) => setWaveTarget(simulator, waveIndex, targetState));
  };

  clearComposition = () => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      bases: simulator.bases.map((base) => ({
        ...base,
        slots: base.slots.map(() => ({
          plane: null,
          locked: false,
          proficiency: null,
          improvement: null,
        })),
      })),
    }));
  };

  importPlan = (plan) => {
    this.setState((state) => ({
      simulator: applyPlanToSimulator(state.simulator, plan),
    }));
  };

  currentOwnedEquipment() {
    const poiState = readPoiState();
    return poiState ? extractOwnedPlanes(poiState) : [];
  }

  render() {
    const t = getT();
    const simulator = normalizeSimulatorState(this.state.simulator);
    const summary = calculateSimulatorSummary(simulator);
    const ownedEquipment = this.currentOwnedEquipment();

    return h(
      'div',
      { style: styles.page },
      h('h1', { style: styles.pageTitle }, t('title')),
      h(SimulatorPanel, {
        simulator,
        summary,
        equipment: ownedEquipment,
        onBaseCountChange: this.updateBaseCount,
        onTargetRadiusChange: this.updateTargetRadius,
        onEnemyAirChange: this.updateEnemyAir,
        onEnemyModeChange: this.updateEnemyMode,
        onEnemySlotChange: this.updateEnemySlot,
        onEnemySlotAdd: this.addEnemySlot,
        onEnemySlotRemove: this.removeEnemySlot,
        onAirRaidCellChange: this.updateAirRaidCell,
        onSimulationOptionChange: this.updateSimulationOption,
        onSlotPlaneChange: this.updateSlotPlane,
        onSlotLockChange: this.updateSlotLock,
        onWaveTargetChange: this.updateWaveTarget,
        onClear: this.clearComposition,
        t,
        styles,
      }),
      h(OptimizerPanel, {
        candidateMode: simulator.candidateMode,
        equipmentCount: this.state.equipmentCount || ownedEquipment.length,
        theoreticalCount: this.state.theoreticalCount || ownedEquipment.length,
        messages: this.state.messages,
        results: this.state.results,
        search: this.state.search,
        onCandidateModeChange: this.updateCandidateMode,
        onOptimize: this.runOptimizer,
        onImportPlan: this.importPlan,
        t,
        styles,
      }),
    );
  }
}

function readPoiState() {
  if (typeof window === 'undefined') {
    return null;
  }
  const poiWindow = /** @type {Window & { getStore?: () => any }} */ (window);
  return typeof poiWindow.getStore === 'function' ? poiWindow.getStore() : null;
}

function findSelectablePlane(equipment, simulator, instanceId) {
  if (!instanceId) {
    return null;
  }
  const wanted = String(instanceId);
  const selected = simulator.bases.flatMap((base) => base.slots.map((slot) => slot.plane).filter(Boolean));
  return [...equipment, ...selected].find((plane) => String(plane.instanceId) === wanted) || null;
}

/** Creates one valid editable detailed enemy aircraft slot. */
function createEnemySlot(index) {
  return {
    instanceId: `enemy-slot-${index}`,
    name: '',
    sortieAntiAir: 0,
    currentSlot: 18,
    maxSlot: 18,
  };
}

function parseTargetStates(value) {
  const states = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const filtered = states
    .map((state) => String(state).trim())
    .filter((state) => STATE_OPTIONS.includes(state));
  return filtered.length ? filtered : ['parity'];
}

function normalizeTargetStates(value, baseCount) {
  const parsed = parseTargetStates(value);
  const count = clamp(Number(baseCount) || 1, 1, 3);
  return Array.from({ length: count * 2 }, (_, index) => parsed[index] || parsed[0] || 'parity');
}

function localizeMessages(messages, t) {
  return messages.map((message) => {
    const radiusMatch = message.match(/^No candidate loadout can reach radius (\d+)\.$/);
    if (radiusMatch) {
      return format(t('noCandidateRadius'), { radius: radiusMatch[1] });
    }
    if (message === 'No loadout can satisfy the target air state.') {
      return t('noTargetAirSolution');
    }
    if (message === 'No loadout can satisfy all range, air, inventory, and lock constraints.') {
      return t('noCombinedConstraintSolution');
    }
    if (message === 'Search or simulation work budget exhausted before optimality was proven.') {
      return t('budgetExhaustedMessage');
    }
    return message;
  });
}

function getT() {
  try {
    // @ts-ignore Poi provides this runtime-only module outside npm resolution.
    const i18next = require('views/env-parts/i18next').default;
    const fixedT = i18next.getFixedT(null, PLUGIN_ID);
    return (key) => fixedT(key);
  } catch (error) {
    return (key) => FALLBACK_ZH_CN[key] || key;
  }
}

function format(template, values) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatProficiency(level) {
  if (level == null) {
    return '-';
  }
  return ['-', '|', '||', '|||', '/', '//', '///', '>>'][level] || String(level);
}

const border = '1px solid rgba(128, 128, 128, 0.35)';
const styles = {
  page: {
    boxSizing: 'border-box',
    fontFamily: 'sans-serif',
    padding: 12,
  },
  pageTitle: {
    fontSize: 18,
    margin: '0 0 8px',
  },
  title: {
    fontSize: 18,
    margin: '0 0 8px',
  },
  sectionTitle: {
    fontSize: 15,
    margin: '0 0 8px',
  },
  simulatorPanel: {
    border: border,
    marginBottom: 12,
    padding: 10,
  },
  simulatorGrid: {
    display: 'grid',
    gap: 10,
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  },
  toolbar: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  field: {
    display: 'grid',
    fontSize: 12,
    gap: 4,
  },
  fieldInline: {
    alignItems: 'center',
    display: 'inline-flex',
    fontSize: 12,
    gap: 6,
  },
  input: {
    boxSizing: 'border-box',
    fontSize: 13,
    height: 28,
    padding: '2px 6px',
    width: '100%',
  },
  numberInput: {
    boxSizing: 'border-box',
    fontSize: 13,
    height: 28,
    padding: '2px 6px',
    width: 72,
  },
  select: {
    boxSizing: 'border-box',
    fontSize: 13,
    height: 28,
    padding: '2px 6px',
    width: '100%',
  },
  smallSelect: {
    boxSizing: 'border-box',
    fontSize: 13,
    height: 28,
    padding: '2px 6px',
  },
  button: {
    cursor: 'pointer',
    fontSize: 13,
    minHeight: 28,
    padding: '0 10px',
  },
  primaryButton: {
    cursor: 'pointer',
    fontSize: 13,
    minHeight: 30,
    padding: '0 14px',
  },
  meta: {
    color: '#777',
    fontSize: 12,
  },
  tableWrap: {
    overflowX: 'auto',
  },
  table: {
    borderCollapse: 'collapse',
    fontSize: 13,
    tableLayout: 'fixed',
    width: '100%',
  },
  th: {
    border: border,
    fontWeight: 600,
    padding: '5px 6px',
    textAlign: 'center',
  },
  td: {
    border: border,
    padding: 5,
  },
  centerTd: {
    border: border,
    padding: 5,
    textAlign: 'center',
  },
  baseName: {
    border: border,
    fontWeight: 600,
    padding: 6,
    textAlign: 'center',
    width: 72,
  },
  summaryTd: {
    border: border,
    fontSize: 12,
    lineHeight: 1.5,
    padding: 6,
    width: 150,
  },
  enemyPanel: {
    minWidth: 0,
  },
  enemyControls: {
    alignItems: 'end',
    display: 'grid',
    gap: 8,
    gridTemplateColumns: '1fr auto',
    marginBottom: 8,
  },
  manualTag: {
    border: border,
    fontSize: 12,
    minHeight: 28,
    padding: '5px 8px',
  },
  lines: {
    border: border,
    fontSize: 13,
    lineHeight: 1.6,
    marginTop: 8,
    padding: 8,
  },
  wavePanel: {
    border: border,
    borderTop: 0,
    padding: 8,
  },
  waveList: {
    display: 'grid',
    gap: 8,
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  },
  waveField: {
    alignItems: 'center',
    display: 'grid',
    gap: 4,
    gridTemplateColumns: 'auto 1fr auto',
  },
  goodState: {
    color: '#2e7d32',
  },
  badState: {
    color: '#b23b22',
  },
  optimizerPanel: {
    border: border,
    padding: 10,
  },
  optimizerControls: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 8,
  },
  searchMeta: {
    margin: '6px 0',
    fontSize: 12,
  },
  iconButton: {
    minWidth: 28,
    height: 26,
    padding: 0,
    border: border,
    borderRadius: 3,
    background: 'transparent',
    cursor: 'pointer',
  },
  emptyLoadoutItem: {
    opacity: 0.58,
  },
  radioLabel: {
    alignItems: 'center',
    display: 'inline-flex',
    gap: 4,
  },
  messages: {
    color: '#d9534f',
    fontSize: 12,
    margin: '8px 0',
    paddingLeft: 18,
  },
  emptyCell: {
    border: border,
    color: '#777',
    padding: 10,
    textAlign: 'center',
  },
  results: {
    display: 'grid',
    gap: 10,
  },
  plan: {
    border: border,
    padding: 10,
  },
  planHeader: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 8,
  },
  planSummary: {
    color: '#8a6d3b',
    fontSize: 12,
    marginBottom: 8,
  },
  waves: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  wave: {
    border: '1px solid rgba(128, 128, 128, 0.25)',
    fontSize: 12,
    padding: '2px 6px',
  },
  loadout: {
    fontSize: 12,
    lineHeight: 1.5,
    margin: 0,
    paddingLeft: 18,
  },
  missingItem: {
    color: '#777',
    opacity: 0.6,
  },
};

module.exports = {
  formatProficiency,
  reactClass: LbasOptimizerPanel,
  parseTargetStates,
  normalizeTargetStates,
};
