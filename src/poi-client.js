'use strict';

function createPoiClient(baseUrl = 'http://127.0.0.1:17777', options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 5000);
  const base = String(baseUrl).replace(/\/+$/, '');

  return {
    async loadState() {
      const health = await getJson('/health');
      if (health?.status !== 'ok') throw new Error('Poi bridge health check failed.');
      const equipment = await getJson('/equipment');
      const master = await getJson('/master');
      if (!equipment || typeof equipment !== 'object') throw new TypeError('Poi equipment payload is invalid.');
      if (!master || typeof master !== 'object') throw new TypeError('Poi master payload is invalid.');
      return {
        info: { equips: equipment },
        const: {
          $ships: master.ships || {},
          $equips: master.equipment || {},
          $shipTypes: master.shipTypes || {},
          $equipTypes: master.equipmentTypes || {},
        },
      };
    },
  };

  async function getJson(pathname) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${pathname}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Poi bridge ${pathname} returned HTTP ${response.status}.`);
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { createPoiClient };
