'use strict';

const React = require('react');

const h = React.createElement;
const STATE_OPTIONS = ['denial', 'parity', 'superiority', 'supremacy'];

function WaveStatusTable(props) {
  const { waves, onWaveTargetChange, t, styles } = props;
  return h(
    'div',
    { style: styles.wavePanel },
    h(
      'div',
      { style: styles.waveList },
      waves.map((wave) =>
        h(
          'label',
          { key: `wave-${wave.waveIndex}`, style: styles.waveField },
          h('span', null, format(t('wave'), { index: wave.waveIndex + 1 })),
          h(
            'select',
            {
              value: wave.targetState,
              onChange: (event) => onWaveTargetChange(wave.waveIndex, event.target.value),
              style: styles.smallSelect,
            },
            STATE_OPTIONS.map((option) => h('option', { key: option, value: option }, t(option))),
          ),
          renderWaveResult(wave, t, styles),
        ),
      ),
    ),
  );
}

/** Renders deterministic state or Monte Carlo target probability. */
function renderWaveResult(wave, t, styles) {
  if (wave.state) {
    return h('strong', { style: wave.fulfilled ? styles.goodState : styles.badState }, t(wave.state.key));
  }
  const probability = Math.round((wave.targetFulfillmentProbability || 0) * 1000) / 10;
  return h(
    'strong',
    { style: probability >= 100 ? styles.goodState : styles.badState },
    `${probability}%`,
  );
}

function format(template, values) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

module.exports = WaveStatusTable;
