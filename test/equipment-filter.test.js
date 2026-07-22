import { describe, expect, test } from 'vitest';
import equipmentFilter from '../src/equipment-filter.js';

const {
  defaultBlacklistedMasterIds,
  filterOptimizationEquipment,
} = equipmentFilter;

describe('equipment candidate filters', () => {
  test('excludes carrier aircraft without excluding seaplanes or land aircraft', () => {
    const equipment = [
      plane('carrier-fighter', 1, 6),
      plane('carrier-recon', 2, 9),
      plane('seaplane-recon', 3, 10),
      plane('seaplane-fighter', 5, 45),
      plane('land-attacker', 4, 47, { isLandBased: true }),
    ];

    expect(filterOptimizationEquipment(equipment, { excludeCarrierAircraft: true })
      .map((item) => item.instanceId)).toEqual([
        'seaplane-recon',
        'seaplane-fighter',
        'land-attacker',
      ]);
  });

  test('keeps manually locked equipment even when another filter excludes it', () => {
    const equipment = [
      plane('locked-carrier', 10, 6),
      plane('blacklisted-land', 11, 47, { isLandBased: true }),
      plane('ordinary-land', 12, 47, { isLandBased: true }),
    ];

    expect(filterOptimizationEquipment(equipment, {
      excludeCarrierAircraft: true,
      blacklistedMasterIds: [11],
      lockedInstanceIds: ['locked-carrier', 'blacklisted-land'],
    }).map((item) => item.instanceId)).toEqual([
      'locked-carrier',
      'blacklisted-land',
      'ordinary-land',
    ]);
  });

  test('preselects only exact low-grade names in the editable default blacklist', () => {
    const equipment = [
      plane('basic', 20, 6, { name: '九六式艦戦' }),
      plane('skilled', 21, 6, { name: '零式艦戦21型(熟練)' }),
      plane('land-basic', 22, 47, { name: '九六式陸攻', isLandBased: true }),
    ];

    expect(defaultBlacklistedMasterIds(equipment)).toEqual([20, 22]);
  });
});

function plane(instanceId, masterId, equipType, overrides = {}) {
  return {
    instanceId,
    masterId,
    equipType,
    name: instanceId,
    isPlane: true,
    isLandBased: false,
    ...overrides,
  };
}
