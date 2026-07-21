'use strict';

const React = require('react');

const h = React.createElement;

function MapPresetPicker({ catalog, selection, onSelectionChange, onApply, t, styles }) {
  if (!catalog) return h('div', { style: styles.meta }, t('mapDataLoading'));
  const nodes = selection.area ? catalog.nodes(selection.area) : [];
  const difficulties = selection.area && selection.node
    ? catalog.difficulties(selection.area, selection.node)
    : [];
  const formations = selection.area && selection.node && selection.difficulty != null
    ? catalog.formations(selection.area, selection.node, selection.difficulty)
    : [];
  const formation = formations.find((item) => item.id === selection.formationId) || null;
  return h(
    'section',
    { style: styles.mapPreset },
    h('strong', null, t('mapPreset')),
    h(
      'div',
      { style: styles.mapPresetGrid },
      selectField('mapArea', selection.area ?? '', catalog.areas.map((area) => ({
        value: area.area,
        label: `${Math.floor(area.area / 10)}-${area.area % 10} ${area.name}`,
      })), (value) => onSelectionChange('area', value), t, styles),
      selectField('mapNode', selection.node || '', nodes.map((node) => ({
        value: node.node,
        label: `${node.node}${node.isBoss ? ` (${t('bossNode')})` : ''}`,
      })), (value) => onSelectionChange('node', value), t, styles),
      selectField('mapDifficulty', selection.difficulty ?? '', difficulties.map((value) => ({
        value,
        label: t(`difficulty_${value}`),
      })), (value) => onSelectionChange('difficulty', value), t, styles),
      selectField('enemyFormation', selection.formationId || '', formations.map((item, index) => ({
        value: item.id,
        label: `#${index + 1} · ${t('enemyAir')} ${item.enemyAir}`,
      })), (value) => onSelectionChange('formationId', value), t, styles),
    ),
    formation
      ? h(
        'div',
        { style: styles.mapPreview },
        `${t('enemyAir')} ${formation.enemyAir} / ${t('radius')} ${formation.radius.join(' → ')} / ${t('supremacy')} ${formation.thresholds.supremacy} / ${t('superiority')} ${formation.thresholds.superiority} / ${t('parity')} ${formation.thresholds.parity} / ${t('denial')} ${formation.thresholds.denial}`,
      )
      : null,
    h('button', {
      type: 'button',
      disabled: !formation,
      onClick: () => onApply(formation),
      style: styles.button,
    }, t('applyMapPreset')),
  );
}

function selectField(labelKey, value, options, onChange, t, styles) {
  return h(
    'label',
    { style: styles.field },
    h('span', null, t(labelKey)),
    h(
      'select',
      {
        value,
        onChange: (event) => onChange(event.target.value),
        style: styles.select,
      },
      h('option', { value: '' }, t('none')),
      options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
    ),
  );
}

module.exports = MapPresetPicker;
