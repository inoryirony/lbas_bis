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
const {
  defaultBlacklistedMasterIds,
  filterOptimizationEquipment,
  isEquipmentExcluded,
  uniqueEquipmentMasters,
} = require('./src/equipment-filter');
const SimulatorPanel = require('./src/ui/SimulatorPanel');
const OptimizerPanel = require('./src/ui/OptimizerPanel');

const h = React.createElement;
const PLUGIN_ID = 'lbas_bis';
const CUSTOM_ENEMY_SHIP_ID = '__custom__';
const STATE_OPTIONS = ['loss', 'denial', 'parity', 'superiority', 'supremacy'];
const INVALID_MULTIPLIER_FIELD = Symbol('invalid-multiplier-field');
const EQUIPMENT_FILTER_STORAGE_KEY = 'poi-plugin-lbas-bis.equipment-filters.v1';

const FALLBACK_ZH_CN = {
  title: '陆航优化',
  simulatorTitle: '基地航空队模拟器',
  optimizerTitle: '配装优化',
  targetRadius: '目标半径',
  enemyAir: '敌制空',
  expectedEnemyAir: '敌制空期望',
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
  phase_building_prefix_trajectories: '正在构建前序敌机轨迹',
  phase_evaluating_suffix_trajectories: '正在评估后序敌机轨迹',
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
  enemyStage2Modeled: '已计敌方 Stage 2 / 抗击坠',
  enemyStage2Omitted: '未计敌方 Stage 2 / 抗击坠',
  shootDownAvoidance: '抗击坠',
  shootDownAvoidance_0: '无',
  shootDownAvoidance_1: '弱',
  shootDownAvoidance_2: '中',
  shootDownAvoidance_3: '强',
  shootDownAvoidance_4: '超',
  shootDownAvoidance_5: '超+',
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
  excludeCarrierAircraft: '不使用舰载机',
  equipmentBlacklist: '装备黑名单',
  blacklistByEquipmentType: '按装备种类',
  searchEquipment: '搜索装备名称或 Master ID',
  searchAircraft: '搜索装备',
  blacklistedCurrent: '已在黑名单中',
  visibleResults: '显示结果',
  restoreDefaults: '恢复默认',
  clearBlacklist: '清空黑名单',
  noMatchingEquipment: '没有匹配的装备',
  close: '关闭',
};

class LbasOptimizerPanel extends React.Component {
  constructor(props) {
    super(props);
    this.equipmentFilterStorage = props.settingsStorage || browserStorage();
    const savedEquipmentFilters = loadEquipmentFilters(this.equipmentFilterStorage);
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
      equipmentFilters: savedEquipmentFilters || {
        excludeCarrierAircraft: false,
        blacklistedMasterIds: null,
        blacklistedEquipTypes: [],
      },
      equipmentBlacklistOpen: false,
      equipmentBlacklistQuery: '',
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
    const equipmentAdapterOptions = { noro6Master: this.state.noro6Master };
    const ownedEquipment = extractOwnedPlanes(poiState, equipmentAdapterOptions);
    const unfilteredEquipment = extractOptimizationPlanes(poiState, {
      includeMissing: simulator.candidateMode === 'theoretical',
      missingCopiesPerMaster: 1,
      ...equipmentAdapterOptions,
    });
    const equipmentFilters = effectiveEquipmentFilters(
      this.state.equipmentFilters,
      extractOptimizationPlanes(poiState, {
        includeMissing: true,
        missingCopiesPerMaster: 1,
        ...equipmentAdapterOptions,
      }),
    );
    const equipment = filterOptimizationEquipment(unfilteredEquipment, {
      ...equipmentFilters,
      lockedInstanceIds: lockedInstanceIds(simulator),
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
      equipmentFilters,
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
        enemy: { ...updated.enemy, dataSource: 'custom', stage2Defense: null },
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
          stage2Defense: formation.stage2Defense || null,
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

  updateEquipmentFilters = (updater) => {
    const catalogEquipment = this.currentOptimizationEquipment(true);
    const current = effectiveEquipmentFilters(this.state.equipmentFilters, catalogEquipment);
    const equipmentFilters = normalizeEquipmentFilters(updater(current));
    saveEquipmentFilters(this.equipmentFilterStorage, equipmentFilters);
    this.searchGeneration += 1;
    this.searchRunner?.cancel();
    this.setState({
      equipmentFilters,
      messages: [],
      results: [],
      search: null,
      isSearching: false,
      searchPhase: null,
      searchProgress: null,
    });
  };

  updateExcludeCarrierAircraft = (excludeCarrierAircraft) => {
    this.updateEquipmentFilters((filters) => ({
      ...filters,
      excludeCarrierAircraft: Boolean(excludeCarrierAircraft),
    }));
  };

  toggleEquipmentBlacklist = (masterId, checked) => {
    this.updateEquipmentFilters((filters) => {
      const selected = new Set(filters.blacklistedMasterIds);
      if (checked) selected.add(Number(masterId));
      else selected.delete(Number(masterId));
      return { ...filters, blacklistedMasterIds: [...selected] };
    });
  };

  toggleEquipmentTypeBlacklist = (equipType, checked) => {
    this.updateEquipmentFilters((filters) => {
      const selected = new Set(filters.blacklistedEquipTypes);
      if (checked) selected.add(Number(equipType));
      else selected.delete(Number(equipType));
      return { ...filters, blacklistedEquipTypes: [...selected] };
    });
  };

  resetEquipmentBlacklist = () => {
    const defaults = defaultBlacklistedMasterIds(this.currentOptimizationEquipment(true));
    this.updateEquipmentFilters((filters) => ({
      ...filters,
      blacklistedMasterIds: defaults,
      blacklistedEquipTypes: [],
    }));
  };

  clearEquipmentBlacklist = () => {
    this.updateEquipmentFilters((filters) => ({
      ...filters,
      blacklistedMasterIds: [],
      blacklistedEquipTypes: [],
    }));
  };

  updateSlotPlane = (baseIndex, slotIndex, instanceId) => {
    const plane = findSelectablePlane(this.currentOwnedEquipment(), this.state.simulator, instanceId);
    if (plane) {
      const filters = effectiveEquipmentFilters(
        this.state.equipmentFilters,
        this.currentOptimizationEquipment(true),
      );
      if (isEquipmentExcluded(plane, filters)) return;
    }
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
      simulator: normalizeSimulatorState(applyPlanToSimulator(state.simulator, plan)),
    }));
  };

