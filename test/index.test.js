import { describe, expect, test, vi } from 'vitest';
import plugin from '../index.js';
import simulatorState from '../src/simulator-state.js';

const { normalizeTargetStates, parseTargetStates } = plugin;
const { normalizeSimulatorState } = simulatorState;

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
    expect(renderedText).toContain('自定义敌机槽位');
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
