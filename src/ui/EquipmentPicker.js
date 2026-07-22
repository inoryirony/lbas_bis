'use strict';

const React = require('react');
const {
  buildEquipmentChoices,
  rankEquipmentMatches,
} = require('../equipment-filter');

const h = React.createElement;
const MAX_VISIBLE_RESULTS = 160;

class EquipmentPicker extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = { activeIndex: 0, open: false, query: '' };
  }

  open = () => {
    this.setState({ activeIndex: 0, open: true, query: '' });
  };

  close = () => {
    this.setState({ activeIndex: 0, open: false, query: '' });
  };

  select = (plane) => {
    if (plane?.disabled) return;
    this.props.onChange(plane ? String(plane.instanceId) : '');
    this.close();
  };

  onKeyDown = (event) => {
    const matches = this.matches();
    if (event.key === 'Escape') {
      this.close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      this.setState((state) => ({
        activeIndex: Math.max(0, Math.min(matches.length - 1, state.activeIndex + offset)),
        open: true,
      }));
      return;
    }
    if (event.key === 'Enter' && this.state.open && matches.length) {
      event.preventDefault();
      this.select(matches[this.state.activeIndex]);
    }
  };

  choices() {
    return buildEquipmentChoices(
      this.props.equipment,
      this.props.plane,
      this.props.equipmentFilters,
    );
  }

  matches() {
    return rankEquipmentMatches(this.choices(), this.state.query)
      .slice(0, MAX_VISIBLE_RESULTS);
  }

  render() {
    const { plane, t, styles } = this.props;
    const allChoices = this.choices();
    const matches = this.matches();
    const selectedBlocked = allChoices.find((choice) => choice.current)?.disabled === true;
    const closedValue = plane
      ? `${formatEquipmentIdentity(plane)}${this.props.formatSuffix?.(plane) || ''}${selectedBlocked ? ` (${t('blacklistedCurrent')})` : ''}`
      : '';
    return h(
      'div',
      {
        style: styles.equipmentPicker,
        onBlur: (event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) this.close();
        },
      },
      h(
        'div',
        { style: styles.equipmentPickerControl },
        h('input', {
          role: 'combobox',
          'aria-autocomplete': 'list',
          'aria-expanded': this.state.open,
          'aria-label': t('equipment'),
          placeholder: t('searchAircraft'),
          value: this.state.open ? this.state.query : closedValue,
          onFocus: this.open,
          onChange: (event) => this.setState({
            activeIndex: 0,
            open: true,
            query: event.currentTarget.value,
          }),
          onKeyDown: this.onKeyDown,
          style: {
            ...styles.equipmentPickerInput,
            ...(selectedBlocked ? styles.blacklistedSelection : {}),
          },
        }),
        plane ? h('button', {
          type: 'button',
          title: t('emptySlot'),
          'aria-label': t('emptySlot'),
          onClick: () => this.select(null),
          style: styles.equipmentPickerClear,
        }, '×') : null,
      ),
      this.state.open
        ? h(
            'div',
            { role: 'listbox', style: styles.equipmentPickerMenu },
            matches.length
              ? renderMatches(
                  matches,
                  this.state.activeIndex,
                  this.select,
                  styles,
                  t,
                  this.props.formatSuffix,
                )
              : h('div', { style: styles.equipmentPickerEmpty }, t('noMatchingEquipment')),
            allChoices.length > matches.length
              ? h(
                  'div',
                  { style: styles.equipmentPickerMeta },
                  `${t('visibleResults')} ${matches.length} / ${allChoices.length}`,
                )
              : null,
          )
        : null,
    );
  }
}

function renderMatches(matches, activeIndex, onSelect, styles, t, formatSuffix) {
  const nodes = [];
  let previousType = null;
  matches.forEach((plane, index) => {
    if (plane.equipType !== previousType) {
      previousType = plane.equipType;
      nodes.push(h(
        'div',
        { key: `type-${plane.equipType}`, style: styles.equipmentPickerGroup },
        plane.typeName,
      ));
    }
    nodes.push(h(
      'button',
      {
        key: String(plane.instanceId),
        type: 'button',
        role: 'option',
        disabled: plane.disabled,
        'aria-selected': index === activeIndex,
        title: plane.disabled
          ? t('blacklistedCurrent')
          : `${formatEquipmentIdentity(plane)}${formatSuffix?.(plane) || ''}`,
        onMouseDown: (event) => event.preventDefault(),
        onClick: () => onSelect(plane),
        style: {
          ...styles.equipmentPickerOption,
          ...(index === activeIndex ? styles.equipmentPickerOptionActive : {}),
          ...(plane.disabled ? styles.blacklistedSelection : {}),
        },
      },
      h('span', { style: styles.equipmentPickerType }, plane.typeName),
      h('span', null, `${formatEquipmentIdentity(plane)}${formatSuffix?.(plane) || ''}`),
    ));
  });
  return nodes;
}

function formatEquipmentIdentity(plane) {
  const improvement = Number(plane.improvement) > 0 ? ` +${Number(plane.improvement)}` : '';
  const proficiency = Number.isFinite(Number(plane.proficiency))
    ? ` 熟练${Number(plane.proficiency)}`
    : '';
  return `${plane.name}${improvement}${proficiency} #${plane.instanceId}`;
}

module.exports = EquipmentPicker;
module.exports.formatEquipmentIdentity = formatEquipmentIdentity;
