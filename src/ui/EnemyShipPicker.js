'use strict';

const React = require('react');

const h = React.createElement;
const CUSTOM_ENEMY_SHIP_ID = '__custom__';

/** Renders known-enemy selectors and editable custom enemy ship rows. */
function EnemyShipPicker({ catalog, ships, onChange, onNameChange, onSlotAdd, t, styles }) {
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
          value: selected.custom ? CUSTOM_ENEMY_SHIP_ID : selected.id ?? '',
          onChange: (event) => onChange(index, event.target.value || null),
          style: styles.select,
        },
        h('option', { value: '' }, t('none')),
        h('option', { value: CUSTOM_ENEMY_SHIP_ID }, t('customEnemyShip')),
        options.map((ship) => h(
          'option',
          { key: ship.id, value: ship.id },
          `${ship.name} · ${ship.typeName || t('unknownEnemyType')} · #${ship.id} · ${t('enemyAir')} ${ship.airPower}`,
        )),
      ),
      selected.custom
        ? h(
          React.Fragment,
          null,
          h('input', {
            type: 'text',
            value: selected.name || '',
            onChange: (event) => onNameChange(index, event.target.value),
            placeholder: t('customEnemyShipName'),
            'aria-label': t('customEnemyShipName'),
            style: styles.input,
          }),
          h('button', {
            type: 'button',
            onClick: () => onSlotAdd(index),
            style: styles.button,
          }, t('addSlotForShip')),
        )
        : null,
      selected.id
        ? h('button', {
          type: 'button',
          onClick: () => onChange(index, selected.id),
          title: t('refreshEnemyShip'),
          style: styles.button,
        }, t('refreshEnemyShip'))
        : null,
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
