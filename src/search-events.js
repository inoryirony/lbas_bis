'use strict';

const SEARCH_PHASES = Object.freeze({
  FINDING_FEASIBLE: 'finding_feasible',
  IMPROVING: 'improving',
  PROVING_OPTIMAL: 'proving_optimal',
});

function startedEvent() {
  return Object.freeze({
    type: 'started',
    phase: SEARCH_PHASES.FINDING_FEASIBLE,
  });
}

function completedEvent(result) {
  return Object.freeze({ type: 'completed', result });
}

function incumbentEvent(plan, search = {}) {
  return Object.freeze({
    type: 'incumbent',
    phase: search.phase || SEARCH_PHASES.IMPROVING,
    plan,
    nodesExplored: search.nodesExplored || 0,
    candidatesEvaluated: search.candidatesEvaluated || 0,
    simulationSamplesEvaluated: search.simulationSamplesEvaluated || 0,
  });
}

function phaseChangedEvent(phase) {
  return Object.freeze({ type: 'phase_changed', phase });
}

function progressEvent(state = {}) {
  return Object.freeze({
    type: 'progress',
    phase: state.phase,
    nodesExplored: state.nodesExplored || 0,
    nodesPruned: state.nodesPruned || 0,
    candidatesEvaluated: state.candidatesEvaluated || 0,
    simulationSamplesEvaluated: state.simulationSamplesEvaluated || 0,
    elapsedMs: state.elapsedMs || 0,
    completedWork: state.completedWork ?? null,
    totalWork: state.totalWork ?? null,
  });
}

function cancelledEvent(result) {
  return Object.freeze({ type: 'cancelled', result });
}

module.exports = {
  SEARCH_PHASES,
  cancelledEvent,
  completedEvent,
  incumbentEvent,
  phaseChangedEvent,
  progressEvent,
  startedEvent,
};
