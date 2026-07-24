'use strict';

const React = require('react');
const { equipmentDamageMultiplier } = require('../combat-context');
const { shootDownAvoidanceLabelKey } = require('../enemy-stage2');
const EquipmentBlacklistDialog = require('./EquipmentBlacklistDialog');

const h = React.createElement;

function OptimizerPanel(props) {
  const {
    candidateMode,
    optimizerProficiencyMode,
    equipmentCount,
    theoreticalCount,
    messages,
    results,
    combatContext,
    search,
    isSearching,
    searchPhase,
    searchProgress,
    equipmentFilters,
    equipmentCatalog,
    equipmentBlacklistOpen,
    equipmentBlacklistQuery,
    onCandidateModeChange,
    onOptimizerProficiencyModeChange,
    onExcludeCarrierAircraftChange,
    onEquipmentBlacklistOpen,
    onEquipmentBlacklistClose,
    onEquipmentBlacklistQueryChange,
    onEquipmentBlacklistToggle,
    onEquipmentTypeBlacklistToggle,
    onEquipmentBlacklistReset,
    onEquipmentBlacklistClear,
    onOptimize,
    onCancel,
    onImportPlan,
    t,
    styles,
  } = props;

  return h(
    'section',
    { style: styles.optimizerPanel },
    h('h3', { style: styles.sectionTitle }, t('optimizerTitle')),
    h(
      'div',
      { style: styles.optimizerControls },
      h(
        'label',
        { style: styles.radioLabel },
        h('input', {
          type: 'radio',
          name: 'candidateMode',
          value: 'owned',
          checked: candidateMode !== 'theoretical',
          onChange: () => onCandidateModeChange('owned'),
        }),
        t('ownedOnly'),
      ),
      h(
        'label',
        { style: styles.radioLabel },
        h('input', {
          type: 'radio',
          name: 'candidateMode',
          value: 'theoretical',
          checked: candidateMode === 'theoretical',
          onChange: () => onCandidateModeChange('theoretical'),
        }),
        t('includeMissing'),
      ),
      h('span', { style: styles.meta }, t('optimizerProficiency')),
      h(
        'div',
        { role: 'group', 'aria-label': t('optimizerProficiency'), style: styles.segmentedControl },
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': optimizerProficiencyMode === 'lost',
              onClick: () => onOptimizerProficiencyModeChange('lost'),
              style: {
                ...styles.segmentButton,
                ...(optimizerProficiencyMode === 'lost' ? styles.segmentButtonActive : {}),
              },
            },
            t('proficiencyLost'),
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': optimizerProficiencyMode === 'inventory',
              onClick: () => onOptimizerProficiencyModeChange('inventory'),
              style: {
                ...styles.segmentButton,
                ...(optimizerProficiencyMode === 'inventory' ? styles.segmentButtonActive : {}),
              },
            },
            t('proficiencyInventory'),
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': optimizerProficiencyMode === 'max',
              onClick: () => onOptimizerProficiencyModeChange('max'),
              style: {
                ...styles.segmentButton,
                ...(optimizerProficiencyMode === 'max' ? styles.segmentButtonActive : {}),
              },
            },
            t('proficiencyMax'),
          ),
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: isSearching ? onCancel : onOptimize,
          style: styles.primaryButton,
        },
        t(isSearching ? 'cancel' : 'optimize'),
      ),
      h(
        'label',
        { style: styles.radioLabel },
        h('input', {
          type: 'checkbox',
          checked: equipmentFilters.excludeCarrierAircraft === true,
          onChange: (event) => onExcludeCarrierAircraftChange(event.target.checked),
        }),
        t('excludeCarrierAircraft'),
      ),
      h(
        'button',
        { type: 'button', onClick: onEquipmentBlacklistOpen, style: styles.button },
        `${t('equipmentBlacklist')} (${equipmentFilters.blacklistedMasterIds.length + equipmentFilters.blacklistedEquipTypes.length})`,
      ),
      h('span', { style: styles.meta }, `${t('availablePlanes')}: ${equipmentCount} / ${t('candidatePlanes')}: ${theoreticalCount}`),
    ),
    h(EquipmentBlacklistDialog, {
      open: equipmentBlacklistOpen,
      equipment: equipmentCatalog,
      selectedMasterIds: equipmentFilters.blacklistedMasterIds,
      selectedEquipTypes: equipmentFilters.blacklistedEquipTypes,
      query: equipmentBlacklistQuery,
      onQueryChange: onEquipmentBlacklistQueryChange,
      onToggle: onEquipmentBlacklistToggle,
      onTypeToggle: onEquipmentTypeBlacklistToggle,
      onResetDefaults: onEquipmentBlacklistReset,
      onClear: onEquipmentBlacklistClear,
      onClose: onEquipmentBlacklistClose,
      t,
      styles,
    }),
    isSearching
      ? h(SearchActivityClock, { phase: searchPhase, progress: searchProgress, results, t, styles })
      : renderSearch(search, t, styles),
    renderMessages(messages, styles),
    renderResults({ results, combatContext, onImportPlan, t, styles }),
  );
}

