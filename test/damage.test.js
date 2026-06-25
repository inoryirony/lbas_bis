import { describe, expect, test } from 'vitest';
import damage from '../src/damage.js';

const { calculateBaseDamagePower, calculatePlaneDamagePower } = damage;

describe('LBAS damage estimates', () => {
  test('calculates anti-ship attack power for a land-based attacker', () => {
    const power = calculatePlaneDamagePower(
      plane('ginga', {
        role: 'attacker',
        isLandBased: true,
        torpedo: 14,
        bombing: 14,
      }),
    );

    expect(power).toBe(149);
  });

  test('applies Type 2 land-based recon damage modifier to attacker power', () => {
    const power = calculateBaseDamagePower([
      plane('ginga', {
        role: 'attacker',
        isLandBased: true,
        torpedo: 14,
        bombing: 14,
      }),
      plane('recon', {
        masterId: 311,
        role: 'recon',
        isLandBased: true,
      }),
    ]);

    expect(power).toBe(168);
  });

  test('uses the stronger anti-ship stat when torpedo and bombing differ', () => {
    const torpedoStrong = calculatePlaneDamagePower(plane('torpedo-strong', {
      role: 'attacker',
      isLandBased: true,
      torpedo: 14,
      bombing: 10,
    }));
    const bombingStrong = calculatePlaneDamagePower(plane('bombing-strong', {
      role: 'attacker',
      isLandBased: true,
      torpedo: 10,
      bombing: 14,
    }));

    expect(bombingStrong).toBe(torpedoStrong);
  });
});

function plane(instanceId, overrides = {}) {
  return {
    instanceId,
    masterId: Number(String(instanceId).replace(/\D/g, '')) || 1,
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
    isLandBased: false,
    ...overrides,
  };
}
