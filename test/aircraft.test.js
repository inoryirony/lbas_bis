import { describe, expect, test } from 'vitest';
import aircraft from '../src/aircraft.js';

const {
  aircraftEquivalenceKey,
  applyAircraftCapabilities,
  capabilitiesFor,
} = aircraft;

describe('Aircraft capabilities', () => {
  test('maps API equipment types to independent aircraft capabilities', () => {
    expect(capabilitiesFor({ masterId: 500, equipType: 53 })).toEqual(expect.objectContaining({
      isPlane: true,
      isAttacker: true,
      isLandAttacker: true,
      isHeavyLandAttacker: true,
      isRecon: false,
    }));
    expect(capabilitiesFor({ masterId: 501, equipType: 49 })).toEqual(expect.objectContaining({
      isPlane: true,
      isRecon: true,
      isLandRecon: true,
      isAttacker: false,
    }));
    expect(capabilitiesFor({ masterId: 502, equipType: 56 })).toEqual(expect.objectContaining({
      isPlane: true,
      isFighter: true,
    }));
  });

  test('marks attack-capable ASW patrol planes without treating autogyros as attackers', () => {
    expect(capabilitiesFor({ masterId: 600, equipType: 26, bombing: 0 })).toEqual(expect.objectContaining({
      isAswPatrol: true,
      isAswBomber1: false,
      isAswBomber2: false,
      isAttacker: false,
      blocksRangeExtension: true,
    }));
    expect(capabilitiesFor({ masterId: 601, equipType: 26, bombing: 3 })).toEqual(expect.objectContaining({
      isAswPatrol: true,
      isAswBomber1: false,
      isAswBomber2: true,
      isAttacker: false,
      blocksRangeExtension: false,
    }));
    expect(capabilitiesFor({ masterId: 602, equipType: 26, bombing: 4 })).toEqual(expect.objectContaining({
      isAswPatrol: true,
      isAswBomber1: true,
      isAswBomber2: false,
      isAttacker: true,
      blocksRangeExtension: false,
    }));
    expect(capabilitiesFor({ masterId: 603, equipType: 25, bombing: 4 })).toEqual(expect.objectContaining({
      isAutoGyro: true,
      isAswPatrol: true,
      isAttacker: false,
      blocksRangeExtension: true,
    }));
  });

  test('excludes unsupported API types while retaining type 56 fighters', () => {
    for (const equipType of [54, 58, 59]) {
      expect(capabilitiesFor({ masterId: 800 + equipType, equipType }).isPlane).toBe(false);
    }
    expect(capabilitiesFor({ masterId: 856, equipType: 56 })).toEqual(expect.objectContaining({
      isPlane: true,
      isFighter: true,
    }));
  });

  test('does not infer capability sets from unrelated types or stats', () => {
    const cases = [
      ['isFighter', { equipType: 47, antiAir: 99 }],
      ['isAttacker', { equipType: 6, torpedo: 99, bombing: 99 }],
      ['isRecon', { equipType: 47, scout: 99 }],
      ['isLandAttacker', { equipType: 7, torpedo: 99 }],
      ['isHeavyLandAttacker', { equipType: 47 }],
      ['isAswPatrol', { equipType: 47, asw: 99 }],
      ['isBakusen', { masterId: 61, equipType: 7 }],
      ['isJet', { equipType: 56, iconType: 59 }],
      ['isHeavyJet', { equipType: 57, iconType: 60 }],
    ];

    for (const [capability, input] of cases) {
      expect(capabilitiesFor(input)[capability]).toBe(false);
    }
  });

  test('maps bakusen and jet flags independently from aircraft role', () => {
    expect(capabilitiesFor({ masterId: 487, equipType: 7, iconType: 60 })).toEqual(expect.objectContaining({
      isBakusen: true,
      isJet: true,
      isHeavyJet: false,
    }));
    expect(capabilitiesFor({ masterId: 700, equipType: 57, iconType: 59 })).toEqual(expect.objectContaining({
      isJet: true,
      isHeavyJet: true,
    }));
  });

  test('applies capabilities without mutating the source plane', () => {
    const source = { masterId: 187, equipType: 47, bombing: 14 };
    const result = applyAircraftCapabilities(source);

    expect(result).not.toBe(source);
    expect(source).not.toHaveProperty('isPlane');
    expect(result).toEqual(expect.objectContaining({ isPlane: true, isLandAttacker: true }));
  });

  test('groups search-equivalent copies while preserving meaningful differences', () => {
    const base = applyAircraftCapabilities({
      instanceId: 1,
      masterId: 187,
      name: 'Ginga',
      equipType: 47,
      iconType: 37,
      antiAir: 3,
      intercept: 0,
      antiBomber: 0,
      radius: 9,
      torpedo: 14,
      bombing: 14,
      asw: 3,
      improvement: 2,
      proficiency: 7,
      internalProficiency: 110,
      isLandBased: true,
      available: true,
      missing: false,
    });

    expect(aircraftEquivalenceKey({ ...base, instanceId: 2 }))
      .toBe(aircraftEquivalenceKey(base));
    expect(aircraftEquivalenceKey({ ...base, improvement: 3 }))
      .not.toBe(aircraftEquivalenceKey(base));
    expect(aircraftEquivalenceKey({ ...base, internalProficiency: 111 }))
      .not.toBe(aircraftEquivalenceKey(base));
    expect(aircraftEquivalenceKey({ ...base, scout: 8 }))
      .not.toBe(aircraftEquivalenceKey(base));
    expect(aircraftEquivalenceKey({ ...base, role: 'fighter' }))
      .not.toBe(aircraftEquivalenceKey(base));
    expect(aircraftEquivalenceKey({ ...base, available: false, missing: true }))
      .not.toBe(aircraftEquivalenceKey(base));
  });

  test('distinguishes explicit true formula capabilities without reclassifying API types', () => {
    const plain = { masterId: 700, equipType: 54, antiAir: 5, improvement: 10 };
    const explicitFighter = { ...plain, isFighter: true };

    expect(capabilitiesFor(plain).isPlane).toBe(false);
    expect(capabilitiesFor(explicitFighter).isPlane).toBe(false);
    expect(aircraftEquivalenceKey(plain)).not.toBe(aircraftEquivalenceKey(explicitFighter));
  });

  test('canonicalizes formula inputs without collapsing behaviorally different values', () => {
    const known = applyAircraftCapabilities({
      instanceId: 1,
      masterId: 187,
      equipType: 47,
      proficiency: 7,
      internalProficiency: 0,
      available: true,
      missing: false,
    });
    const { internalProficiency: ignored, ...unknown } = known;

    expect(aircraftEquivalenceKey({ ...unknown, internalProficiency: undefined }))
      .toBe(aircraftEquivalenceKey({ ...unknown, internalProficiency: Number.NaN }));
    expect(aircraftEquivalenceKey({ ...unknown, internalProficiency: Number.POSITIVE_INFINITY }))
      .toBe(aircraftEquivalenceKey(unknown));
    expect(aircraftEquivalenceKey(known)).not.toBe(aircraftEquivalenceKey(unknown));

    expect(aircraftEquivalenceKey({ ...unknown, currentSlot: Number.NaN }))
      .toBe(aircraftEquivalenceKey({ ...unknown, currentSlot: 0 }));
    expect(aircraftEquivalenceKey(unknown))
      .not.toBe(aircraftEquivalenceKey({ ...unknown, currentSlot: 0 }));
    expect(aircraftEquivalenceKey({ ...unknown, slotSize: Number.NaN }))
      .toBe(aircraftEquivalenceKey({ ...unknown, slotSize: 0 }));
    expect(aircraftEquivalenceKey(unknown))
      .not.toBe(aircraftEquivalenceKey({ ...unknown, slotSize: 0 }));
  });

  test('keeps infinite slot inputs distinct when their formula fallbacks differ', () => {
    const plane = applyAircraftCapabilities({
      masterId: 187,
      equipType: 47,
      proficiency: 7,
      available: true,
      missing: false,
    });

    expect(aircraftEquivalenceKey({ ...plane, currentSlot: Number.POSITIVE_INFINITY }))
      .toBe(aircraftEquivalenceKey({ ...plane, currentSlot: 0 }));
    expect(aircraftEquivalenceKey({ ...plane, currentSlot: Number.POSITIVE_INFINITY }))
      .not.toBe(aircraftEquivalenceKey(plane));
    expect(aircraftEquivalenceKey({ ...plane, slotSize: Number.POSITIVE_INFINITY }))
      .not.toBe(aircraftEquivalenceKey(plane));
    expect(aircraftEquivalenceKey({ ...plane, slotSize: Number.POSITIVE_INFINITY }))
      .not.toBe(aircraftEquivalenceKey({ ...plane, slotSize: 0 }));
  });
});
