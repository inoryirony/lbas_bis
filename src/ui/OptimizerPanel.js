'use strict';

const React = require('react');

const h = React.createElement;

function OptimizerPanel(props) {
  const {
    candidateMode,
    equipmentCount,
    theoreticalCount,
    messages,
    results,
    onCandidateModeChange,
    onOptimize,
    onImportPlan,
    t,
    styles,
  } = props;

  return h(
    'section',
    { style: styles.optimizerPanel },
    h('h3', { style: styles.sectionTitle }, t('optimizerTitle')),
    h(
      'div',
      { style: styles.optimizerControls },
      h(
        'label',
        { style: styles.radioLabel },
        h('input', {
          type: 'radio',
          name: 'candidateMode',
          value: 'owned',
          checked: candidateMode !== 'theoretical',
          onChange: () => onCandidateModeChange('owned'),
        }),
        t('ownedOnly'),
      ),
      h(
        'label',
        { style: styles.radioLabel },
        h('input', {
          type: 'radio',
          name: 'candidateMode',
          value: 'theoretical',
          checked: candidateMode === 'theoretical',
          onChange: () => onCandidateModeChange('theoretical'),
        }),
        t('includeMissing'),
      ),
      h('button', { type: 'button', onClick: onOptimize, style: styles.primaryButton }, t('optimize')),
      h('span', { style: styles.meta }, `${t('availablePlanes')}: ${equipmentCount} / ${t('candidatePlanes')}: ${theoreticalCount}`),
    ),
    renderMessages(messages, styles),
    renderResults({ results, onImportPlan, t, styles }),
  );
}

function renderMessages(messages, styles) {
  if (!messages.length) {
    return null;
  }
  return h(
    'ul',
    { style: styles.messages },
    messages.map((message) => h('li', { key: message }, message)),
  );
}

function renderResults({ results, onImportPlan, t, styles }) {
  if (!results.length) {
    return h(
      'table',
      { style: styles.table },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { style: styles.th }, t('plan')),
          h('th', { style: styles.th }, t('sixWaveState')),
          h('th', { style: styles.th }, t('damagePower')),
          h('th', { style: styles.th }, t('missingEquipment')),
          h('th', { style: styles.th }, t('importToSimulator')),
        ),
      ),
      h('tbody', null, h('tr', null, h('td', { colSpan: 5, style: styles.emptyCell }, t('noResult')))),
    );
  }

  return h(
    'div',
    { style: styles.results },
    results.map((plan, planIndex) =>
      h(
        'section',
        { key: `plan-${planIndex}`, style: styles.plan },
        h(
          'div',
          { style: styles.planHeader },
          h('strong', null, `${t('plan')} ${planIndex + 1}`),
          h('span', null, `${t('damagePower')} ${plan.totalDamagePower}`),
          h('span', null, `${t('worstMargin')} ${plan.worstMargin}`),
          h('button', { type: 'button', onClick: () => onImportPlan(plan), style: styles.button }, t('importToSimulator')),
        ),
        h('div', { style: styles.planSummary }, formatMissing(plan.missingEquipment, t)),
        h(
          'div',
          { style: styles.waves },
          plan.waves.map((wave) =>
            h(
              'span',
              { key: wave.waveIndex, style: styles.wave },
              `${format(t('wave'), { index: wave.waveIndex + 1 })}: ${t(wave.state.key)} / ${t('targetState')} ${t(wave.targetState)} / ${t('airPower')} ${wave.airPower}`,
            ),
          ),
        ),
        ...plan.bases.map((base, baseIndex) =>
          h(
            'ol',
            { key: `base-${baseIndex}`, style: styles.loadout },
            base.loadout.map((item) =>
              h(
                'li',
                { key: item.instanceId, style: item.available === false ? styles.missingItem : null },
                `${item.name} #${item.instanceId} · ${t('airPower')} ${item.antiAir} · ${t('radius')} ${item.radius}`,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function formatMissing(missingEquipment, t) {
  if (!missingEquipment || !missingEquipment.length) {
    return `${t('missingEquipment')}: -`;
  }
  return `${t('missingEquipment')}: ${missingEquipment.map((item) => `${item.name} x${item.count}`).join(', ')}`;
}

function format(template, values) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

module.exports = OptimizerPanel;
