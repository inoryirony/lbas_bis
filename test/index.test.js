import { describe, expect, test } from 'vitest';
import plugin from '../index.js';

const { normalizeTargetStates, parseTargetStates } = plugin;

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
