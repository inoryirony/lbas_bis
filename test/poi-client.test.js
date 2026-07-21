import http from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import clientModule from '../src/poi-client.js';

const { createPoiClient } = clientModule;
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('Poi HTTP client', () => {
  test('loads health, owned equipment, and master data into a Poi state shape', async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/health') response.end(JSON.stringify({ status: 'ok' }));
      else if (request.url === '/equipment') response.end(JSON.stringify({ 1001: { api_id: 1001, api_slotitem_id: 225 } }));
      else if (request.url === '/master') response.end(JSON.stringify({
        ships: { 1764: { api_id: 1764, api_name: 'Enemy' } },
        equipment: { 225: { api_id: 225, api_name: 'Fighter' } },
        shipTypes: {},
      }));
      else response.writeHead(404).end('{}');
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address');
    const { port } = address;

    const state = await createPoiClient(`http://127.0.0.1:${port}`).loadState();

    expect(requests).toEqual(['/health', '/equipment', '/master']);
    expect(state).toMatchObject({
      info: { equips: { 1001: { api_slotitem_id: 225 } } },
      const: {
        $ships: { 1764: { api_name: 'Enemy' } },
        $equips: { 225: { api_name: 'Fighter' } },
      },
    });
  });
});
