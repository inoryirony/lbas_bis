'use strict';

const ATTACK_COORDINATE_PERMUTATIONS = Object.freeze([
  [[]],
  [[0]],
  [[0, 1], [1, 0]],
  [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ],
  [
    [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1],
    [0, 3, 1, 2], [0, 3, 2, 1], [1, 0, 2, 3], [1, 0, 3, 2],
    [1, 2, 0, 3], [1, 2, 3, 0], [1, 3, 0, 2], [1, 3, 2, 0],
    [2, 0, 1, 3], [2, 0, 3, 1], [2, 1, 0, 3], [2, 1, 3, 0],
    [2, 3, 0, 1], [2, 3, 1, 0], [3, 0, 1, 2], [3, 0, 2, 1],
    [3, 1, 0, 2], [3, 1, 2, 0], [3, 2, 0, 1], [3, 2, 1, 0],
  ],
]);

/** Maximizes one injective plane-to-coordinate assignment, optionally reading vector cells. */
function maximumCoordinateAssignment(matrix, vectorIndex = null) {
  const permutations = ATTACK_COORDINATE_PERMUTATIONS[matrix.length];
  if (!permutations) throw new RangeError('At most four combat attackers are supported.');
  let maximum = 0;
  for (const permutation of permutations) {
    let total = 0;
    for (let planeIndex = 0; planeIndex < permutation.length; planeIndex += 1) {
      const cell = matrix[planeIndex][permutation[planeIndex]];
      total += vectorIndex == null ? cell : cell[vectorIndex];
    }
    maximum = Math.max(maximum, total);
  }
  return maximum;
}

module.exports = { maximumCoordinateAssignment };
