'use strict';

const React = require('react');

const h = React.createElement;

function EnemyPanel(props) {
  const { enemy, lines, onEnemyAirChange, t, styles } = props;
  return h(
    'section',
    { style: styles.enemyPanel },
    h('h3', { style: styles.sectionTitle }, t('enemyFleet')),
    h(
      'div',
      { style: styles.enemyControls },
      h(
        'label',
        { style: styles.field },
        h('span', null, t('enemyAir')),
        h('input', {
          type: 'number',
          min: 0,
          value: enemy.enemyAir,
          onChange: (event) => onEnemyAirChange(Number(event.target.value)),
          style: styles.input,
        }),
      ),
      h('div', { style: styles.manualTag }, t('manualMode')),
    ),
    h(
      'table',
      { style: styles.table },
      h('thead', null, h('tr', null, h('th', { style: styles.th }, t('enemyShipName')), h('th', { style: styles.th }, t('airPower')))),
      h(
        'tbody',
        null,
        enemy.ships.map((ship, index) =>
          h(
            'tr',
            { key: `enemy-${index}` },
            h('td', { style: styles.td }, ship.name || t('none')),
            h('td', { style: styles.centerTd }, index === 0 ? enemy.enemyAir : ship.airPower),
          ),
        ),
      ),
    ),
    h(
      'div',
      { style: styles.lines },
      h('strong', null, `${t('necessaryLines')}: `),
      `${t('supremacy')} ${lines.supremacy} / ${t('superiority')} ${lines.superiority} / ${t('parity')} ${lines.parity} / ${t('denial')} ${lines.denial}`,
    ),
  );
}

module.exports = EnemyPanel;
