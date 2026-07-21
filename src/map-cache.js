'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const CELLS_URL = 'https://firebasestorage.googleapis.com/v0/b/development-74af0.appspot.com/o/cells.json?alt=media';
const MASTER_URL = 'https://firebasestorage.googleapis.com/v0/b/development-74af0.appspot.com/o/master.json?alt=media';

async function loadMapData(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const cacheDir = options.cacheDir || defaultCacheDir();
  const cachePath = path.join(cacheDir, 'noro6-map-data.json');
  try {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    const [cells, master] = await Promise.all([
      fetchJson(fetchImpl, CELLS_URL),
      fetchJson(fetchImpl, MASTER_URL),
    ]);
    validateMapData(cells, master);
    const record = { fetchedAt: now(), cells, master };
    await writeCacheAtomically(cacheDir, cachePath, record);
    return { ...record, source: 'remote', sourceAgeMs: 0 };
  } catch (remoteError) {
    try {
      const record = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      validateMapData(record.cells, record.master);
      return {
        ...record,
        source: 'cache',
        sourceAgeMs: Math.max(0, now() - Number(record.fetchedAt || 0)),
        refreshError: remoteError.message,
      };
    } catch (cacheError) {
      throw new Error(`Unable to load map data: ${remoteError.message}; cache: ${cacheError.message}`);
    }
  }
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'} for ${url}`);
  return response.json();
}

function validateMapData(cells, master) {
  if (!Array.isArray(cells?.patterns)) throw new TypeError('cells.patterns must be an array.');
  for (const key of ['maps', 'worlds', 'enemies', 'items']) {
    if (!Array.isArray(master?.[key])) throw new TypeError(`master.${key} must be an array.`);
  }
}

async function writeCacheAtomically(cacheDir, cachePath, record) {
  await fs.mkdir(cacheDir, { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(record), 'utf8');
  await fs.rename(temporaryPath, cachePath);
}

function defaultCacheDir() {
  return path.join(process.env.APPDATA || os.homedir(), 'poi', 'lbas-bis');
}

module.exports = {
  CELLS_URL,
  MASTER_URL,
  loadMapData,
  validateMapData,
};
