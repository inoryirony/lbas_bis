import { describe, expect, test } from 'vitest';
import aircraftModule from '../src/aircraft.js';
import contactModule from '../src/combat-contact.js';

const { capabilitiesFor } = aircraftModule;
const {
  contactMultiplierForRoll,
  contactTierProbabilities,
  createContactState,
  prepareContactProfile,
  resolveContactState,
} = contactModule;

describe('LBAS contact', () => {
  test('derives every KC3 contact-capable API equipment type', () => {
    for (const equipType of [8, 9, 10, 41, 49, 94]) {
      expect(capabilitiesFor({ equipType }).canContact).toBe(true);
    }
    expect(capabilitiesFor({ equipType: 47 }).canContact).toBe(false);
  });

  test('aggregates the highest successful accuracy tier exactly', () => {
    const profile = prepareContactProfile([
      contactPlane('high', 9, 7, 3),
      contactPlane('mid', 10, 8, 2),
      contactPlane('low', 41, 9, 1),
      contactPlane('torpedo-high', 8, 7, 3),
    ]);
    const probabilities = contactTierProbabilities(
      profile,
      [4, 4, 4, 18],
      'supremacy',
    );

    expect(probabilities.start).toBe(1);
    expect(probabilities.high).toBeCloseTo(0.75, 12);
    expect(probabilities.middle).toBeCloseTo(0.25 * (8 / 14), 12);
    expect(probabilities.low).toBeCloseTo(0.25 * (1 - 8 / 14) * (9 / 14), 12);
    expect(probabilities.none).toBeCloseTo(
      1 - probabilities.high - probabilities.middle - probabilities.low,
      12,
    );
    expect(contactMultiplierForRoll(probabilities, 0.1)).toBe(1.2);
    expect(contactMultiplierForRoll(probabilities, 0.8)).toBe(1.17);
    expect(contactMultiplierForRoll(probabilities, 0.95)).toBe(1.12);
    expect(contactMultiplierForRoll(probabilities, 0.999999)).toBe(1);
  });

  test('excludes torpedo bombers only from the start roll', () => {
    const profile = prepareContactProfile([
      contactPlane('torpedo-only', 8, 14, 3),
    ]);
    const probabilities = contactTierProbabilities(profile, [18], 'supremacy');

    expect(probabilities.start).toBeCloseTo(1 / 25, 12);
    expect(probabilities.high).toBeCloseTo(1 / 25, 12);
    expect(probabilities.none).toBeCloseTo(24 / 25, 12);
  });

  test('excludes a zero-slot aircraft from contact selection', () => {
    const profile = prepareContactProfile([
      contactPlane('shot-down-scout', 9, 14, 3),
    ]);
    const probabilities = contactTierProbabilities(profile, [0], 'supremacy');

    expect(probabilities).toMatchObject({
      high: 0,
      middle: 0,
      low: 0,
      none: 1,
    });
    expect(contactMultiplierForRoll(probabilities, 0)).toBe(1);
  });

  test('borrows the previous air state and retains the last successful contact', () => {
    const profile = prepareContactProfile([contactPlane('scout', 9, 14, 3)]);
    let state = createContactState();

    let resolved = resolveContactState(profile, [4], 'supremacy', state, 0);
    expect(resolved).toMatchObject({
      effectiveAirStateKey: 'supremacy',
      multiplier: 1.2,
      previousAirStateKey: 'supremacy',
      previousSuccessfulMultiplier: 1.2,
    });
    state = resolved.state;

    resolved = resolveContactState(profile, [4], 'parity', state, 0);
    expect(resolved).toMatchObject({
      effectiveAirStateKey: 'supremacy',
      multiplier: 1.2,
      previousAirStateKey: 'supremacy',
    });
    state = resolved.state;

    resolved = resolveContactState(profile, [4], 'superiority', state, 0.999999);
    expect(resolved).toMatchObject({
      multiplier: 1,
      previousAirStateKey: 'superiority',
      previousSuccessfulMultiplier: 1.2,
    });
    state = resolved.state;

    resolved = resolveContactState(profile, [4], 'loss', state, 0.999999);
    expect(resolved).toMatchObject({
      effectiveAirStateKey: 'loss',
      multiplier: 1.2,
      previousAirStateKey: 'loss',
      previousSuccessfulMultiplier: 1.2,
    });
    state = resolved.state;

    resolved = resolveContactState(profile, [4], 'parity', state, 0.999999);
    expect(resolved).toMatchObject({
      effectiveAirStateKey: 'loss',
      multiplier: 1.2,
      previousAirStateKey: 'loss',
    });
  });

  test('does not manufacture contact for an initial parity state', () => {
    const profile = prepareContactProfile([contactPlane('scout', 9, 14, 3)]);
    const resolved = resolveContactState(
      profile,
      [4],
      'parity',
      createContactState(),
      0,
    );

    expect(resolved).toMatchObject({
      effectiveAirStateKey: 'parity',
      multiplier: 1,
      previousAirStateKey: null,
      previousSuccessfulMultiplier: 1,
    });
  });
});

/** Creates one minimal contact-capable aircraft fixture. */
function contactPlane(instanceId, equipType, scout, accuracy) {
  return {
    instanceId,
    equipType,
    scout,
    accuracy,
  };
}
