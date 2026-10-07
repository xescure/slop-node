import { describe, expect, test } from 'vitest';
import { checkQuorumShape, PLANNED_WEIGHTS, REPRESENTATIVE_INDEXES, requiredVotingWeight } from './genesis.js';
import type { RepresentativeWeights } from './genesis.js';

function weights(values: readonly [bigint, bigint, bigint, bigint]): RepresentativeWeights {
	return({ 0: values[0], 1: values[1], 2: values[2], 3: values[3] });
}

describe('the quorum of the devnet', function() {
	test('needs more than two thirds of the delegated weight, rounding two thirds down first', function() {
		expect(requiredVotingWeight(3n)).toBe(3n);
		expect(requiredVotingWeight(4n)).toBe(3n);
		expect(requiredVotingWeight(400n)).toBe(267n);
	});

	test('is reached by any three of four equal representatives and by no two', function() {
		expect(checkQuorumShape(weights([100n, 100n, 100n, 100n]))).toEqual({ kind: 'any-three-not-two' });
	});

	test('names two representatives that reach it alone when they hold too much', function() {
		expect(checkQuorumShape(weights([500n, 500n, 50n, 50n]))).toEqual({ kind: 'two-reach', voters: [0, 1] });
	});

	test('names three representatives that fall short when the fourth holds too much', function() {
		expect(checkQuorumShape(weights([300n, 100n, 100n, 100n]))).toEqual({ kind: 'three-fall-short', voters: [1, 2, 3] });
	});

	test('holds for the weights the devnet delegates', function() {
		expect(REPRESENTATIVE_INDEXES).toEqual([0, 1, 2, 3]);
		expect(checkQuorumShape(PLANNED_WEIGHTS)).toEqual({ kind: 'any-three-not-two' });
	});
});
