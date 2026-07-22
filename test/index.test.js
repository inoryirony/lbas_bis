import { describe, expect, test, vi } from 'vitest';
import plugin from '../index.js';
import simulatorState from '../src/simulator-state.js';

const { normalizeTargetStates, parseTargetStates } = plugin;
const { normalizeSimulatorState, simulatorToOptimizerInput } = simulatorState;

describe('plugin entry', () => {
  test('exports an embedded Poi plugin panel instead of a new window mode', () => {
    expect(plugin.reactClass).toBeTypeOf('function');
    expect(plugin.windowMode).toBeUndefined();
  });

  test('normalizes target states for one selector per base', () => {
    expect(parseTargetStates('parity,bad,supremacy')).toEqual(['parity', 'supremacy']);
    expect(normalizeTargetStates(['denial'], 3)).toEqual([
      'denial',
      'denial',
      'denial',
      'denial',
      'denial',
      'denial',
    ]);
  });

  test('renders simulator-first Chinese UI structure', () => {
    const panel = new plugin.reactClass({});
    const renderedText = collectText(panel.render());

    expect(renderedText).toContain('基地航空队模拟器');
    expect(renderedText).toContain('敌舰队');
    expect(renderedText).toContain('必要线');
    expect(renderedText).toContain('配装优化');
    expect(renderedText).toContain('仅持有装备');
    expect(renderedText).toContain('导入到模拟器');
    expect(renderedText).toContain('静态估算');
    expect(renderedText).toContain('详细逐波模拟');
    expect(renderedText).toContain('统一最低可见熟练度');
    expect(renderedText).toContain('波次状态');
    expect(renderedText).not.toContain('Target radius');
  });

  test('renders honest search metadata, empty slots, and missing equipment', () => {
    const panel = new plugin.reactClass({});
    panel.state.search = {
      status: 'optimal',
      provenOptimal: true,
      nodesExplored: 42,
    };
    panel.state.results = [{
      totalDamagePower: 10,
      worstMargin: 2,
      minimumProficiency: 7,
      missingEquipment: [{ name: '理论装备', count: 1 }],
      waves: [],
      bases: [{
        minimumProficiency: 7,
        loadout: [null, {
          instanceId: 'missing-1',
          name: '理论装备',
          available: false,
          missing: true,
          antiAir: 10,
          radius: 7,
        }],
      }],
    }];

    const renderedText = collectText(panel.render());
    expect(renderedText).toContain('已证明最优');
    expect(renderedText).toContain('搜索节点 42');
    expect(renderedText).toContain('空槽');
    expect(renderedText).toContain('未持有');
    expect(renderedText).toContain('统一最低可见熟练度 >>');
  });

  test('renders background-search phase, progress, and cancellation control', () => {
    const panel = new plugin.reactClass({});
    panel.state.isSearching = true;
    panel.state.searchPhase = 'finding_feasible';
    panel.state.searchProgress = {
      nodesExplored: 2048,
      nodesPruned: 512,
      candidatesEvaluated: 12,
      simulationSamplesEvaluated: 768,
      elapsedMs: 3200,
    };

    const renderedText = collectText(panel.render());
    expect(renderedText).toContain('停止计算');
    expect(renderedText).toContain('正在寻找可行方案');
    expect(renderedText).toContain('搜索节点 2048');
    expect(renderedText).toContain('已剪枝 512');
    expect(renderedText).toContain('当前最佳');
  });

  test('renders editable detailed enemy slot controls', () => {
    const panel = new plugin.reactClass({});
    panel.state.simulator = {
      ...panel.state.simulator,
      simulationOptions: { seed: 7, sampleCount: 1, dispatchMode: 'concentrated' },
      enemy: {
        ...panel.state.simulator.enemy,
        mode: 'detailed',
        slots: [{
          instanceId: 'enemy-slot-0',
          name: 'Enemy fighter',
          sortieAntiAir: 10,
          currentSlot: 18,
          maxSlot: 18,
        }],
      },
    };

    const renderedText = collectText(panel.render());
    expect(renderedText).toContain('敌机名');
    expect(renderedText).toContain('出击对空');
    expect(renderedText).toContain('当前搭载');
    expect(renderedText).toContain('采样数');
    expect(renderedText).toContain('空袭格');
    expect(renderedText).toContain('选择敌舰');
    expect(renderedText).toContain('完全自定义敌舰');
    expect(renderedText).toContain('自定义敌机槽位');
  });

  test('switches any selected map node to a clearly marked custom composition', () => {
    const panel = createSynchronousPanel();
    panel.state.mapSelection = { area: 99, node: 'Z', difficulty: null, formationId: '' };

    panel.useCustomEnemyComposition();

    expect(panel.state.simulator.enemy).toMatchObject({
      dataSource: 'custom',
      areaId: 99,
      nodeId: 'Z',
    });
    expect(collectText(panel.render())).toContain('自定义编成');
  });

  test('restores a custom enemy draft after applying and switching automatic presets', () => {
    const panel = createSynchronousPanel();
    panel.useCustomEnemyComposition();
    panel.updateEnemyShip(0, '__custom__');
    panel.updateEnemyShipName(0, '未来深海舰');
    panel.addEnemySlot(0);
    panel.updateEnemySlot(0, {
      name: '未来舰战',
      sortieAntiAir: 13,
      currentSlot: 27,
      maxSlot: 27,
    });

    panel.applyMapPreset(mapFormation('A', 1501));
    panel.applyMapPreset(mapFormation('B', 1502));
    expect(panel.state.simulator.enemy.dataSource).toBe('automatic');

    panel.useCustomEnemyComposition();

    expect(panel.state.simulator.enemy.ships[0]).toMatchObject({
      custom: true,
      name: '未来深海舰',
    });
    expect(panel.state.simulator.enemy.slots).toEqual([
      expect.objectContaining({
        name: '未来舰战',
        sortieAntiAir: 13,
        currentSlot: 27,
        sourceShipIndex: 0,
      }),
    ]);
  });

  test('restores a static custom air-power draft after applying an automatic preset', () => {
    const panel = createSynchronousPanel();
    panel.updateEnemyAir(137);

    panel.applyMapPreset(mapFormation('A', 1501));
    panel.useCustomEnemyComposition();

    expect(panel.state.simulator.enemy).toMatchObject({
      dataSource: 'custom',
      mode: 'manual',
      enemyAir: 137,
    });
  });

  test('preserves custom detailed slots across static and detailed mode changes', () => {
    const panel = createSynchronousPanel();
    panel.updateEnemyMode('detailed');
    panel.updateEnemySlot(0, {
      name: '往返保留舰战',
      sortieAntiAir: 12,
      currentSlot: 24,
      maxSlot: 24,
    });

    panel.updateEnemyMode('manual');
    expect(panel.state.simulator.enemy.mode).toBe('manual');
    panel.updateEnemyMode('detailed');

    expect(panel.state.simulator.enemy.slots).toEqual([
      expect.objectContaining({
        name: '往返保留舰战',
        sortieAntiAir: 12,
        currentSlot: 24,
        maxSlot: 24,
      }),
    ]);
  });

  test('preserves custom static air across detailed and static mode changes', () => {
    const panel = createSynchronousPanel();
    panel.updateEnemyAir(137);

    panel.updateEnemyMode('detailed');
    panel.updateEnemyMode('manual');

    expect(panel.state.simulator.enemy).toMatchObject({
      mode: 'manual',
      enemyAir: 137,
    });
  });

  test('does not replace the saved custom draft when switching an automatic preset mode', () => {
    const panel = createSynchronousPanel();
    panel.updateEnemyShip(0, '__custom__');
    panel.updateEnemyShipName(0, '保留的自定义敌舰');
    panel.applyMapPreset(mapFormation('A', 1501));

    panel.updateEnemyMode('manual');
    panel.useCustomEnemyComposition();

    expect(panel.state.simulator.enemy.ships[0]).toMatchObject({
      custom: true,
      name: '保留的自定义敌舰',
    });
  });

  test('exports a completely custom enemy ship and aircraft slot in the shared scenario payload', () => {
    const panel = createSynchronousPanel();
    panel.useCustomEnemyComposition();
    panel.updateEnemyShip(0, '__custom__');
    panel.updateEnemyShipName(0, '自定义空母');
    panel.addEnemySlot(0);
    panel.updateEnemySlot(0, {
      name: '自定义舰战',
      sortieAntiAir: 14,
      currentSlot: 36,
      maxSlot: 36,
    });

    const payload = simulatorToOptimizerInput(panel.state.simulator);

    expect(payload.enemy.dataSource).toBe('custom');
    expect(payload.enemy.ships[0]).toMatchObject({ custom: true, name: '自定义空母' });
    expect(payload.enemySlots).toEqual([
      expect.objectContaining({
        name: '自定义舰战',
        sortieAntiAir: 14,
        currentSlot: 36,
        maxSlot: 36,
        sourceShipIndex: 0,
      }),
    ]);
  });

  test('keeps every enemy ship selector for combined-fleet map presets', () => {
    const panel = new plugin.reactClass({});
    panel.updateSimulator = (updater) => {
      panel.state.simulator = normalizeSimulatorState(updater(panel.state.simulator));
    };
    const ships = Array.from({ length: 12 }, (_, index) => ({
      id: 1500 + index,
      name: `Enemy ${index + 1}`,
      airPower: index,
    }));

    panel.applyMapPreset({
      area: 65,
      node: 'M',
      source: 'test',
      radius: [5],
      ships,
      enemySlots: [],
    });

    expect(panel.state.simulator.enemy.ships).toHaveLength(12);
    expect(panel.state.simulator.enemy.ships.at(-1)).toMatchObject({ id: 1511 });
  });

  test('localizes the worker cancellation message', () => {
    const panel = new plugin.reactClass({});
    panel.setState = (patch) => Object.assign(panel.state, patch);

    panel.handleSearchEvent({
      type: 'cancelled',
      result: {
        messages: ['Search cancelled; the current best plan is preserved but is not proven optimal.'],
        results: [],
        search: { status: 'cancelled', provenOptimal: false, nodesExplored: 42 },
      },
    });

    expect(panel.state.messages).toEqual(['搜索已停止；已保留当前最佳方案，但尚未证明全局最优。']);
  });

  test('uses the noro6-enriched catalog when replacing a preset enemy ship', () => {
    const panel = new plugin.reactClass({});
    const selected = {
      id: 2000,
      name: 'Enriched enemy',
      typeName: 'Carrier',
      airPower: 80,
      dataStatus: 'complete',
    };
    panel.state.enemyCatalog = {
      byId: new Map([[selected.id, selected]]),
      slotsForShip: (_shipId, sourceShipIndex) => [{
        instanceId: 'enriched-slot',
        name: 'Enemy fighter',
        sortieAntiAir: 12,
        currentSlot: 18,
        maxSlot: 18,
        sourceShipIndex,
      }],
    };
    panel.currentEnemyCatalog = () => ({ byId: new Map(), slotsForShip: () => [] });
    panel.updateSimulator = (updater) => {
      panel.state.simulator = normalizeSimulatorState(updater(panel.state.simulator));
    };

    panel.updateEnemyShip(0, selected.id);

    expect(panel.state.simulator.enemy.ships[0]).toMatchObject({ id: 2000 });
    expect(panel.state.simulator.enemy.slots).toEqual([
      expect.objectContaining({ instanceId: 'enriched-slot', sourceShipIndex: 0 }),
    ]);
  });

  test('keeps overridden slot values when refreshing the same known enemy ship', () => {
    const panel = createSynchronousPanel();
    const selected = {
      id: 2000,
      name: 'Known enemy',
      typeName: 'Carrier',
      airPower: 41,
      dataStatus: 'complete',
    };
    panel.state.enemyCatalog = {
      ships: [selected],
      byId: new Map([[selected.id, selected]]),
      slotsForShip: (_shipId, sourceShipIndex) => [{
        instanceId: 'refreshed-slot',
        name: 'Master fighter',
        sortieAntiAir: 10,
        currentSlot: 18,
        maxSlot: 18,
        sourceShipIndex,
        sourceSlotIndex: 0,
      }],
    };
    panel.state.simulator = normalizeSimulatorState({
      ...panel.state.simulator,
      enemy: {
        dataSource: 'custom',
        mode: 'detailed',
        ships: [selected],
        slots: [{
          instanceId: 'old-slot',
          name: '玩家修正舰战',
          sortieAntiAir: 15,
          currentSlot: 24,
          maxSlot: 24,
          sourceShipIndex: 0,
          sourceSlotIndex: 0,
          overridden: true,
        }],
      },
    });

    panel.updateEnemyShip(0, selected.id);

    expect(panel.state.simulator.enemy.slots).toEqual([
      expect.objectContaining({
        name: '玩家修正舰战',
        sortieAntiAir: 15,
        currentSlot: 24,
        overridden: true,
      }),
    ]);
  });

  test('exposes a refresh action for the currently selected known enemy ship', () => {
    const panel = createSynchronousPanel();
    const selected = {
      id: 2000,
      name: 'Known enemy',
      typeName: 'Carrier',
      airPower: 41,
      dataStatus: 'complete',
    };
    panel.state.enemyCatalog = {
      ships: [selected],
      byId: new Map([[selected.id, selected]]),
      slotsForShip: () => [],
    };
    panel.state.simulator = normalizeSimulatorState({
      ...panel.state.simulator,
      enemy: {
        dataSource: 'custom',
        mode: 'detailed',
        ships: [selected],
        slots: [],
      },
    });
    panel.updateEnemyShip = vi.fn();

    const refresh = findNodes(panel.render(), (node) =>
      node.type === 'button' && collectText(node) === '刷新敌舰数据')[0];

    expect(refresh).toBeTruthy();
    refresh.props.onClick();
    expect(panel.updateEnemyShip).toHaveBeenCalledWith(0, 2000);
  });

  test('does not reuse a custom enemy slot ID after deleting and adding a slot', () => {
    const panel = new plugin.reactClass({});
    panel.state.simulator = normalizeSimulatorState({
      ...panel.state.simulator,
      enemy: {
        ...panel.state.simulator.enemy,
        mode: 'detailed',
        slots: [
          { instanceId: 'enemy-slot-0', name: 'first', sortieAntiAir: 1, currentSlot: 1, maxSlot: 1 },
          { instanceId: 'enemy-slot-1', name: 'second', sortieAntiAir: 1, currentSlot: 1, maxSlot: 1 },
        ],
      },
    });
    panel.updateSimulator = (updater) => {
      panel.state.simulator = normalizeSimulatorState(updater(panel.state.simulator));
    };

    panel.removeEnemySlot(0);
    panel.addEnemySlot();

    const ids = panel.state.simulator.enemy.slots.map((slot) => slot.instanceId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('does not store a React click event as an enemy slot ship index', () => {
    const panel = createSynchronousPanel();
    panel.updateEnemyMode('detailed');
    const addButton = findNodes(panel.render(), (node) =>
      node.type === 'button' && node.props.title === '增加敌机槽')[0];
    const clickEvent = { type: 'click', target: { tagName: 'BUTTON' } };

    addButton.props.onClick(clickEvent);
    panel.addEnemySlot(clickEvent);

    expect(panel.state.simulator.enemy.slots).toHaveLength(3);
    expect(panel.state.simulator.enemy.slots.slice(1)).toEqual([
      expect.not.objectContaining({ sourceShipIndex: expect.anything() }),
      expect.not.objectContaining({ sourceShipIndex: expect.anything() }),
    ]);
    expect(() => structuredClone(panel.state.simulator)).not.toThrow();
  });

  test('uses cached noro6 master data when Poi state becomes available later', () => {
    const poiState = {
      const: {
        $ships: {
          2999: { api_id: 2999, api_name: 'Late enemy', api_stype: 11 },
        },
        $shipTypes: { 11: { api_name: 'Carrier' } },
        $equips: {},
      },
    };
    const panel = new plugin.reactClass({ readPoiState: () => poiState });
    panel.state.noro6Master = {
      enemies: [{ id: 2999, slots: [24], items: [3999] }],
      items: [{ id: 3999, name: 'Late fighter', antiAir: 12, type: 6 }],
    };

    expect(panel.currentEnemyCatalog().slotsForShip(2999)[0]).toMatchObject({
      source: 'noro6',
      currentSlot: 24,
    });
  });

  test('does not rerun simulator Monte Carlo when only search progress changes', () => {
    const calculateSummary = vi.fn(() => ({ bases: [], waves: [], enemyAirLines: [] }));
    const panel = new plugin.reactClass({ calculateSimulatorSummary: calculateSummary });

    panel.render();
    panel.state.searchProgress = { nodesExplored: 2048 };
    panel.render();

    expect(calculateSummary).toHaveBeenCalledTimes(1);
  });
});

function collectText(node) {
  if (node == null || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join(' ');
  }
  if (typeof node.type === 'function') {
    return collectText(node.type(node.props || {}));
  }
  return collectText(node.props?.children);
}

function findNodes(node, predicate) {
  if (node == null || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  if (typeof node !== 'object') return [];
  if (typeof node.type === 'function') return findNodes(node.type(node.props || {}), predicate);
  const matches = predicate(node) ? [node] : [];
  return [...matches, ...findNodes(node.props?.children, predicate)];
}

/** Creates an unmounted panel whose React state updates run synchronously in unit tests. */
function createSynchronousPanel() {
  const panel = new plugin.reactClass({});
  panel.setState = (updater) => {
    const patch = typeof updater === 'function' ? updater(panel.state) : updater;
    Object.assign(panel.state, patch);
  };
  return panel;
}

/** Creates a minimal automatic map formation for source-switching tests. */
function mapFormation(node, shipId) {
  return {
    area: 65,
    node,
    source: 'test',
    radius: [5],
    ships: [{ id: shipId, name: `Enemy ${shipId}`, airPower: 0 }],
    enemySlots: [],
  };
}
