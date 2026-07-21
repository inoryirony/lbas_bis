import { describe, expect, test } from 'vitest';
import enemySlots from '../src/enemy-slots.js';

const { validateAndNormalizeDetailedEnemySlots } = enemySlots;

describe('detailed enemy slot validation', () => {
  test('preserves catalog source metadata through normalization', () => {
    const result = validateAndNormalizeDetailedEnemySlots([{
      instanceId: 'catalog-slot',
      name: 'Enemy fighter',
      sortieAntiAir: 10,
      currentSlot: 32,
      maxSlot: 32,
      sourceShipIndex: 2,
      sourceSlotIndex: 1,
      equipmentMasterId: 1619,
      overridden: false,
    }]);

    expect(result.slots[0]).toEqual(expect.objectContaining({
      sourceShipIndex: 2,
      sourceSlotIndex: 1,
      equipmentMasterId: 1619,
      overridden: false,
    }));
  });
  test('keeps an editable empty row and applies documented zero defaults', () => {
    expect(validateAndNormalizeDetailedEnemySlots([{
      instanceId: null,
      name: '',
      sortieAntiAir: '',
      currentSlot: null,
      maxSlot: undefined,
    }])).toEqual({
      valid: true,
      errors: [],
      slots: [{
        instanceId: 'enemy-slot-0',
        name: '',
        sortieAntiAir: 0,
        currentSlot: 0,
        maxSlot: 0,
      }],
    });
  });

  test.each([
    [{ currentSlot: 12 }, { currentSlot: 12, maxSlot: 12 }],
    [{ maxSlot: 18 }, { currentSlot: 18, maxSlot: 18 }],
  ])('copies a lone current/max value to the blank counterpart', (input, expected) => {
    const result = validateAndNormalizeDetailedEnemySlots([{
      sortieAntiAir: 9,
      ...input,
    }]);

    expect(result.valid).toBe(true);
    expect(result.slots[0]).toEqual(expect.objectContaining(expected));
  });

  test.each([
    ['sortieAntiAir', -1],
    ['sortieAntiAir', Number.NaN],
    ['currentSlot', Number.POSITIVE_INFINITY],
    ['maxSlot', Number.NEGATIVE_INFINITY],
    ['currentSlot', 'not-a-number'],
  ])('rejects explicit invalid %s value %s', (field, value) => {
    const result = validateAndNormalizeDetailedEnemySlots([{
      instanceId: 'enemy-1',
      sortieAntiAir: 10,
      currentSlot: 18,
      maxSlot: 18,
      [field]: value,
    }]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'INVALID_DETAILED_ENEMY_SLOT_VALUE',
        slotIndex: 0,
        field,
      }),
    ]));
  });

  test('rejects currentSlot above maxSlot instead of silently clamping it', () => {
    const result = validateAndNormalizeDetailedEnemySlots([{
      instanceId: 'enemy-1',
      sortieAntiAir: 10,
      currentSlot: 19,
      maxSlot: 18,
    }]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'DETAILED_ENEMY_CURRENT_SLOT_EXCEEDS_MAX',
      slotIndex: 0,
      field: 'currentSlot',
    }));
  });

  test('retains original sparse indices for errors and generated identities', () => {
    const result = validateAndNormalizeDetailedEnemySlots([
      null,
      { sortieAntiAir: 9, currentSlot: 18, maxSlot: 18 },
      undefined,
      { sortieAntiAir: -1, currentSlot: 4, maxSlot: 4 },
    ]);

    expect(result.slots[0].instanceId).toBe('enemy-slot-1');
    expect(result.slots[1].instanceId).toBe('enemy-slot-3');
    expect(result.errors).toContainEqual(expect.objectContaining({
      path: 'enemy.slots[3].sortieAntiAir',
      slotIndex: 3,
    }));
  });
});
