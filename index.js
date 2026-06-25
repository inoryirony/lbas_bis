'use strict';

const React = require('react');
const { optimizeLoadouts } = require('./src/optimizer');
const { extractOptimizationPlanes, extractOwnedPlanes } = require('./src/poi-data');

const h = React.createElement;
const PLUGIN_ID = 'lbas_bis';
const STATE_OPTIONS = ['denial', 'parity', 'superiority', 'supremacy'];
const FALLBACK_ZH_CN = {
  title: '陆航优化',
  targetRadius: '目标半径',
  enemyAir: '敌制空',
  baseCount: '基地队数',
  targetState: '目标状态',
  waveTarget: '第 {{base}} 队第 {{wave}} 波',
  optimize: '计算配装',
  availablePlanes: '可用飞机',
  noResult: '暂无结果',
  noPoiState: '尚未读取到 Poi 数据，请在游戏数据加载后重试。',
  noCandidateRadius: '没有可达半径 {{radius}} 的候选配装。',
  plan: '方案',
  attack: '攻击',
  damagePower: '伤害基准',
  worstMargin: '最小余量',
  base: '第 {{index}} 队',
  wave: '第 {{index}} 波',
  airPower: '制空',
  radius: '半径',
  denial: '劣势',
  parity: '均势',
  superiority: '优势',
  supremacy: '确保',
  role_fighter: '制空',
  role_attacker: '攻击',
  role_recon: '侦察/延程',
  role_unknown: '其他',
};

Object.assign(FALLBACK_ZH_CN, {
  theoreticalPlanes: '理论候选',
  minimumProficiency: '最低熟练度',
  missingEquipment: '缺少装备',
  missing: '未持有',
  role_seaplaneBomber: '水爆',
});

class LbasOptimizerPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      baseCount: 1,
      enemyAir: 72,
      targetRadius: 7,
      targetStates: ['parity', 'parity'],
      equipmentCount: 0,
      theoreticalCount: 0,
      messages: [],
      results: [],
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

    const ownedEquipment = extractOwnedPlanes(poiState);
    const equipment = extractOptimizationPlanes(poiState, {
      maxCopiesPerMaster: Number(this.state.baseCount) * 4,
    });
    const result = optimizeLoadouts({
      equipment,
      baseCount: Number(this.state.baseCount),
      targetRadius: Number(this.state.targetRadius),
      enemyAir: Number(this.state.enemyAir),
      targetStates: normalizeTargetStates(this.state.targetStates, this.state.baseCount),
      maxResults: 10,
    });

    this.setState({
      equipmentCount: ownedEquipment.length,
      theoreticalCount: equipment.length,
      messages: localizeMessages(result.messages, t),
      results: result.results,
    });
  };

  updateNumber = (key) => (event) => {
    const value = Number(event.target.value);
    if (key === 'baseCount') {
      const baseCount = clamp(value, 1, 3);
      this.setState((state) => ({
        baseCount,
        targetStates: normalizeTargetStates(state.targetStates, baseCount),
      }));
      return;
    }
    this.setState({ [key]: value });
  };

  updateTargetState = (index) => (event) => {
    const targetStates = normalizeTargetStates(this.state.targetStates, this.state.baseCount);
    targetStates[index] = event.target.value;
    this.setState({ targetStates });
  };

  render() {
    const t = getT();
    return h(
      'div',
      { style: styles.page },
      h('h2', { style: styles.title }, t('title')),
      h(
        'div',
        { style: styles.controls },
        this.renderNumberInput(t('targetRadius'), 'targetRadius', 1, 20),
        this.renderNumberInput(t('enemyAir'), 'enemyAir', 0, 999),
        this.renderNumberInput(t('baseCount'), 'baseCount', 1, 3),
        ...this.renderTargetStateInputs(t),
        h(
          'button',
          { type: 'button', onClick: this.runOptimizer, style: styles.button },
          t('optimize'),
        ),
      ),
      h(
        'div',
        { style: styles.meta },
        `${t('availablePlanes')}: ${this.state.equipmentCount} / ${t('theoreticalPlanes')}: ${this.state.theoreticalCount}`,
      ),
      this.renderMessages(),
      this.renderResults(t),
    );
  }

  renderNumberInput(label, key, min, max) {
    return h(
      'label',
      { style: styles.field },
      h('span', null, label),
      h('input', {
        type: 'number',
        min,
        max,
        value: this.state[key],
        onChange: this.updateNumber(key),
        style: styles.input,
      }),
    );
  }

  renderTargetStateInputs(t) {
    return normalizeTargetStates(this.state.targetStates, this.state.baseCount).map((state, index) =>
      h(
        'label',
        { key: `target-state-${index}`, style: styles.field },
        h('span', null, format(t('waveTarget'), { base: Math.floor(index / 2) + 1, wave: (index % 2) + 1 })),
        h(
          'select',
          {
            value: state,
            onChange: this.updateTargetState(index),
            style: styles.input,
          },
          STATE_OPTIONS.map((option) =>
            h('option', { key: option, value: option }, t(option)),
          ),
        ),
      ),
    );
  }

  renderMessages() {
    if (!this.state.messages.length) {
      return null;
    }

    return h(
      'ul',
      { style: styles.messages },
      this.state.messages.map((message) => h('li', { key: message }, message)),
    );
  }

  renderResults(t) {
    if (!this.state.results.length) {
      return h('div', { style: styles.empty }, t('noResult'));
    }

    return h(
      'div',
      { style: styles.results },
      this.state.results.map((plan, planIndex) =>
        h(
          'section',
          { key: `plan-${planIndex}`, style: styles.plan },
          h(
            'h3',
            { style: styles.planTitle },
            `${t('plan')} ${planIndex + 1} · ${t('damagePower')} ${plan.totalDamagePower} · ${t('worstMargin')} ${plan.worstMargin}`,
          ),
          this.renderPlanSummary(plan, t),
          this.renderWaves(plan.waves, t),
          ...plan.bases.map((base, baseIndex) => this.renderBase(base, baseIndex, t)),
        ),
      ),
    );
  }

  renderPlanSummary(plan, t) {
    const parts = [
      `${t('minimumProficiency')}: ${formatProficiency(plan.minimumProficiency)}`,
    ];
    if (plan.missingEquipment && plan.missingEquipment.length) {
      parts.push(`${t('missingEquipment')}: ${plan.missingEquipment.map((item) => `${item.name} x${item.count}`).join(', ')}`);
    }
    return h('div', { style: styles.planSummary }, parts.join(' / '));
  }

  renderWaves(waves, t) {
    return h(
      'div',
      { style: styles.waves },
      waves.map((wave) =>
        h(
          'span',
          { key: wave.waveIndex, style: styles.wave },
          `${format(t('wave'), { index: wave.waveIndex + 1 })}: ${t(wave.state.key)} / ${t('targetState')} ${t(wave.targetState)} / ${t('airPower')} ${wave.airPower}`,
        ),
      ),
    );
  }

  renderBase(base, baseIndex, t) {
    return h(
      'div',
      { key: `base-${baseIndex}`, style: styles.base },
      h(
        'div',
        { style: styles.baseSummary },
        `${format(t('base'), { index: baseIndex + 1 })}: ${t('airPower')} ${base.airPower}, ${t(base.state.key)}, ${t('radius')} ${base.radius}, ${t('damagePower')} ${base.damagePower}`,
      ),
      h(
        'ol',
        { style: styles.loadout },
        base.loadout.map((item) =>
          h(
            'li',
            { key: item.instanceId, style: item.available === false ? styles.missingItem : null },
            `${item.name} #${item.instanceId} · ${t('airPower')} ${item.antiAir} · ${t('radius')} ${item.radius} · ${t(`role_${item.role}`)}`,
          ),
        ),
      ),
    );
  }
}

