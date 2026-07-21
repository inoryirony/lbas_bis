'use strict';

const { parentPort } = require('worker_threads');
const { runSearchSession } = require('./search-session');

const cancellationViews = new Map();
const postMessage = parentPort
  ? (message) => parentPort.postMessage(message)
  : (message) => globalThis.postMessage(message);
const subscribe = parentPort
  ? (handler) => parentPort.on('message', handler)
  : (handler) => globalThis.addEventListener('message', (event) => handler(event.data));

subscribe((message) => {
  if (message?.type === 'cancel') {
    const view = cancellationViews.get(message.requestId);
    if (view) Atomics.store(view, 0, 1);
    return;
  }
  if (message?.type !== 'start') return;

  const { requestId, options, cancellationBuffer } = message;
  const cancellationView = cancellationBuffer ? new Int32Array(cancellationBuffer) : null;
  if (cancellationView) cancellationViews.set(requestId, cancellationView);
  try {
    runSearchSession({
      ...options,
      isCancelled: () => cancellationView ? Atomics.load(cancellationView, 0) === 1 : false,
      onEvent: (event) => postMessage({ requestId, event }),
    });
  } catch (error) {
    postMessage({
      requestId,
      event: {
        type: 'failed',
        error: {
          name: error?.name || 'Error',
          message: error?.message || String(error),
          stack: error?.stack || '',
        },
      },
    });
  } finally {
    if (cancellationView) cancellationViews.delete(requestId);
  }
});
