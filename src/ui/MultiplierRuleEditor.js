'use strict';

const React = require('react');

const h = React.createElement;

/** Renders scenario-local target tags and equipment multiplier rules. */
function MultiplierRuleEditor(props) {
  const {
    combatContext,
    onTargetTagsChange,
    onRuleAdd,
    onRuleChange,
    onRuleRemove,
    t,
    styles,
  } = props;
  const rules = combatContext?.multiplierRules || [];
  return h(
    'details',
    { style: styles.advancedEnemySlots },
    h('summary', null, t('multiplierEditor')),
    textField({
      label: t('targetTags'),
      value: (combatContext?.targetTags || []).join(', '),
      onCommit: onTargetTagsChange,
      styles,
    }),
    ...rules.map((rule, ruleIndex) => h(
      'div',
      {
        key: rule.id || `multiplier-rule-${ruleIndex}`,
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 6,
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid rgba(255,255,255,0.12)',
        },
      },
      h('strong', { style: { gridColumn: '1 / -1' } }, rule.label || rule.id),
      textField({
        label: t('ruleLabel'),
        value: rule.label,
        onCommit: (value) => onRuleChange(ruleIndex, 'label', value),
        styles,
      }),
      textField({
        label: t('ruleTargetTags'),
        value: rule.targetTags.join(', '),
        onCommit: (value) => onRuleChange(ruleIndex, 'targetTags', value),
        styles,
      }),
      textField({
        label: t('equipmentMasterIds'),
        value: rule.equipmentMasterIds.join(', '),
        onCommit: (value) => onRuleChange(ruleIndex, 'equipmentMasterIds', value),
        styles,
      }),
      textField({
        label: t('equipmentTypes'),
        value: rule.equipmentTypes.join(', '),
        onCommit: (value) => onRuleChange(ruleIndex, 'equipmentTypes', value),
        styles,
      }),
      textField({
        label: t('stackingGroup'),
        value: rule.group,
        onCommit: (value) => onRuleChange(ruleIndex, 'group', value),
        styles,
      }),
      h(
        'label',
        { style: styles.field },
        h('span', null, t('multiplier')),
        h('input', {
          type: 'number',
          min: 0.01,
          step: 0.01,
          value: rule.multiplier,
          onChange: (event) => onRuleChange(ruleIndex, 'multiplier', event.target.value),
          style: styles.input,
        }),
      ),
      h(
        'label',
        { style: styles.radioLabel },
        h('input', {
          type: 'checkbox',
          checked: rule.enabled,
          onChange: (event) => onRuleChange(ruleIndex, 'enabled', event.target.checked),
        }),
        t('enabled'),
      ),
      h('button', {
        type: 'button',
        onClick: () => onRuleRemove(ruleIndex),
        style: styles.iconButton || styles.button,
        title: t('removeMultiplierRule'),
      }, '×'),
    )),
    h('button', {
      type: 'button',
      onClick: onRuleAdd,
      style: styles.iconButton || styles.button,
      title: t('addMultiplierRule'),
    }, '+'),
  );
}

function textField({ label, value, onCommit, styles }) {
  return h(
    'label',
    { style: styles.field },
    h('span', null, label),
    h('input', {
      type: 'text',
      defaultValue: value,
      onBlur: (event) => onCommit(event.target.value),
      style: styles.input,
      'aria-label': label,
    }),
  );
}

module.exports = MultiplierRuleEditor;
