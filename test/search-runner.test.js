import { describe, expect, test, vi } from 'vitest';
import runnerModule from '../src/search-runner.js';

const { createSearchRunner } = runnerModule;

describe('worker search runner', () => {
  test('ignores stale events, cancels atomically, and disposes the worker', () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      on(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(message) {
        this.listeners.get('message')?.(message);
      }
    }

    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const runner = createSearchRunner({ WorkerClass: FakeWorker });
    const firstId = runner.start({ marker: 'first' }, onFirst);
    const secondId = runner.start({ marker: 'second' }, onSecond);
    const worker = workers[0];

    worker.emit({ requestId: firstId, event: { type: 'progress' } });
    worker.emit({ requestId: secondId, event: { type: 'incumbent' } });
    runner.cancel();

    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledWith({ type: 'incumbent' });
    const start = worker.messages.find((message) => message.requestId === secondId && message.type === 'start');
    expect(Atomics.load(new Int32Array(start.cancellationBuffer), 0)).toBe(1);
    expect(worker.messages.at(-1)).toMatchObject({ type: 'cancel', requestId: secondId });

    runner.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  test('streams a completed result from the real worker', async () => {
    const runner = createSearchRunner();
    const events = [];
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('worker search timed out')), 10000);
        runner.start(lockedStaticScenario(), (event) => {
          events.push(event);
          if (event.type === 'completed' || event.type === 'failed') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    } finally {
      runner.dispose();
    }

    expect(events[0]).toMatchObject({ type: 'started' });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      result: { search: { status: 'optimal', provenOptimal: true } },
    });
  });

  test('uses the Electron Web Worker event interface when available', () => {
    const workers = [];
    class FakeWebWorker {
      constructor(url) {
        this.url = url;
        this.messages = [];
        this.listeners = new Map();
        this.terminate = vi.fn();
        workers.push(this);
      }

      addEventListener(type, callback) {
        this.listeners.set(type, callback);
      }

      postMessage(message) {
        this.messages.push(message);
      }

      emit(type, data) {
        this.listeners.get(type)?.(type === 'message' ? { data } : data);
      }
    }

    const onEvent = vi.fn();
    const runner = createSearchRunner({
      BrowserWorkerClass: FakeWebWorker,
      preferBrowserWorker: true,
      SharedArrayBufferClass: null,
      workerPath: 'C:\\plugin\\src\\optimizer-worker.js',
    });
    const requestId = runner.start({ marker: 'electron' }, onEvent);
    const worker = workers[0];

    expect(worker.url).toMatch(/^file:/);
    expect(worker.messages[0]).not.toHaveProperty('cancellationBuffer');
    worker.emit('message', { requestId, event: { type: 'started' } });
    expect(onEvent).toHaveBeenCalledWith({ type: 'started' });

    expect(runner.cancel()).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cancelled',
      result: expect.objectContaining({
        search: expect.objectContaining({ status: 'cancelled', provenOptimal: false }),
      }),
    }));

    runner.start({ marker: 'second-electron-search' }, vi.fn());
    expect(workers).toHaveLength(2);

    runner.dispose();
    expect(workers[1].terminate).toHaveBeenCalledOnce();
  });
});

function lockedStaticScenario() {
  const fighter = {
    instanceId: 'worker-fighter',
    masterId: 1,
    name: 'worker fighter',
    equipType: 48,
    antiAir: 12,
    radius: 7,
    improvement: 0,
    proficiency: 0,
    isPlane: true,
    isFighter: true,
    isLandBased: true,
    role: 'fighter',
  };
  return {
    equipment: [fighter],
    baseCount: 1,
    targetRadius: 7,
    enemyAir: 20,
    targetStates: ['parity', 'parity'],
    lockedBases: [{ slots: [
      { plane: fighter, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
      { plane: null, locked: true },
    ] }],
    nodeBudget: Infinity,
    maxResults: 1,
  };
}
