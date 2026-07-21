import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import cacheModule from '../src/map-cache.js';

const { loadMapData } = cacheModule;
const temporaryPaths = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((target) =>
    fs.rm(target, { recursive: true, force: true })));
});

describe('map data cache', () => {
  test('caches valid remote data and falls back to it when refresh fails', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbas-map-cache-'));
    temporaryPaths.push(cacheDir);
    const payloads = [
      { patterns: [{ a: 64, n: 'N', e: [] }] },
      { maps: [], worlds: [], enemies: [], items: [] },
    ];
    let call = 0;
    const fresh = await loadMapData({
      cacheDir,
      now: () => 1000,
      fetchImpl: async () => ({ ok: true, json: async () => payloads[call++] }),
    });
    const cached = await loadMapData({
      cacheDir,
      now: () => 2500,
      fetchImpl: async () => { throw new Error('offline'); },
    });

    expect(fresh).toMatchObject({ source: 'remote', fetchedAt: 1000 });
    expect(cached).toMatchObject({
      source: 'cache',
      fetchedAt: 1000,
      sourceAgeMs: 1500,
      cells: payloads[0],
      master: payloads[1],
    });
  });
});
