import { describe, expect, test } from 'vitest';
import plugin from '../index.js';

const { normalizeTargetStates, parseTargetStates } = plugin;

describe('plugin entry', () => {
  test('exports an embedded Poi plugin panel instead of a new window mode', () => {
    expect(plugin.reactClass).toBeTypeOf('function');
    expect(plugin.windowMode).toBeUndefined();
  });

  test('normalizes target states for one selector per base', () => {
    expect(parseTargetStates('parity,bad,supremacy')).toEqual(['parity', 'supremacy']);
    expect(normalizeTargetStates(['denial'], 3)).toEqual([
      'denial',
      'denial',
      'denial',
      'denial',
      'denial',
      'denial',
    ]);
  });
});
