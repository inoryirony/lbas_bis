'use strict';

const React = require('react');
const { equipmentDamageMultiplier } = require('../combat-context');
const { shootDownAvoidanceLabelKey } = require('../enemy-stage2');
const EquipmentPicker = require('./EquipmentPicker');

const h = React.createElement;
const PROFICIENCY_LABELS = ['-', '|', '||', '|||', '/', '//', '///', '>>'];

function BaseTable(props) {
  const {
    bases,
    equipment,
    summaries,
    combatContext,
    equipmentFilters,
    onSlotPlaneChange,
    onSlotLockChange,
    t,
    styles,
  } = props;
  return h(
    'div',
    { style: styles.tableWrap },
    h(
      'table',
      { style: styles.table },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { style: styles.th }, t('baseColumn')),
          h('th', { style: styles.th }, t('equipment')),
          h('th', { style: styles.th }, t('lock')),
          h('th', { style: styles.th }, t('proficiency')),
          h('th', { style: styles.th }, t('baseSummary')),
        ),
      ),
      h(
        'tbody',
        null,
        bases.flatMap((base, baseIndex) =>
          base.slots.map((slot, slotIndex) =>
            h(
              'tr',
              { key: `base-${baseIndex}-slot-${slotIndex}` },
              slotIndex === 0
                ? h('td', { rowSpan: base.slots.length, style: styles.baseName }, base.name)
                : null,
              h(
                'td',
                { style: styles.td },
                renderEquipmentSelect({
                  equipment,
                  slot,
                  baseIndex,
                  slotIndex,
                  onSlotPlaneChange,
                  combatContext,
                  equipmentFilters,
                  t,
                  styles,
                }),
              ),
              h(
                'td',
                { style: styles.centerTd },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(slot.locked),
                  onChange: (event) => onSlotLockChange(baseIndex, slotIndex, event.target.checked),
                  title: t('lock'),
                }),
              ),
              h(
                'td',
                { style: styles.centerTd },
                h(
                  'select',
                  { value: slot.plane?.proficiency ?? '', disabled: true, style: styles.smallSelect },
                  h('option', { value: '' }, '-'),
                  PROFICIENCY_LABELS.map((label, index) =>
                    h('option', { key: index, value: index }, label),
                  ),
                ),
              ),
              slotIndex === 0
                ? h(
                    'td',
                    { rowSpan: base.slots.length, style: styles.summaryTd },
                    formatSummary(summaries[baseIndex], t),
                  )
                : null,
            ),
          ),
        ),
      ),
    ),
  );
}

function renderEquipmentSelect(props) {
  const {
    equipment,
    slot,
    baseIndex,
    slotIndex,
    onSlotPlaneChange,
    combatContext,
    equipmentFilters,
    t,
    styles,
  } = props;
  return h(
    EquipmentPicker,
    {
      equipment,
      equipmentFilters,
      plane: slot.plane,
      onChange: (instanceId) => onSlotPlaneChange(
        baseIndex,
        slotIndex,
        instanceId,
      ),
      formatSuffix: (plane) => `${formatAvoidance(plane, t)}${formatMultiplier(plane, combatContext)}`,
      t,
      styles,
    },
  );
}

function formatAvoidance(plane, t) {
  if (!plane || plane.isAttacker !== true) return '';
  return ` · ${t('shootDownAvoidance')} ${t(shootDownAvoidanceLabelKey(plane.shootDownAvoidance))}`;
}

function formatMultiplier(plane, combatContext) {
  const multiplier = equipmentDamageMultiplier(plane, combatContext);
  if (Math.abs(multiplier - 1) < 1e-12) return '';
  return ` ×${Number(multiplier.toFixed(4))}`;
}

function formatSummary(summary, t) {
  if (!summary) {
    return '-';
  }
  return [
    `${t('airPower')} ${summary.airPower}`,
    `${t('radius')} ${summary.radius}`,
    `${t('damagePower')} ${summary.damagePower}`,
    t(summary.state.key),
  ].join(' / ');
}

module.exports = BaseTable;
