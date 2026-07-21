'use strict';

const React = require('react');
const BaseTable = require('./BaseTable');
const EnemyPanel = require('./EnemyPanel');
const WaveStatusTable = require('./WaveStatusTable');

const h = React.createElement;

function SimulatorPanel(props) {
  const {
    simulator,
    summary,
    equipment,
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
    onMapSelectionChange,
    onMapPresetApply,
    onAirRaidCellChange,
    onSimulationOptionChange,
    onSlotPlaneChange,
    onSlotLockChange,
    onWaveTargetChange,
    onClear,
    t,
    styles,
  } = props;

  return h(
    'section',
    { style: styles.simulatorPanel },
    h('h2', { style: styles.title }, t('simulatorTitle')),
    h(
      'div',
      { style: styles.simulatorGrid },
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
          summaries: summary.bases,
          onSlotPlaneChange,
          onSlotLockChange,
          t,
          styles,
        }),
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
        enemyCatalog,
        mapCatalog,
        mapSelection,
        onEnemyModeChange,
        onEnemyAirChange,
        onEnemySlotChange,
        onEnemySlotAdd,
        onEnemySlotRemove,
        onEnemyShipChange,
        onMapSelectionChange,
        onMapPresetApply,
        onAirRaidCellChange,
        onSimulationOptionChange,
        t,
        styles,
      }),
    ),
  );
}

module.exports = SimulatorPanel;
