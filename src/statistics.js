'use strict';

const NORMAL_95_PERCENT = 1.959963984540054;

/** Returns a two-sided 95% Wilson score interval for a Bernoulli probability. */
function wilsonScoreInterval(successes, trials) {
  const count = nonNegativeInteger(trials, 'trials');
  const wins = nonNegativeInteger(successes, 'successes');
  if (count === 0 || wins > count) {
    throw new RangeError('successes must be no greater than a positive trial count.');
  }
  const estimate = wins / count;
  const zSquared = NORMAL_95_PERCENT ** 2;
  const denominator = 1 + zSquared / count;
  const center = (estimate + zSquared / (2 * count)) / denominator;
  const radius = NORMAL_95_PERCENT * Math.sqrt(
    estimate * (1 - estimate) / count + zSquared / (4 * count ** 2),
  ) / denominator;
  return {
    confidenceLevel: 0.95,
    method: 'wilson-score',
    successes: wins,
    trials: count,
    estimate,
    lower: Math.max(0, center - radius),
    upper: Math.min(1, center + radius),
  };
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new RangeError(`${name} must be a nonnegative integer.`);
  }
  return number;
}

module.exports = { wilsonScoreInterval };
