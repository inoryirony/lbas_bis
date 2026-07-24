'use strict';

const React = require('react');
const BaseTable = require('./BaseTable');
const EnemyPanel = require('./EnemyPanel');
const WaveStatusTable = require('./WaveStatusTable');

const h = React.createElement;
const RESPONSIVE_LAYOUT_CSS = `
  @container lbas-panel (max-width: 820px) {
    .lbas-simulator-grid {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }
`;

function SimulatorPanel(props) {
  const {
    simulator,
    summary,
    equipment,
    equipmentFilters,
    enemyCatalog,
    mapCatalog,
    mapSelection,
    onBaseCountChange,
    onTargetRadiusChange,
    onEnemyAirChange,
    onEnemyModeChange,
    onEnemySlotChange,
    onEnemySlotAdd,
    onEnemySlotRemove,
    onEnemyShipChange,
    onEnemyShipNameChange,
    onMapSelectionChange,
    onUseCustomEnemy,
    onAirRaidCellChange,
    onSimulationOptionChange,
    onCombatTargetTagsChange,
    onMultiplierRuleAdd,
    onMultiplierRuleChange,
    onMultiplierRuleRemove,
    onSlotPlaneChange,
    onSlotProficiencyChange,
    onSlotLockChange,
    onWaveTargetChange,
    onClear,
    t,
    styles,
  } = props;

  return h(
    'section',
    { style: styles.simulatorPanel },
    h('style', null, RESPONSIVE_LAYOUT_CSS),
    h('h2', { style: styles.title }, t('simulatorTitle')),
    h(
      'div',
      { className: 'lbas-simulator-grid', style: styles.simulatorGrid },
      h(
        'div',
        null,
        h(
          'div',
          { style: styles.toolbar },
          h(
            'label',
            { style: styles.fieldInline },
            h('span', null, t('targetRadius')),
            h('input', {
              type: 'number',
              min: 1,
              value: simulator.targetRadius,
              onChange: (event) => onTargetRadiusChange(Number(event.target.value)),
              style: styles.numberInput,
            }),
          ),
          h(
            'label',
            { style: styles.fieldInline },
            h('span', null, t('baseCount')),
            h(
              'select',
              {
                value: simulator.baseCount,
                onChange: (event) => onBaseCountChange(Number(event.target.value)),
                style: styles.smallSelect,
              },
              [1, 2, 3].map((count) => h('option', { key: count, value: count }, count)),
            ),
          ),
          h('span', { style: styles.meta }, `${t('displayWaves')}: ${simulator.baseCount * 2}`),
          h('button', { type: 'button', onClick: onClear, style: styles.button }, t('clearComposition')),
        ),
        h(BaseTable, {
          bases: simulator.bases,
          equipment,
          equipmentFilters,
          summaries: summary.bases,
          combatContext: simulator.combatContext,
          onSlotPlaneChange,
          onSlotProficiencyChange,
          onSlotLockChange,
          t,
          styles,
        }),
        renderCombatSummary(summary.simulation, t, styles),
        h(WaveStatusTable, {
          waves: summary.waves,
          onWaveTargetChange,
          t,
          styles,
        }),
      ),
      h(EnemyPanel, {
        enemy: simulator.enemy,
        lines: summary.enemyAirLines,
        simulationOptions: simulator.simulationOptions,
        combatContext: simulator.combatContext,
        enemyCatalog,
        mapCatalog,
        mapSelection,
        onEnemyModeChange,
        onEnemyAirChange,
        onEnemySlotChange,
        onEnemySlotAdd,
        onEnemySlotRemove,
        onEnemyShipChange,
        onEnemyShipNameChange,
        onMapSelectionChange,
        onUseCustomEnemy,
        onAirRaidCellChange,
        onSimulationOptionChange,
        onCombatTargetTagsChange,
        onMultiplierRuleAdd,
        onMultiplierRuleChange,
        onMultiplierRuleRemove,
        t,
        styles,
      }),
    ),
  );
}

/** Renders compact real-damage totals without conflating them with the proxy. */
function renderCombatSummary(simulation, t, styles) {
  if (!simulation) return null;
  if (!Number.isFinite(simulation.expectedHpDamage) ||
      !Number.isFinite(simulation.expectedSunkCount)) {
    return h('div', { style: styles.meta }, t('hpDamageUnavailable'));
  }
  return h(
    'div',
    { style: styles.planSummary },
    h('span', null, `${t('expectedHpDamage')} ${formatCombatValue(simulation.expectedHpDamage)}`),
    ' / ',
    h('span', null, `${t('expectedSunkCount')} ${formatCombatValue(simulation.expectedSunkCount)}`),
  );
}

/** Keeps compact combat values readable without false precision. */
function formatCombatValue(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = SimulatorPanel;