/** Owns the lightweight UI clock that keeps search activity visibly moving. */
class SearchActivityClock extends React.PureComponent {
  /** Creates a clock that starts from zero for each mounted search generation. */
  constructor(props) {
    super(props);
    this.state = { activityElapsedMs: 0 };
    this.activityTimer = null;
  }

  /** Starts a UI-only timer independent of solver progress snapshots. */
  componentDidMount() {
    this.activityTimer = setInterval(() => {
      this.setState((state) => ({ activityElapsedMs: state.activityElapsedMs + 100 }));
    }, 100);
  }

  /** Stops the activity timer when the search progress view is removed. */
  componentWillUnmount() {
    if (this.activityTimer != null) clearInterval(this.activityTimer);
    this.activityTimer = null;
  }

  /** Renders solver counters with the independent activity offset. */
  render() {
    const { phase, progress, results, t, styles } = this.props;
    return renderLiveSearch(
      phase,
      progress,
      results,
      t,
      styles,
      this.state.activityElapsedMs,
    );
  }
}

/** Renders live solver state while using a UI clock only for activity position. */
function renderLiveSearch(phase, progress = {}, results, t, styles, activityElapsedMs = 0) {
  const elapsedSeconds = Math.round((progress?.elapsedMs || 0) / 100) / 10;
  const displayedNodes = progress?.totalNodesExplored ?? progress?.nodesExplored ?? 0;
  const hasCountableWork = Number.isFinite(progress?.completedWork) &&
    Number.isFinite(progress?.totalWork) && progress.totalWork > 0;
  const completedWork = hasCountableWork
    ? Math.max(0, Math.min(progress.completedWork, progress.totalWork))
    : 0;
  const percentage = hasCountableWork
    ? completedWork === progress.totalWork
      ? 100
      : Math.floor(completedWork / progress.totalWork * 100)
    : null;
  const animationElapsedMs = (progress?.elapsedMs || 0) + activityElapsedMs;
  const indeterminatePosition = (animationElapsedMs / 50 % 560) - 100;
  const activityPosition = animationElapsedMs / 50 % 100;
  return h(
    'div',
    { style: styles.searchProgress || styles.searchMeta },
    h('strong', null, t(`phase_${phase || 'finding_feasible'}`)),
    h('span', null, `${t('currentBest')}: ${results.length ? t('plan') : t('waitingFeasible')}`),
    hasCountableWork
      ? h('span', null, `${completedWork} / ${progress.totalWork} (${percentage}%)`)
      : null,
    hasCountableWork
      ? h(
          'div',
          {
            role: 'progressbar',
            'aria-label': t(`phase_${phase || 'finding_feasible'}`),
            'aria-valuemin': 0,
            'aria-valuenow': completedWork,
            'aria-valuemax': progress.totalWork,
            'data-progress-mode': 'determinate',
            style: styles.progressTrack,
          },
          h('span', {
            'data-progress-role': 'fill',
            style: {
              ...styles.progressFill,
              width: `${completedWork / progress.totalWork * 100}%`,
            },
          }),
          h('span', {
            'data-progress-role': 'activity',
            style: {
              ...styles.progressActivity,
              left: `${activityPosition}%`,
            },
          }),
        )
      : h(
          'div',
          {
            role: 'progressbar',
            'aria-label': t(`phase_${phase || 'finding_feasible'}`),
            'aria-valuetext': t(`phase_${phase || 'finding_feasible'}`),
            'data-progress-mode': 'indeterminate',
            style: styles.progressTrack,
          },
          h('span', {
            style: {
              ...styles.progressPulse,
              transform: `translateX(${indeterminatePosition}%)`,
            },
          }),
        ),
    h(
      'span',
      null,
      `${t('searchNodes')} ${displayedNodes} / ${t('prunedNodes')} ${progress?.nodesPruned || 0} / ${t('completeCandidates')} ${progress?.candidatesEvaluated || 0} / ${t('simulationSamples')} ${progress?.simulationSamplesEvaluated || 0} / ${t('elapsedTime')} ${elapsedSeconds}s`,
    ),
  );
}

/** Renders exact-search completion and budget metadata. */
function renderSearch(search, t, styles) {
  if (!search) return null;
  const proofKey = search.optimalityScope === 'fixed_sample'
    ? search.provenOptimal ? 'fixedSampleOptimal' : 'fixedSampleNotProven'
    : search.provenOptimal ? 'provenOptimal' : 'notProvenOptimal';
  const proofText = format(t(proofKey), {
    count: search.evaluationSampleCount ?? '?',
  });
  return h(
    'div',
    { style: styles.searchMeta || styles.meta },
    h('strong', null, proofText),
    ` / ${t(`searchStatus_${search.status}`)} / ${t('searchNodes')} ${search.totalNodesExplored ?? search.nodesExplored ?? 0}`,
  );
}

function renderMessages(messages, styles) {
  if (!messages.length) {
    return null;
  }
  return h(
    'ul',
    { style: styles.messages },
    messages.map((message) => h('li', { key: message }, message)),
  );
}

