'use strict';

const React = require('react');
const { equipmentDamageMultiplier } = require('../combat-context');

const h = React.createElement;
const PROFICIENCY_LABELS = ['-', '|', '||', '|||', '/', '//', '///', '>>'];

function BaseTable(props) {
  const {
    bases,
    equipment,
    summaries,
    combatContext,
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
    t,
    styles,
  } = props;
  const options = optionPlanes(equipment, slot.plane);
  return h(
    'select',
    {
      value: slot.plane ? String(slot.plane.instanceId) : '',
      onChange: (event) => onSlotPlaneChange(
        baseIndex,
        slotIndex,
        /** @type {HTMLSelectElement} */ (event.currentTarget).value,
      ),
      style: styles.select,
    },
    h('option', { value: '' }, t('emptySlot')),
    options.map((plane) =>
      h(
        'option',
        { key: String(plane.instanceId), value: String(plane.instanceId) },
        `${plane.name} #${plane.instanceId}${formatMultiplier(plane, combatContext)}${plane.missing ? ` (${t('missing')})` : ''}`,
      ),
    ),
  );
}

function formatMultiplier(plane, combatContext) {
  const multiplier = equipmentDamageMultiplier(plane, combatContext);
  if (Math.abs(multiplier - 1) < 1e-12) return '';
  return ` ×${Number(multiplier.toFixed(4))}`;
}

function optionPlanes(equipment, currentPlane) {
  const unique = new Map();
  for (const plane of equipment || []) {
    unique.set(String(plane.instanceId), plane);
  }
  if (currentPlane && !unique.has(String(currentPlane.instanceId))) {
    unique.set(String(currentPlane.instanceId), currentPlane);
  }
  return [...unique.values()];
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
