'use strict';

const React = require('react');
const EnemyShipPicker = require('./EnemyShipPicker');
const MapPresetPicker = require('./MapPresetPicker');
const MultiplierRuleEditor = require('./MultiplierRuleEditor');

const h = React.createElement;

/** Renders static enemy air or editable detailed aircraft slots. */
function EnemyPanel(props) {
  const {
    enemy,
    lines,
    simulationOptions,
    combatContext,
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
    onMapPresetApply,
    onUseCustomEnemy,
    onAirRaidCellChange,
    onSimulationOptionChange,
    onCombatTargetTagsChange,
    onMultiplierRuleAdd,
    onMultiplierRuleChange,
    onMultiplierRuleRemove,
    t,
    styles,
  } = props;
  const detailed = enemy.mode === 'detailed';

  return h(
    'section',
    { style: styles.enemyPanel },
    h('h3', { style: styles.sectionTitle }, t('enemyFleet')),
    h(MapPresetPicker, {
      catalog: mapCatalog,
      selection: mapSelection,
      onSelectionChange: onMapSelectionChange,
      onApply: onMapPresetApply,
      onUseCustom: onUseCustomEnemy,
      isCustom: enemy.dataSource === 'custom',
      t,
      styles,
    }),
    h(
      'div',
      { style: enemy.dataSource === 'custom' ? styles.customBadge : styles.meta },
      enemy.dataSource === 'custom'
        ? t('customComposition')
        : `${t('automaticComposition')} · ${t('customDraftSaved')}`,
    ),
    h(
      'div',
      { style: styles.enemyControls },
      modeChoice('manual', 'staticEstimate', !detailed, onEnemyModeChange, styles, t),
      modeChoice('detailed', 'detailedSimulation', detailed, onEnemyModeChange, styles, t),
      detailed
        ? h(
          'label',
          { style: styles.radioLabel },
          h('input', {
            type: 'checkbox',
            checked: enemy.isAirRaidCell === true,
            onChange: (event) => onAirRaidCellChange(event.target.checked),
          }),
          t('airRaidCell'),
        )
        : null,
    ),
    detailed
      ? renderDetailedEnemy({
        enemy,
        simulationOptions,
        enemyCatalog,
        onEnemySlotChange,
        onEnemySlotAdd,
        onEnemySlotRemove,
        onEnemyShipChange,
        onEnemyShipNameChange,
        onSimulationOptionChange,
        t,
        styles,
      })
      : renderStaticEnemy({ enemy, lines, onEnemyAirChange, t, styles }),
    h(MultiplierRuleEditor, {
      combatContext,
      onTargetTagsChange: onCombatTargetTagsChange,
      onRuleAdd: onMultiplierRuleAdd,
      onRuleChange: onMultiplierRuleChange,
      onRuleRemove: onMultiplierRuleRemove,
      t,
      styles,
    }),
  );
}

/** Creates one radio-style mode choice. */
function modeChoice(value, labelKey, checked, onChange, styles, t) {
  return h(
    'label',
    { style: styles.radioLabel },
    h('input', {
      type: 'radio',
      name: 'enemyCalculationMode',
      value,
      checked,
      onChange: () => onChange(value),
    }),
    t(labelKey),
  );
}

/** Renders legacy total-air controls and threshold lines. */
function renderStaticEnemy({ enemy, lines, onEnemyAirChange, t, styles }) {
  return h(
    React.Fragment,
    null,
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
    lines
      ? h(
        'div',
        { style: styles.lines },
        h('strong', null, `${t('necessaryLines')}: `),
        `${t('supremacy')} ${lines.supremacy} / ${t('superiority')} ${lines.superiority} / ${t('parity')} ${lines.parity} / ${t('denial')} ${lines.denial}`,
      )
      : null,
  );
}

/** Renders detailed enemy slots and deterministic Monte Carlo controls. */
function renderDetailedEnemy(props) {
  const {
    enemy,
    simulationOptions,
    enemyCatalog,
    onEnemySlotChange,
    onEnemySlotAdd,
    onEnemySlotRemove,
    onEnemyShipChange,
    onEnemyShipNameChange,
    onSimulationOptionChange,
    t,
    styles,
  } = props;
  return h(
    React.Fragment,
    null,
    h(EnemyShipPicker, {
      catalog: enemyCatalog,
      ships: enemy.ships,
      onChange: onEnemyShipChange,
      onNameChange: onEnemyShipNameChange,
      onSlotAdd: onEnemySlotAdd,
      t,
      styles,
    }),
    h(
      'div',
      { style: styles.enemyControls },
      numericField('sampleCount', simulationOptions.sampleCount, 1, onSimulationOptionChange, t, styles),
      numericField('randomSeed', simulationOptions.seed, null, onSimulationOptionChange, t, styles, 'seed'),
      h('span', { style: styles.meta }, `${t('enemyAir')}: ${enemy.enemyAir}`),
    ),
    h(
      'details',
      { style: styles.advancedEnemySlots },
      h('summary', null, t('advancedSlotOverrides')),
      h(
        'table',
        { style: styles.table },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { style: styles.th }, t('enemyPlaneName')),
          h('th', { style: styles.th }, t('sortieAntiAir')),
          h('th', { style: styles.th }, t('currentSlot')),
          h('th', { style: styles.th }, t('maxSlot')),
          h('th', { style: styles.th }, ''),
        ),
      ),
      h(
        'tbody',
        null,
        enemy.slots.map((slot, slotIndex) =>
          h(
            'tr',
            { key: slot.instanceId ?? `enemy-slot-${slotIndex}` },
            editableCell(slot.name, 'text', (value) => onEnemySlotChange(slotIndex, { name: value }), styles),
            editableCell(slot.sortieAntiAir, 'number', (value) => onEnemySlotChange(slotIndex, { sortieAntiAir: value }), styles),
            editableCell(slot.currentSlot, 'number', (value) => onEnemySlotChange(slotIndex, { currentSlot: value }), styles),
            editableCell(slot.maxSlot, 'number', (value) => onEnemySlotChange(slotIndex, { maxSlot: value }), styles),
            h(
              'td',
              { style: styles.centerTd },
              h('button', {
                type: 'button',
                onClick: () => onEnemySlotRemove(slotIndex),
                style: styles.iconButton || styles.button,
                title: t('removeEnemySlot'),
              }, '×'),
            ),
          ),
        ),
      ),
      ),
      h('button', {
        type: 'button',
        onClick: () => onEnemySlotAdd(),
        style: styles.iconButton || styles.button,
        title: t('addEnemySlot'),
      }, '+'),
    ),
    enemy.errors?.length
      ? h('div', { style: styles.badState }, t('invalidDetailedEnemy'))
      : null,
  );
}

/** Creates a compact numeric simulation field. */
function numericField(labelKey, value, minimum, onChange, t, styles, field = labelKey) {
  return h(
    'label',
    { style: styles.fieldInline },
    h('span', null, t(labelKey)),
    h('input', {
      type: 'number',
      ...(minimum == null ? {} : { min: minimum }),
      value,
      onChange: (event) => onChange(field, event.target.value),
      style: styles.numberInput,
    }),
  );
}

/** Creates one editable detailed-slot table cell. */
function editableCell(value, type, onChange, styles) {
  return h(
    'td',
    { style: styles.td },
    h('input', {
      type,
      ...(type === 'number' ? { min: 0 } : {}),
      value: value ?? '',
      onChange: (event) => onChange(event.target.value),
      style: styles.input,
    }),
  );
}

module.exports = EnemyPanel;