function renderResults({ results, combatContext, onImportPlan, t, styles }) {
  if (!results.length) {
    return h(
      'table',
      { style: styles.table },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { style: styles.th }, t('plan')),
          h('th', { style: styles.th }, t('sixWaveState')),
          h('th', { style: styles.th }, t('damagePower')),
          h('th', { style: styles.th }, t('uniformMinimumProficiency')),
          h('th', { style: styles.th }, t('missingEquipment')),
          h('th', { style: styles.th }, t('importToSimulator')),
        ),
      ),
      h('tbody', null, h('tr', null, h('td', { colSpan: 6, style: styles.emptyCell }, t('noResult')))),
    );
  }

  return h(
    'div',
    { style: styles.results },
    results.map((plan, planIndex) =>
      h(
        'section',
        { key: `plan-${planIndex}`, style: styles.plan },
        h(
          'div',
          { style: styles.planHeader },
          h('strong', null, `${t('plan')} ${planIndex + 1}`),
          h('span', null, `${t('damagePower')} ${plan.attackPowerProxy ?? plan.totalDamagePower}`),
          h('span', null, `${t('worstMargin')} ${plan.worstMargin}`),
          h('span', null, t(plan.calculationMode === 'detailed' ? 'detailedSimulation' : 'staticEstimate')),
          h('button', { type: 'button', onClick: () => onImportPlan(plan), style: styles.button }, t('importToSimulator')),
        ),
        h('div', { style: styles.planSummary }, formatMissing(plan.missingEquipment, t)),
        h(
          'div',
          { style: styles.waves },
          plan.waves.map((wave) =>
            h(
              'span',
              { key: wave.waveIndex, style: styles.wave },
              formatWave(wave, t),
            ),
          ),
        ),
        ...plan.bases.flatMap((base, baseIndex) => [
          h(
            'div',
            { key: `base-meta-${baseIndex}`, style: styles.planSummary },
            `${format(t('base'), { index: baseIndex + 1 })} / ${t('uniformMinimumProficiency')} ${formatProficiency(base.minimumProficiency)}`,
          ),
          h(
            'ol',
            { key: `base-${baseIndex}`, style: styles.loadout },
            base.loadout.map((item, slotIndex) => item
              ? h(
                'li',
                {
                  key: item.instanceId ?? `slot-${slotIndex}`,
                  style: item.available === false ? styles.missingItem : null,
                },
                `${item.name}${formatAvoidance(item, t)}${formatMultiplier(item, combatContext)} · ${t('airPower')} ${item.antiAir} · ${t('radius')} ${item.radius}${item.missing || item.available === false ? ` · ${t('missing')}` : ''}`,
              )
              : h(
                'li',
                { key: `empty-${slotIndex}`, style: styles.emptyLoadoutItem || styles.meta },
                t('emptySlot'),
              ),
            ),
          ),
        ]),
      ),
    ),
  );
}

function formatAvoidance(item, t) {
  if (!item || item.isAttacker !== true) return '';
  return ` · ${t('shootDownAvoidance')} ${t(shootDownAvoidanceLabelKey(item.shootDownAvoidance))}`;
}

function formatMultiplier(plane, combatContext) {
  const multiplier = equipmentDamageMultiplier(plane, combatContext);
  if (Math.abs(multiplier - 1) < 1e-12) return '';
  return ` ×${Number(multiplier.toFixed(4))}`;
}

/** Formats static or Monte Carlo wave summaries without assuming one shape. */
function formatWave(wave, t) {
  const prefix = format(t('wave'), { index: wave.waveIndex + 1 });
  if (wave.state) {
    return `${prefix}: ${t(wave.state.key)} / ${t('targetState')} ${t(wave.targetState)} / ${t('airPower')} ${wave.airPower}`;
  }
  const probability = Math.round((wave.targetFulfillmentProbability || 0) * 1000) / 10;
  const interval = wave.targetFulfillmentConfidence95;
  const confidence = interval
    ? ` / ${t('confidence95')} ${formatProbability(interval.lower)}%-${formatProbability(interval.upper)}%`
    : '';
  return `${prefix}: ${t('targetFulfillment')} ${probability}%${confidence} / ${t('expectedAir')} ${Math.round(wave.expectedOwnAirBefore || 0)}`;
}

function formatProbability(value) {
  return Math.round((Number(value) || 0) * 1000) / 10;
}

/** Formats one uniform visible-proficiency level. */
function formatProficiency(level) {
  if (level == null) return '-';
  return ['-', '|', '||', '|||', '/', '//', '///', '>>'][level] || String(level);
}

function formatMissing(missingEquipment, t) {
  if (!missingEquipment || !missingEquipment.length) {
    return `${t('missingEquipment')}: -`;
  }
  return `${t('missingEquipment')}: ${missingEquipment.map((item) => `${item.name} x${item.count}`).join(', ')}`;
}

function format(template, values) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

module.exports = OptimizerPanel;
module.exports.SearchActivityClock = SearchActivityClock;
