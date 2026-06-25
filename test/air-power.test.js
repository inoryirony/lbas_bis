import { describe, expect, test } from 'vitest';
import airPower from '../src/air-power.js';

const {
  airStateFor,
  calculateBaseAirPower,
  calculateEffectiveRadius,
  calculateSlotAirPower,
} = airPower;

describe('LBAS air power formulas', () => {
  test('classifies air states from KanColle threshold borders', () => {
    expect(airStateFor(108, 36).key).toBe('supremacy');
    expect(airStateFor(54, 36).key).toBe('superiority');
    expect(airStateFor(25, 36).key).toBe('parity');
    expect(airStateFor(13, 36).key).toBe('denial');
    expect(airStateFor(12, 36).key).toBe('loss');
  });

  test('uses sortie intercept, improvement, and proficiency for one LBAS slot', () => {
    const airPowerValue = calculateSlotAirPower({
      antiAir: 11,
      intercept: 5,
      improvement: 4,
      proficiency: 7,
      role: 'fighter',
      slotSize: 18,
    });

    expect(airPowerValue).toBe(107);
  });

  test('counts max internal proficiency bonus for land-based attackers', () => {
    const ginga = {
      antiAir: 3,
      intercept: 0,
      improvement: 0,
      proficiency: 7,
      role: 'attacker',
      slotSize: 18,
    };

    expect(calculateSlotAirPower(ginga)).toBe(16);
    expect(calculateBaseAirPower([ginga, ginga, ginga, ginga])).toBe(64);
    expect(airStateFor(calculateBaseAirPower([ginga, ginga, ginga, ginga]), 72).key).toBe('parity');
  });

  test('uses four planes for land recon slots when calculating air power', () => {
    const recon = {
      masterId: 311,
      antiAir: 3,
      intercept: 0,
      improvement: 0,
      proficiency: 0,
      role: 'recon',
    };

    expect(calculateSlotAirPower(recon)).toBe(6);
    expect(calculateBaseAirPower([recon])).toBe(6);
  });

  test('applies land recon coefficient and range extension to a base loadout', () => {
    const loadout = [
      plane('fighter-1', { antiAir: 10, radius: 4, role: 'fighter' }),
      plane('fighter-2', { antiAir: 10, radius: 4, role: 'fighter' }),
      plane('attacker-1', { antiAir: 3, radius: 8, role: 'attacker' }),
      plane('recon', {
        masterId: 311,
        antiAir: 3,
        radius: 8,
        role: 'recon',
      }),
    ];

    expect(calculateEffectiveRadius(loadout)).toBe(6);
    expect(calculateBaseAirPower(loadout)).toBe(117);
  });
});

function plane(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: Number(instanceId.replace(/\D/g, '')) || 1,
    name: instanceId,
    antiAir: 0,
    intercept: 0,
    antiBomber: 0,
    radius: 0,
    improvement: 0,
    proficiency: 0,
    role: 'attacker',
    torpedo: 0,
    bombing: 0,
    ...overrides,
  };
}
