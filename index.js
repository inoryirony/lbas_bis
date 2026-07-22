'use strict';

const React = require('react');
const { extractOptimizationPlanes, extractOwnedPlanes } = require('./src/poi-data');
const { createSearchRunner } = require('./src/search-runner');
const { buildEnemyCatalog } = require('./src/enemy-catalog');
const { buildMapCatalog } = require('./src/map-catalog');
const { loadMapData } = require('./src/map-cache');
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
const CUSTOM_ENEMY_SHIP_ID = '__custom__';
const STATE_OPTIONS = ['denial', 'parity', 'superiority', 'supremacy'];
const INVALID_MULTIPLIER_FIELD = Symbol('invalid-multiplier-field');

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
  sixWaveState: '波次状态',
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
  searchCancelledMessage: '搜索已停止；已保留当前最佳方案，但尚未证明全局最优。',
  cancel: '停止计算',
  currentBest: '当前最佳',
  waitingFeasible: '等待可行方案',
  phase_finding_feasible: '正在寻找可行方案',
  phase_improving: '正在改进方案',
  phase_proving_optimal: '正在证明全局最优',
  phase_cancelling: '正在停止',
  prunedNodes: '已剪枝',
  completeCandidates: '完整候选',
  simulationSamples: '模拟样本',
  elapsedTime: '耗时',
  searchStatus_cancelled: '已取消',
  searchStatus_searching: '搜索中',
  selectEnemyShip: '选择敌舰',
  advancedSlotOverrides: '自定义敌机槽位',
  enemyDataMissing: '该敌舰缺少槽位数据',
  enemyDataMismatched: '该敌舰槽位数据不完整',
  unknownEnemyType: '未知舰种',
  mapPreset: '地图节点预设',
  mapDataLoading: '正在加载地图数据…',
  mapArea: '海域',
  mapNode: '节点',
  mapDifficulty: '难度',
  enemyFormation: '敌编成',
  applyMapPreset: '应用预设',
  useCustomComposition: '使用自定义编成',
  customComposition: '自定义编成',
  automaticComposition: '自动编成',
  customDraftSaved: '自定义草稿已保留',
  customEnemyShip: '完全自定义敌舰',
  customEnemyShipName: '自定义敌舰名',
  addSlotForShip: '为该舰增加敌机槽',
  refreshEnemyShip: '刷新敌舰数据',
  multiplierEditor: '装备伤害倍率',
  targetTags: '目标标签',
  ruleLabel: '规则名称',
  ruleTargetTags: '规则目标标签',
  equipmentMasterIds: '装备 Master ID',
  equipmentTypes: '装备类型',
  stackingGroup: '叠加组',
  multiplier: '倍率',
  enabled: '启用',
  addMultiplierRule: '增加倍率规则',
  removeMultiplierRule: '删除倍率规则',
  invalidEquipmentSelector: '装备 Master ID / 类型必须是逗号分隔的正整数。',
  bossNode: 'Boss',
  difficulty_0: '通常',
  difficulty_1: '丁',
  difficulty_2: '丙',
  difficulty_3: '乙',
  difficulty_4: '甲',
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
      isSearching: false,
      searchPhase: null,
      searchProgress: null,
      mapCatalog: null,
      mapSelection: { area: null, node: '', difficulty: null, formationId: '' },
      enemyCatalog: null,
      noro6Master: null,
      mapDataError: null,
    };
    this.customEnemyDraft = cloneEnemy(this.state.simulator.enemy);
    this.searchRunner = props.searchRunner || null;
    this.searchGeneration = 0;
    this.readPoiState = props.readPoiState || readPoiState;
    this.calculateSimulatorSummary = props.calculateSimulatorSummary || calculateSimulatorSummary;
    this.simulatorRenderCache = null;
  }

  componentDidMount() {
    loadMapData()
      .then((data) => {
        const poiState = this.readPoiState();
        this.setState({
          mapCatalog: buildMapCatalog(data),
          enemyCatalog: poiState
            ? buildEnemyCatalog(poiState, { noro6Master: data.master })
            : null,
          noro6Master: data.master,
          mapDataError: null,
        });
      })
      .catch((error) => this.setState({ mapDataError: error.message }));
  }

  runOptimizer = () => {
    const t = getT();
    const poiState = this.readPoiState();
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
      missingCopiesPerMaster: 1,
    });
    const searchOptions = {
      ...optimizerInput,
      equipment,
      maxResults: 1,
      nodeBudget: Infinity,
      simulationWorkBudget: Infinity,
    };

    this.setState({
      simulator,
      equipmentCount: ownedEquipment.length,
      theoreticalCount: equipment.length,
      messages: [],
      results: [],
      search: { status: 'searching', provenOptimal: false, nodesExplored: 0 },
      isSearching: true,
      searchPhase: 'finding_feasible',
      searchProgress: null,
    });
    this.searchRunner ||= createSearchRunner();
    const searchGeneration = this.searchGeneration += 1;
    this.searchRunner.start(searchOptions, (event) => {
      if (searchGeneration === this.searchGeneration) this.handleSearchEvent(event);
    });
  };

  handleSearchEvent = (event) => {
    const t = getT();
    if (event.type === 'phase_changed') {
      this.setState({ searchPhase: event.phase });
      return;
    }
    if (event.type === 'progress') {
      this.setState({
        searchPhase: event.phase || this.state.searchPhase,
        searchProgress: event,
        search: {
          ...(this.state.search || {}),
          status: 'searching',
          provenOptimal: false,
          nodesExplored: event.nodesExplored,
        },
      });
      return;
    }
    if (event.type === 'incumbent') {
      this.setState({
        results: [event.plan],
        searchPhase: event.phase || this.state.searchPhase,
      });
      return;
    }
    if (event.type === 'completed' || event.type === 'cancelled') {
      this.setState({
        messages: localizeMessages(event.result.messages || [], t),
        results: event.result.results || [],
        search: event.result.search,
        isSearching: false,
        searchPhase: null,
      });
      return;
    }
    if (event.type === 'failed') {
      this.setState({
        messages: [event.error?.message || 'Search worker failed.'],
        search: { status: 'invalid_input', provenOptimal: false, nodesExplored: 0 },
        isSearching: false,
        searchPhase: null,
      });
    }
  };

  cancelSearch = () => {
    if (!this.searchRunner?.cancel()) return;
    this.setState({ searchPhase: 'cancelling' });
  };

  componentWillUnmount() {
    this.searchGeneration += 1;
    this.searchRunner?.dispose();
    this.searchRunner = null;
  }

  updateSimulator = (updater) => {
    this.searchGeneration += 1;
    this.searchRunner?.cancel();
    this.setState((state) => ({
      simulator: normalizeSimulatorState(updater(state.simulator)),
      messages: [],
      results: [],
      search: null,
      isSearching: false,
      searchPhase: null,
      searchProgress: null,
    }));
  };

  /** Applies an enemy edit and records the normalized custom composition draft. */
  updateCustomEnemy = (updater) => {
    this.updateSimulator((simulator) => {
      const updated = normalizeSimulatorState(updater(simulator));
      const custom = normalizeSimulatorState({
        ...updated,
        enemy: { ...updated.enemy, dataSource: 'custom' },
      });
      this.customEnemyDraft = cloneEnemy(custom.enemy);
      return custom;
    });
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
    this.updateCustomEnemy((simulator) => ({
      ...simulator,
      enemy: {
        ...simulator.enemy,
        enemyAir,
        manualEnemyAir: enemyAir,
        ships: simulator.enemy.ships.map((ship, index) =>
          index === 0 ? { ...ship, airPower: enemyAir } : ship,
        ),
      },
    }));
  };

  /** Switches between static total air and detailed enemy-slot simulation. */
  updateEnemyMode = (mode) => {
    const update = (simulator) => ({
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
          enemyAir: simulator.enemy.manualEnemyAir ?? simulator.enemy.enemyAir,
        },
    });
    if (this.state.simulator.enemy.dataSource === 'automatic') {
      this.updateSimulator(update);
    } else {
      this.updateCustomEnemy(update);
    }
  };

  /** Updates one detailed enemy aircraft slot. */
  updateEnemySlot = (slotIndex, slotPatch) => {
    this.updateCustomEnemy((simulator) =>
      setDetailedEnemySlot(simulator, slotIndex, { ...slotPatch, overridden: true }));
  };

  /** Replaces one fleet position with a catalog enemy or a custom enemy ship. */
  updateEnemyShip = (shipIndex, shipId) => {
    const catalog = this.state.enemyCatalog || this.currentEnemyCatalog();
    const custom = shipId === CUSTOM_ENEMY_SHIP_ID;
    const selected = shipId == null || custom ? null : catalog.byId.get(Number(shipId));
    this.updateCustomEnemy((simulator) => {
      const previous = simulator.enemy.ships[shipIndex];
      const ships = simulator.enemy.ships.map((ship, index) => index === shipIndex
        ? custom
          ? { id: null, name: '', airPower: 0, dataStatus: 'custom', custom: true }
          : selected
          ? {
            id: selected.id,
            name: selected.name,
            typeName: selected.typeName,
            airPower: selected.airPower,
            dataStatus: selected.dataStatus,
          }
          : { id: null, name: '', airPower: 0, dataStatus: null }
        : ship);
      const generatedSlots = selected ? catalog.slotsForShip(selected.id, shipIndex) : [];
      const slots = mergeEnemyShipSlots(
        simulator.enemy.slots,
        generatedSlots,
        shipIndex,
        custom || (selected && Number(previous?.id) === selected.id),
      );
      return {
        ...simulator,
        enemy: {
          ...simulator.enemy,
          mode: 'detailed',
          ships,
          slots,
        },
      };
    });
  };

  /** Updates the display name of one completely custom enemy ship. */
  updateEnemyShipName = (shipIndex, name) => {
    this.updateCustomEnemy((simulator) => ({
      ...simulator,
      enemy: {
        ...simulator.enemy,
        mode: 'detailed',
        ships: simulator.enemy.ships.map((ship, index) => index === shipIndex
          ? { ...ship, id: null, custom: true, dataStatus: 'custom', name }
          : ship),
      },
    }));
  };

  updateMapSelection = (field, rawValue) => {
    this.setState((state) => {
      const current = state.mapSelection;
      if (field === 'area') {
        return { mapSelection: { area: rawValue ? Number(rawValue) : null, node: '', difficulty: null, formationId: '' } };
      }
      if (field === 'node') {
        return { mapSelection: { ...current, node: rawValue, difficulty: null, formationId: '' } };
      }
      if (field === 'difficulty') {
        return { mapSelection: { ...current, difficulty: rawValue === '' ? null : Number(rawValue), formationId: '' } };
      }
      return { mapSelection: { ...current, formationId: rawValue } };
    });
  };

  applyMapPreset = (formation) => {
    this.updateSimulator((simulator) => {
      if (simulator.enemy.dataSource === 'custom') {
        this.customEnemyDraft = cloneEnemy(simulator.enemy);
      }
      return {
        ...simulator,
        targetRadius: formation.radius.length
          ? Math.max(...formation.radius)
          : simulator.targetRadius,
        enemy: {
          ...simulator.enemy,
          mode: 'detailed',
          dataSource: 'automatic',
          areaId: formation.area,
          nodeId: formation.node,
          source: formation.source,
          manualEnemyAir: Number.isFinite(Number(formation.enemyAir))
            ? Math.max(0, Number(formation.enemyAir))
            : formation.ships.reduce((total, ship) => total + (Number(ship.airPower) || 0), 0),
          ships: Array.from({ length: Math.max(6, formation.ships.length) }, (_, index) => formation.ships[index]
            ? { ...formation.ships[index] }
            : { id: null, name: '', airPower: 0 }),
          slots: formation.enemySlots.map((slot) => ({ ...slot, overridden: false })),
        },
      };
    });
  };

  /** Restores the custom draft for the currently selected map node. */
  useCustomEnemyComposition = () => {
    this.updateSimulator((simulator) => {
      const draft = cloneEnemy(this.customEnemyDraft || simulator.enemy);
      const enemy = {
        ...draft,
        dataSource: 'custom',
        areaId: this.state.mapSelection.area ?? draft.areaId,
        nodeId: this.state.mapSelection.node || draft.nodeId,
      };
      this.customEnemyDraft = cloneEnemy(enemy);
      return { ...simulator, enemy };
    });
  };

  /** Appends one editable detailed enemy aircraft slot. */
  addEnemySlot = (sourceShipIndex = null) => {
    const normalizedSourceShipIndex = Number.isInteger(sourceShipIndex) && sourceShipIndex >= 0
      ? sourceShipIndex
      : null;
    this.updateCustomEnemy((simulator) =>
      addDetailedEnemySlot(simulator, {
        ...createEnemySlot(nextEnemySlotIndex(simulator.enemy.slots)),
        ...(normalizedSourceShipIndex == null ? {} : { sourceShipIndex: normalizedSourceShipIndex }),
      }));
  };

  /** Removes one detailed enemy aircraft slot. */
  removeEnemySlot = (slotIndex) => {
    this.updateCustomEnemy((simulator) => removeDetailedEnemySlot(simulator, slotIndex));
  };

  /** Toggles air-raid-cell rules for jet assault. */
  updateAirRaidCell = (isAirRaidCell) => {
    this.updateCustomEnemy((simulator) => ({
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

  updateCombatTargetTags = (value) => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      combatContext: {
        ...simulator.combatContext,
        targetTags: parseCommaSeparatedStrings(value),
      },
    }));
  };

  addMultiplierRule = () => {
    this.updateSimulator((simulator) => {
      const rules = simulator.combatContext.multiplierRules;
      const id = nextMultiplierRuleId(rules);
      return {
        ...simulator,
        combatContext: {
          ...simulator.combatContext,
          multiplierRules: [...rules, {
            id,
            label: '',
            enabled: true,
            targetTags: [],
            equipmentMasterIds: [],
            equipmentTypes: [],
            group: id,
            multiplier: 1,
            source: 'custom',
            overridden: true,
          }],
        },
      };
    });
  };

  updateMultiplierRule = (ruleIndex, field, value) => {
    const normalizedValue = normalizeMultiplierRuleField(field, value);
    if (normalizedValue === INVALID_MULTIPLIER_FIELD) {
      this.setState({ messages: [getT()('invalidEquipmentSelector')] });
      return false;
    }
    this.updateSimulator((simulator) => ({
      ...simulator,
      combatContext: {
        ...simulator.combatContext,
        multiplierRules: simulator.combatContext.multiplierRules.map((rule, index) =>
          index === ruleIndex
            ? {
              ...rule,
              [field]: normalizedValue,
              source: 'custom',
              overridden: true,
            }
            : rule),
      },
    }));
    return true;
  };

  removeMultiplierRule = (ruleIndex) => {
    this.updateSimulator((simulator) => ({
      ...simulator,
      combatContext: {
        ...simulator.combatContext,
        multiplierRules: simulator.combatContext.multiplierRules.filter(
          (_rule, index) => index !== ruleIndex,
        ),
      },
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
    this.updateSimulator((simulator) => applyPlanToSimulator(simulator, plan));
  };

  currentOwnedEquipment() {
    const poiState = this.readPoiState();
    return poiState ? extractOwnedPlanes(poiState) : [];
  }

  currentEnemyCatalog() {
    return enemyCatalogFor(this.readPoiState(), this.state.noro6Master);
  }

  render() {
    const t = getT();
    if (this.simulatorRenderCache?.source !== this.state.simulator) {
      const simulator = normalizeSimulatorState(this.state.simulator);
      this.simulatorRenderCache = {
        source: this.state.simulator,
        simulator,
        summary: this.calculateSimulatorSummary(simulator),
      };
    }
    const { simulator, summary } = this.simulatorRenderCache;
    const ownedEquipment = this.currentOwnedEquipment();
    const enemyCatalog = this.state.enemyCatalog || this.currentEnemyCatalog();

    return h(
      'div',
      { style: styles.page },
      h('h1', { style: styles.pageTitle }, t('title')),
      h(SimulatorPanel, {
        simulator,
        summary,
        equipment: ownedEquipment,
        enemyCatalog,
        mapCatalog: this.state.mapCatalog,
        mapSelection: this.state.mapSelection,
        onBaseCountChange: this.updateBaseCount,
        onTargetRadiusChange: this.updateTargetRadius,
        onEnemyAirChange: this.updateEnemyAir,
        onEnemyModeChange: this.updateEnemyMode,
        onEnemySlotChange: this.updateEnemySlot,
        onEnemySlotAdd: this.addEnemySlot,
        onEnemySlotRemove: this.removeEnemySlot,
        onEnemyShipChange: this.updateEnemyShip,
        onEnemyShipNameChange: this.updateEnemyShipName,
        onMapSelectionChange: this.updateMapSelection,
        onMapPresetApply: this.applyMapPreset,
        onUseCustomEnemy: this.useCustomEnemyComposition,
        onAirRaidCellChange: this.updateAirRaidCell,
        onSimulationOptionChange: this.updateSimulationOption,
        onCombatTargetTagsChange: this.updateCombatTargetTags,
        onMultiplierRuleAdd: this.addMultiplierRule,
        onMultiplierRuleChange: this.updateMultiplierRule,
        onMultiplierRuleRemove: this.removeMultiplierRule,
        onSlotPlaneChange: this.updateSlotPlane,
        onSlotLockChange: this.updateSlotLock,
        onWaveTargetChange: this.updateWaveTarget,
        onClear: this.clearComposition,
        t,
        styles,
      }),
      h(OptimizerPanel, {
        candidateMode: simulator.candidateMode,
        combatContext: simulator.combatContext,
        equipmentCount: this.state.equipmentCount || ownedEquipment.length,
        theoreticalCount: this.state.theoreticalCount || ownedEquipment.length,
        messages: this.state.messages,
        results: this.state.results,
        search: this.state.search,
        isSearching: this.state.isSearching,
        searchPhase: this.state.searchPhase,
        searchProgress: this.state.searchProgress,
        onCandidateModeChange: this.updateCandidateMode,
        onOptimize: this.runOptimizer,
        onCancel: this.cancelSearch,
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

function nextEnemySlotIndex(slots) {
  const ids = new Set((slots || []).map((slot) => String(slot.instanceId)));
  let index = (slots || []).length;
  while (ids.has(`enemy-slot-${index}`)) index += 1;
  return index;
}

function nextMultiplierRuleId(rules) {
  const ids = new Set((rules || []).map((rule) => rule.id));
  let index = (rules || []).length + 1;
  while (ids.has(`custom-rule-${index}`)) index += 1;
  return `custom-rule-${index}`;
}

function normalizeMultiplierRuleField(field, value) {
  if (field === 'targetTags') return parseCommaSeparatedStrings(value);
  if (field === 'equipmentMasterIds' || field === 'equipmentTypes') {
    return parseCommaSeparatedPositiveIntegers(value) ?? INVALID_MULTIPLIER_FIELD;
  }
  if (field === 'multiplier') return Number(value);
  if (field === 'enabled') return Boolean(value);
  return value;
}

function parseCommaSeparatedStrings(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function parseCommaSeparatedPositiveIntegers(value) {
  const tokens = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const numbers = tokens.map(Number);
  if (numbers.some((item) => !Number.isInteger(item) || item <= 0)) return null;
  return [...new Set(numbers)];
}

/** Creates a detached enemy draft whose ship and slot arrays can be replaced safely. */
function cloneEnemy(enemy) {
  return {
    ...enemy,
    ships: (enemy.ships || []).map((ship) => ({ ...ship })),
    slots: (enemy.slots || []).map((slot) => ({ ...slot })),
  };
}

let cachedCatalogState = null;
let cachedCatalogMaster = null;
let cachedEnemyCatalog = null;

function enemyCatalogFor(poiState, noro6Master = null) {
  if (!poiState) return { ships: [], byId: new Map(), warnings: [], slotsForShip: () => [] };
  if (cachedCatalogState !== poiState || cachedCatalogMaster !== noro6Master) {
    cachedCatalogState = poiState;
    cachedCatalogMaster = noro6Master;
    cachedEnemyCatalog = buildEnemyCatalog(poiState, { noro6Master });
  }
  return cachedEnemyCatalog;
}

function isBlankGeneratedSlot(slot) {
  return slot.sourceShipIndex == null &&
    !slot.name &&
    Number(slot.sortieAntiAir) === 0;
}

/** Merges refreshed catalog slots while retaining explicit overrides for the same ship. */
function mergeEnemyShipSlots(existingSlots, generatedSlots, shipIndex, preserveOverrides) {
  const unrelated = existingSlots.filter((slot) =>
    slot.sourceShipIndex !== shipIndex && !isBlankGeneratedSlot(slot));
  if (!preserveOverrides) return [...unrelated, ...generatedSlots];

  const overrides = existingSlots.filter((slot) =>
    slot.sourceShipIndex === shipIndex && slot.overridden === true);
  const matched = new Set();
  const refreshed = generatedSlots.map((slot) => {
    const overrideIndex = overrides.findIndex((candidate, index) =>
      !matched.has(index) &&
      candidate.sourceSlotIndex != null &&
      candidate.sourceSlotIndex === slot.sourceSlotIndex);
    if (overrideIndex < 0) return slot;
    matched.add(overrideIndex);
    return { ...slot, ...overrides[overrideIndex] };
  });
  const customExtras = overrides.filter((_slot, index) => !matched.has(index));
  return [...unrelated, ...refreshed, ...customExtras];
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
    if (message === 'Search cancelled; the current best plan is preserved but is not proven optimal.') {
      return t('searchCancelledMessage');
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
  customBadge: {
    borderLeft: '3px solid #2f7d4a',
    color: '#245c38',
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 8,
    padding: '3px 6px',
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
  enemyShipGrid: {
    display: 'grid',
    gap: 6,
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    marginBottom: 8,
  },
  mapPreset: {
    borderBottom: border,
    display: 'grid',
    gap: 6,
    marginBottom: 8,
    paddingBottom: 8,
  },
  mapPresetGrid: {
    display: 'grid',
    gap: 6,
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  },
  mapPreview: {
    fontSize: 12,
    lineHeight: 1.5,
  },
  advancedEnemySlots: {
    marginTop: 8,
  },
  searchProgress: {
    display: 'grid',
    fontSize: 12,
    gap: 5,
    margin: '8px 0',
  },
  progressTrack: {
    background: 'rgba(128, 128, 128, 0.2)',
    height: 4,
    overflow: 'hidden',
    width: '100%',
  },
  progressBar: {
    background: '#2f7d64',
    height: 4,
    width: '38%',
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
