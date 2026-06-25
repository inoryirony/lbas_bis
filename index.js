'use strict';

const React = require('react');
const { optimizeLoadouts } = require('./src/optimizer');
const { extractOwnedPlanes } = require('./src/poi-data');

const h = React.createElement;
const STATE_OPTIONS = ['denial', 'parity', 'superiority', 'supremacy'];

class LbasBisPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      baseCount: 2,
      enemyAir: 72,
      targetRadius: 7,
      targetStates: 'parity,parity',
      equipmentCount: 0,
      messages: [],
      results: [],
    };
  }

  runOptimizer = () => {
    const poiState = readPoiState();
    if (!poiState) {
      this.setState({
        messages: ['Poi state is not available yet. Open this inside Poi after game data is loaded.'],
        results: [],
        equipmentCount: 0,
      });
      return;
    }

    const equipment = extractOwnedPlanes(poiState);
    const result = optimizeLoadouts({
      equipment,
      baseCount: Number(this.state.baseCount),
      targetRadius: Number(this.state.targetRadius),
      enemyAir: Number(this.state.enemyAir),
      targetStates: parseTargetStates(this.state.targetStates),
      maxResults: 10,
    });

    this.setState({
      equipmentCount: equipment.length,
      messages: result.messages,
      results: result.results,
    });
  };

  updateNumber = (key) => (event) => {
    this.setState({ [key]: Number(event.target.value) });
  };

  updateText = (key) => (event) => {
    this.setState({ [key]: event.target.value });
  };

  render() {
    return h(
      'div',
      { style: styles.page },
      h('h2', { style: styles.title }, 'LBAS BIS'),
      h(
        'div',
        { style: styles.controls },
        this.renderNumberInput('Target radius', 'targetRadius', 1, 20),
        this.renderNumberInput('Enemy air', 'enemyAir', 0, 999),
        this.renderNumberInput('Bases', 'baseCount', 1, 3),
        h(
          'label',
          { style: styles.field },
          h('span', null, 'Target states'),
          h('input', {
            value: this.state.targetStates,
            onChange: this.updateText('targetStates'),
            style: styles.input,
          }),
        ),
        h(
          'button',
          { type: 'button', onClick: this.runOptimizer, style: styles.button },
          'Optimize',
        ),
      ),
      h('div', { style: styles.meta }, `Owned LBAS candidates: ${this.state.equipmentCount}`),
      this.renderMessages(),
      this.renderResults(),
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

  renderResults() {
    if (!this.state.results.length) {
      return h('div', { style: styles.empty }, 'No result yet.');
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
            `Plan ${planIndex + 1} - attack ${plan.totalAttackScore}, worst margin ${plan.worstMargin}`,
          ),
          ...plan.bases.map((base, baseIndex) => this.renderBase(base, baseIndex)),
        ),
      ),
    );
  }

  renderBase(base, baseIndex) {
    return h(
      'div',
      { key: `base-${baseIndex}`, style: styles.base },
      h(
        'div',
        { style: styles.baseSummary },
        `Base ${baseIndex + 1}: air ${base.airPower}, ${base.state.key}, radius ${base.radius}`,
      ),
      h(
        'ol',
        { style: styles.loadout },
        base.loadout.map((item) =>
          h(
            'li',
            { key: item.instanceId },
            `${item.name} #${item.instanceId} aa ${item.antiAir} r${item.radius} ${item.role}`,
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
  const states = String(value || '')
    .split(',')
    .map((state) => state.trim())
    .filter((state) => STATE_OPTIONS.includes(state))
    .filter(Boolean);
  return states.length ? states : ['parity'];
}

const styles = {
  page: {
    boxSizing: 'border-box',
    fontFamily: 'sans-serif',
    padding: 16,
  },
  title: {
    fontSize: 20,
    margin: '0 0 12px',
  },
  controls: {
    alignItems: 'end',
    display: 'grid',
    gap: 8,
    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
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
    color: '#555',
    fontSize: 12,
    marginTop: 8,
  },
  messages: {
    color: '#9a3412',
    fontSize: 12,
    margin: '8px 0',
    paddingLeft: 18,
  },
  empty: {
    color: '#666',
    fontSize: 13,
    marginTop: 16,
  },
  results: {
    display: 'grid',
    gap: 12,
    marginTop: 16,
  },
  plan: {
    border: '1px solid #d8d8d8',
    borderRadius: 6,
    padding: 10,
  },
  planTitle: {
    fontSize: 14,
    margin: '0 0 8px',
  },
  base: {
    borderTop: '1px solid #ececec',
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
};

module.exports = {
  reactClass: LbasBisPanel,
  windowMode: true,
  parseTargetStates,
};
