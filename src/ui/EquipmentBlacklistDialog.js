'use strict';

const React = require('react');

const h = React.createElement;

function EquipmentBlacklistDialog(props) {
  const {
    open,
    equipment,
    selectedMasterIds,
    query,
    onQueryChange,
    onToggle,
    onResetDefaults,
    onClear,
    onClose,
    t,
    styles,
  } = props;
  if (!open) return null;

  const selected = new Set((selectedMasterIds || []).map(Number));
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  const visible = (equipment || []).filter((item) =>
    !normalizedQuery ||
    item.name.toLocaleLowerCase().includes(normalizedQuery) ||
    String(item.masterId).includes(normalizedQuery));

  return h(
    'div',
    { style: styles.modalBackdrop, onMouseDown: onClose },
    h(
      'section',
      {
        role: 'dialog',
        'aria-modal': true,
        'aria-label': t('equipmentBlacklist'),
        style: styles.modalDialog,
        onMouseDown: (event) => event.stopPropagation(),
      },
      h(
        'header',
        { style: styles.modalHeader },
        h('strong', null, `${t('equipmentBlacklist')} (${selected.size})`),
        h('button', {
          type: 'button',
          title: t('close'),
          'aria-label': t('close'),
          onClick: onClose,
          style: styles.iconButton,
        }, '×'),
      ),
      h(
        'div',
        { style: styles.blacklistToolbar },
        h('input', {
          type: 'search',
          value: query || '',
          placeholder: t('searchEquipment'),
          'aria-label': t('searchEquipment'),
          onChange: (event) => onQueryChange(event.target.value),
          style: styles.searchInput,
        }),
        h('button', { type: 'button', onClick: onResetDefaults, style: styles.button }, t('restoreDefaults')),
        h('button', { type: 'button', onClick: onClear, style: styles.button }, t('clearBlacklist')),
      ),
      h(
        'div',
        { style: styles.blacklistList },
        visible.length
          ? visible.map((item) => h(
            'label',
            { key: item.masterId, style: styles.blacklistItem },
            h('input', {
              type: 'checkbox',
              checked: selected.has(item.masterId),
              onChange: (event) => onToggle(item.masterId, event.target.checked),
            }),
            h('span', null, item.name),
            h('span', { style: styles.meta }, `#${item.masterId}`),
          ))
          : h('div', { style: styles.emptyCell }, t('noMatchingEquipment')),
      ),
    ),
  );
}

module.exports = EquipmentBlacklistDialog;