  currentOwnedEquipment() {
    const poiState = this.readPoiState();
    return poiState ? extractOwnedPlanes(poiState, {
      noro6Master: this.state.noro6Master,
    }) : [];
  }

  currentOptimizationEquipment(includeMissing) {
    const poiState = this.readPoiState();
    return poiState ? extractOptimizationPlanes(poiState, {
      includeMissing: includeMissing === true,
      missingCopiesPerMaster: 1,
      noro6Master: this.state.noro6Master,
    }) : [];
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
    const catalogEquipment = this.currentOptimizationEquipment(true);
    const previewEquipment = simulator.candidateMode === 'theoretical'
      ? catalogEquipment
      : ownedEquipment;
    const equipmentFilters = effectiveEquipmentFilters(
      this.state.equipmentFilters,
      catalogEquipment,
    );
    const filteredPreviewEquipment = filterOptimizationEquipment(previewEquipment, {
      ...equipmentFilters,
      lockedInstanceIds: lockedInstanceIds(simulator),
    });
    const enemyCatalog = this.state.enemyCatalog || this.currentEnemyCatalog();

    return h(
      'div',
      { style: styles.page },
      h('h1', { style: styles.pageTitle }, t('title')),
      h(SimulatorPanel, {
        simulator,
        summary,
        equipment: ownedEquipment,
        equipmentFilters,
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
        theoreticalCount: this.state.isSearching
          ? this.state.theoreticalCount
          : filteredPreviewEquipment.length,
        messages: this.state.messages,
        results: this.state.results,
        search: this.state.search,
        isSearching: this.state.isSearching,
        searchPhase: this.state.searchPhase,
        searchProgress: this.state.searchProgress,
        equipmentFilters,
        equipmentCatalog: uniqueEquipmentMasters(catalogEquipment),
        equipmentBlacklistOpen: this.state.equipmentBlacklistOpen,
        equipmentBlacklistQuery: this.state.equipmentBlacklistQuery,
        onCandidateModeChange: this.updateCandidateMode,
        onExcludeCarrierAircraftChange: this.updateExcludeCarrierAircraft,
        onEquipmentBlacklistOpen: () => this.setState({ equipmentBlacklistOpen: true }),
        onEquipmentBlacklistClose: () => this.setState({ equipmentBlacklistOpen: false }),
        onEquipmentBlacklistQueryChange: (equipmentBlacklistQuery) =>
          this.setState({ equipmentBlacklistQuery }),
        onEquipmentBlacklistToggle: this.toggleEquipmentBlacklist,
        onEquipmentTypeBlacklistToggle: this.toggleEquipmentTypeBlacklist,
        onEquipmentBlacklistReset: this.resetEquipmentBlacklist,
        onEquipmentBlacklistClear: this.clearEquipmentBlacklist,
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

function effectiveEquipmentFilters(filters, equipment) {
  if (Array.isArray(filters?.blacklistedMasterIds)) {
    return normalizeEquipmentFilters(filters);
  }
  return {
    excludeCarrierAircraft: filters?.excludeCarrierAircraft === true,
    blacklistedMasterIds: defaultBlacklistedMasterIds(equipment),
    blacklistedEquipTypes: [],
  };
}

function normalizeEquipmentFilters(filters = {}) {
  return {
    excludeCarrierAircraft: filters.excludeCarrierAircraft === true,
    blacklistedMasterIds: [...new Set((filters.blacklistedMasterIds || [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0))]
      .sort((left, right) => left - right),
    blacklistedEquipTypes: [...new Set((filters.blacklistedEquipTypes || [])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0))]
      .sort((left, right) => left - right),
  };
}

function lockedInstanceIds(simulator) {
  return simulator.bases.flatMap((base) => base.slots
    .filter((slot) => slot.locked && slot.plane)
    .map((slot) => slot.plane.instanceId));
}

function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (_error) {
    return null;
  }
}

function loadEquipmentFilters(storage) {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(EQUIPMENT_FILTER_STORAGE_KEY));
    return value && Array.isArray(value.blacklistedMasterIds)
      ? normalizeEquipmentFilters(value)
      : null;
  } catch (_error) {
    return null;
  }
}

function saveEquipmentFilters(storage, filters) {
  if (!storage) return;
  try {
    storage.setItem(EQUIPMENT_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch (_error) {
    // A read-only Poi profile should not prevent searches.
  }
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
  equipmentPicker: {
    minWidth: 240,
    position: 'relative',
  },
  equipmentPickerControl: {
    alignItems: 'stretch',
    display: 'flex',
    minWidth: 0,
  },
  equipmentPickerInput: {
    boxSizing: 'border-box',
    fontSize: 13,
    height: 30,
    minWidth: 0,
    padding: '2px 6px',
    width: '100%',
  },
  equipmentPickerClear: {
    cursor: 'pointer',
    flex: '0 0 30px',
    fontSize: 18,
    height: 30,
    padding: 0,
  },
  equipmentPickerMenu: {
    backgroundColor: 'Canvas',
    border: border,
    boxShadow: '0 5px 14px rgba(0, 0, 0, 0.3)',
    color: 'CanvasText',
    left: 0,
    maxHeight: 360,
    minWidth: 'min(520px, calc(100vw - 40px))',
    overflowY: 'auto',
    position: 'absolute',
    top: '100%',
    zIndex: 50,
  },
  equipmentPickerGroup: {
    background: 'rgba(128, 128, 128, 0.18)',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 8px',
    position: 'sticky',
    top: 0,
  },
  equipmentPickerOption: {
    alignItems: 'center',
    background: 'transparent',
    border: 0,
    borderBottom: border,
    color: 'inherit',
    cursor: 'pointer',
    display: 'grid',
    fontSize: 13,
    gap: 8,
    gridTemplateColumns: '120px minmax(0, 1fr)',
    minHeight: 32,
    padding: '4px 8px',
    textAlign: 'left',
    width: '100%',
  },
  equipmentPickerOptionActive: {
    background: 'rgba(47, 125, 100, 0.2)',
  },
  equipmentPickerType: {
    color: '#777',
    fontSize: 12,
  },
  equipmentPickerEmpty: {
    padding: 10,
  },
  equipmentPickerMeta: {
    color: '#777',
    fontSize: 12,
    padding: '5px 8px',
  },
  blacklistedSelection: {
    color: '#a56a00',
    opacity: 0.75,
  },
  modalBackdrop: {
    alignItems: 'center',
    background: 'rgba(0, 0, 0, 0.46)',
    bottom: 0,
    display: 'flex',
    justifyContent: 'center',
    left: 0,
    padding: 16,
    position: 'fixed',
    right: 0,
    top: 0,
    zIndex: 1000,
  },
  modalDialog: {
    background: '#fff',
    border: border,
    boxSizing: 'border-box',
    color: '#222',
    display: 'grid',
    gap: 10,
    maxHeight: 'min(720px, calc(100vh - 32px))',
    maxWidth: 680,
    padding: 12,
    width: 'min(680px, 100%)',
  },
  modalHeader: {
    alignItems: 'center',
    display: 'flex',
    justifyContent: 'space-between',
  },
  blacklistToolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  searchInput: {
    boxSizing: 'border-box',
    flex: '1 1 240px',
    fontSize: 13,
    height: 28,
    minWidth: 0,
    padding: '2px 6px',
  },
  blacklistList: {
    border: border,
    display: 'grid',
    maxHeight: 'min(560px, calc(100vh - 150px))',
    overflowY: 'auto',
  },
  blacklistItem: {
    alignItems: 'center',
    borderBottom: border,
    display: 'grid',
    fontSize: 13,
    gap: 8,
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    minHeight: 32,
    padding: '3px 8px',
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