function readPoiState() {
  if (typeof window === 'undefined' || typeof window.getStore !== 'function') {
    return null;
  }
  return window.getStore();
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
    return message;
  });
}

function getT() {
  try {
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

const styles = {
  page: {
    boxSizing: 'border-box',
    fontFamily: 'sans-serif',
    padding: 12,
  },
  title: {
    fontSize: 18,
    margin: '0 0 10px',
  },
  controls: {
    alignItems: 'end',
    display: 'grid',
    gap: 8,
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  },
  field: {
    display: 'grid',
    fontSize: 12,
    gap: 4,
  },
  input: {
    boxSizing: 'border-box',
    fontSize: 13,
    height: 28,
    padding: '2px 6px',
    width: '100%',
  },
  button: {
    cursor: 'pointer',
    fontSize: 13,
    height: 28,
    padding: '0 12px',
  },
  meta: {
    color: '#777',
    fontSize: 12,
    marginTop: 8,
  },
  messages: {
    color: '#d9534f',
    fontSize: 12,
    margin: '8px 0',
    paddingLeft: 18,
  },
  empty: {
    color: '#777',
    fontSize: 13,
    marginTop: 12,
  },
  results: {
    display: 'grid',
    gap: 10,
    marginTop: 12,
  },
  plan: {
    border: '1px solid rgba(128, 128, 128, 0.35)',
    borderRadius: 4,
    padding: 10,
  },
  planTitle: {
    fontSize: 14,
    margin: '0 0 8px',
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
    borderRadius: 4,
    fontSize: 12,
    padding: '2px 6px',
  },
  base: {
    borderTop: '1px solid rgba(128, 128, 128, 0.2)',
    paddingTop: 8,
  },
  baseSummary: {
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 4,
  },
  loadout: {
    fontSize: 12,
    lineHeight: 1.5,
    margin: 0,
    paddingLeft: 18,
  },
  missingItem: {
    color: '#777',
    opacity: 0.55,
  },
};

module.exports = {
  formatProficiency,
  reactClass: LbasOptimizerPanel,
  parseTargetStates,
  normalizeTargetStates,
};
