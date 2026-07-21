'use strict';

const React = require('react');

const h = React.createElement;

function EnemyShipPicker({ catalog, ships, onChange, t, styles }) {
  const options = catalog?.ships || [];
  return h(
    'div',
    { style: styles.enemyShipGrid },
    ships.map((selected, index) => h(
      'label',
      { key: `enemy-ship-${index}`, style: styles.field },
      h('span', null, `${t('selectEnemyShip')} ${index + 1}`),
      h(
        'select',
        {
          value: selected.id ?? '',
          onChange: (event) => onChange(index, event.target.value || null),
          style: styles.select,
        },
        h('option', { value: '' }, t('none')),
        options.map((ship) => h(
          'option',
          { key: ship.id, value: ship.id },
          `${ship.name} · ${ship.typeName || t('unknownEnemyType')} · #${ship.id} · ${t('enemyAir')} ${ship.airPower}`,
        )),
      ),
      selected.id && selected.dataStatus !== 'complete'
        ? h(
          'span',
          { style: styles.badState },
          t(selected.dataStatus === 'mismatched' ? 'enemyDataMismatched' : 'enemyDataMissing'),
        )
        : null,
    )),
  );
}

module.exports = EnemyShipPicker;
