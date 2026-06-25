import { describe, expect, test } from 'vitest';
import poiData from '../src/poi-data.js';

const { extractOwnedPlanes } = poiData;

describe('Poi data adapter', () => {
  test('maps Poi master and owned equipment data into optimizer plane instances', () => {
    const planes = extractOwnedPlanes({
      const: {
        $equips: {
          225: {
            api_id: 225,
            api_name: 'Hayabusa 64',
            api_tyku: 11,
            api_houk: 5,
            api_bakk: 0,
            api_distance: 7,
            api_raig: 0,
            api_baku: 0,
          },
          187: {
            api_id: 187,
            api_name: 'Ginga',
            api_tyku: 3,
            api_houk: 0,
            api_bakk: 0,
            api_distance: 9,
            api_raig: 14,
            api_baku: 14,
          },
        },
      },
      info: {
        equips: {
          1001: {
            api_id: 1001,
            api_slotitem_id: 225,
            api_level: 4,
            api_alv: 7,
          },
          1002: {
            api_id: 1002,
            api_slotitem_id: 187,
            api_level: 0,
            api_alv: 3,
          },
        },
      },
    });

    expect(planes).toEqual([
      expect.objectContaining({
        instanceId: 1001,
        masterId: 225,
        name: 'Hayabusa 64',
        antiAir: 11,
        intercept: 5,
        radius: 7,
        improvement: 4,
        proficiency: 7,
        role: 'fighter',
      }),
      expect.objectContaining({
        instanceId: 1002,
        masterId: 187,
        name: 'Ginga',
        antiAir: 3,
        radius: 9,
        torpedo: 14,
        bombing: 14,
        role: 'attacker',
      }),
    ]);
  });

  test('keeps pure range extenders even when they have no air power stat', () => {
    const planes = extractOwnedPlanes({
      const: {
        $equips: {
          138: {
            api_id: 138,
            api_name: 'Type 2 Flying Boat',
            api_tyku: 0,
            api_houk: 0,
            api_bakk: 0,
            api_distance: 20,
            api_raig: 0,
            api_baku: 0,
          },
        },
      },
      info: {
        equips: {
          2001: {
            api_id: 2001,
            api_slotitem_id: 138,
            api_level: 0,
            api_alv: 0,
          },
        },
      },
    });

    expect(planes).toEqual([
      expect.objectContaining({
        instanceId: 2001,
        masterId: 138,
        role: 'recon',
        radius: 20,
      }),
    ]);
  });
});
