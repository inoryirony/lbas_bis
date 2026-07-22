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
  test('returns a valid cache immediately when cache preference is requested', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbas-map-cache-'));
    temporaryPaths.push(cacheDir);
    const record = {
      fetchedAt: 1000,
      cells: { patterns: [{ a: 65, n: 'M', e: [] }] },
      master: { maps: [], worlds: [], enemies: [], items: [] },
    };
    await fs.writeFile(
      path.join(cacheDir, 'noro6-map-data.json'),
      JSON.stringify(record),
      'utf8',
    );
    let fetchCalls = 0;

    const cached = await loadMapData({
      cacheDir,
      now: () => 2500,
      preferCache: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('remote refresh should be skipped');
      },
    });

    expect(fetchCalls).toBe(0);
    expect(cached).toMatchObject({
      source: 'cache',
      fetchedAt: 1000,
      sourceAgeMs: 1500,
      cells: record.cells,
      master: record.master,
    });
  });

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
