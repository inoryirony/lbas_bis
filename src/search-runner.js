'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { Worker: NodeWorker } = require('worker_threads');

/** @param {{WorkerClass?: any, BrowserWorkerClass?: any, SharedArrayBufferClass?: any, preferBrowserWorker?: boolean, workerPath?: string}} [options] */
function createSearchRunner(options = {}) {
  const workerPath = options.workerPath || path.join(__dirname, 'optimizer-worker.js');
  const BrowserWorkerClass = options.BrowserWorkerClass || globalThis.Worker;
  const preferBrowserWorker = options.preferBrowserWorker ?? (
    Boolean(BrowserWorkerClass) && process?.versions?.electron &&
    /** @type {any} */ (process).type === 'renderer'
  );
  const WorkerClass = preferBrowserWorker
    ? BrowserWorkerClass
    : options.WorkerClass || NodeWorker;
  const SharedArrayBufferClass = Object.hasOwn(options, 'SharedArrayBufferClass')
    ? options.SharedArrayBufferClass
    : globalThis.SharedArrayBuffer;
  let worker = null;
  let sequence = 0;
  let active = null;
  let disposed = false;

  function ensureWorker() {
    if (worker) return worker;
    const createdWorker = preferBrowserWorker
      ? new WorkerClass(pathToFileURL(workerPath).href)
      : new WorkerClass(workerPath);
    worker = createdWorker;
    addWorkerListener(createdWorker, 'message', (message) => {
      if (createdWorker !== worker || disposed || !active ||
          message?.requestId !== active.requestId) return;
      if (message.event?.type === 'incumbent') active.incumbent = message.event.plan;
      if (message.event?.type === 'progress') active.progress = message.event;
      active.onEvent(message.event);
      if (['completed', 'cancelled', 'failed'].includes(message.event?.type)) {
        active = null;
      }
    }, preferBrowserWorker);
    addWorkerListener(createdWorker, 'error', (error) => {
      if (createdWorker !== worker) return;
      failActive(error);
      terminateWorker(createdWorker);
    }, preferBrowserWorker);
    if (!preferBrowserWorker) {
      addWorkerListener(createdWorker, 'exit', (code) => {
        if (createdWorker !== worker) return;
        worker = null;
        if (!disposed && active) {
          failActive(new Error(`Search worker exited before completion (code ${code}).`));
        }
      }, false);
    }
    return createdWorker;
  }

  function failActive(error) {
    if (!active || disposed) return;
    const normalized = normalizeWorkerError(error);
    active.onEvent({ type: 'failed', error: normalized });
    active = null;
  }

  return {
    start(options, onEvent) {
      if (disposed) throw new Error('Search runner has been disposed.');
      if (active?.cancellationBuffer) {
        cancelSharedSearch(worker, active);
      } else if (active) {
        active = null;
        terminateWorker(worker);
      }
      const requestId = `search-${Date.now()}-${sequence += 1}`;
      const cancellationBuffer = SharedArrayBufferClass
        ? new SharedArrayBufferClass(Int32Array.BYTES_PER_ELEMENT)
        : null;
      active = { requestId, cancellationBuffer, onEvent, incumbent: null, progress: null };
      const message = {
        type: 'start',
        requestId,
        options,
      };
      if (cancellationBuffer) message.cancellationBuffer = cancellationBuffer;
      try {
        ensureWorker().postMessage(message);
      } catch (error) {
        failActive(error);
      }
      return requestId;
    },

    cancel() {
      if (!active || disposed) return false;
      if (active.cancellationBuffer) {
        cancelSharedSearch(worker, active);
      } else {
        const cancelled = active;
        active = null;
        terminateWorker(worker);
        cancelled.onEvent(cancelledEvent(cancelled));
      }
      return true;
    },

    dispose() {
      if (disposed) return;
      if (active?.cancellationBuffer) cancelSharedSearch(worker, active);
      disposed = true;
      active = null;
      terminateWorker(worker);
    },
  };

  function terminateWorker(target) {
    if (!target) return;
    if (target === worker) worker = null;
    target.terminate();
  }
}

function addWorkerListener(worker, type, callback, browserWorker) {
  if (browserWorker) {
    worker.addEventListener(type, (event) => callback(type === 'message' ? event.data : event));
    return;
  }
  worker.on(type, callback);
}

function normalizeWorkerError(error) {
  const source = error?.error || error || {};
  return {
    name: source.name || 'Error',
    message: source.message || error?.message || 'Search worker failed.',
    stack: source.stack || '',
  };
}

function cancelSharedSearch(worker, active) {
  Atomics.store(new Int32Array(active.cancellationBuffer), 0, 1);
  worker.postMessage({ type: 'cancel', requestId: active.requestId });
}

function cancelledEvent(active) {
  const progress = active.progress || {};
  return {
    type: 'cancelled',
    result: {
      messages: ['Search cancelled; the current best plan is preserved but is not proven optimal.'],
      results: active.incumbent ? [active.incumbent] : [],
      search: {
        status: 'cancelled',
        provenOptimal: false,
        nodesExplored: progress.nodesExplored || 0,
        nodesPruned: progress.nodesPruned || 0,
        candidatesEvaluated: progress.candidatesEvaluated || 0,
        simulationSamplesEvaluated: progress.simulationSamplesEvaluated || 0,
      },
    },
  };
}

module.exports = { createSearchRunner };
