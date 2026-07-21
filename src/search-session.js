'use strict';

const { optimizeLoadouts } = require('./optimizer');
const {
  cancelledEvent,
  completedEvent,
  incumbentEvent,
  phaseChangedEvent,
  progressEvent,
  startedEvent,
} = require('./search-events');

function runSearchSession(options = {}) {
  const events = [];
  const emit = (event) => {
    events.push(event);
    options.onEvent?.(event);
  };
  emit(startedEvent());
  const result = optimizeLoadouts({
    ...options,
    onIncumbent(plan, search) {
      emit(incumbentEvent(plan, search));
      options.onIncumbent?.(plan, search);
    },
    onPhaseChange(phase) {
      emit(phaseChangedEvent(phase));
      options.onPhaseChange?.(phase);
    },
    onProgress(search) {
      emit(progressEvent(search));
      options.onProgress?.(search);
    },
  });
  emit(result.search.status === 'cancelled'
    ? cancelledEvent(result)
    : completedEvent(result));
  return { events, result };
}

module.exports = { runSearchSession };
