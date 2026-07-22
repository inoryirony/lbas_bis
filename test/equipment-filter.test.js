import { describe, expect, test } from 'vitest';
import equipmentFilter from '../src/equipment-filter.js';

const {
  buildEquipmentChoices,
  defaultBlacklistedMasterIds,
  filterOptimizationEquipment,
  rankEquipmentMatches,
  sortEquipmentChoices,
} = equipmentFilter;

describe('equipment candidate filters', () => {
  test('sorts by equipment type and name and searches case, width, simplified Chinese, and fuzzy subsequences', () => {
    const equipment = [
      plane('fighter-z', 103, 48, { name: 'Zulu Fighter' }),
      plane('egusa', 102, 47, { name: '銀河(江草隊)' }),
      plane('attacker-a', 101, 47, { name: 'Alpha Attacker' }),
    ];

    expect(sortEquipmentChoices(equipment).map((item) => item.instanceId)).toEqual([
      'attacker-a',
      'egusa',
      'fighter-z',
    ]);
    expect(rankEquipmentMatches(equipment, '银河江草').map((item) => item.instanceId))
      .toEqual(['egusa']);
    expect(rankEquipmentMatches(equipment, 'ＡＬＰＨＡ').map((item) => item.instanceId))
      .toEqual(['attacker-a']);
    expect(rankEquipmentMatches(equipment, '銀江').map((item) => item.instanceId))
      .toEqual(['egusa']);
  });

  test('keeps a current blacklisted plane visible but disables it for future selection', () => {
    const allowed = plane('allowed', 101, 47, { name: 'Allowed' });
    const blacklisted = plane('blocked', 102, 47, { name: 'Blocked' });
    const choices = buildEquipmentChoices([allowed, blacklisted], blacklisted, {
      blacklistedMasterIds: [102],
      blacklistedEquipTypes: [],
    });

    expect(choices).toEqual([
      expect.objectContaining({ instanceId: 'allowed', disabled: false }),
      expect.objectContaining({ instanceId: 'blocked', disabled: true, current: true }),
    ]);
  });

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

  test('excludes a selected equipment type while preserving locked instances of that type', () => {
    const equipment = [
      plane('ordinary-carrier', 13, 6),
      plane('locked-carrier', 14, 6),
      plane('land-attacker', 15, 47, { isLandBased: true }),
    ];

    expect(filterOptimizationEquipment(equipment, {
      blacklistedEquipTypes: [6],
      lockedInstanceIds: ['locked-carrier'],
    }).map((item) => item.instanceId)).toEqual([
      'locked-carrier',
      'land-attacker',
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
