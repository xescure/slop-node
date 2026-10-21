import { describe, expect, test } from 'vitest';
import { GAP_GRACE_MILLISECONDS, advanceWatermark, toStapleSequence, type StapleSequence, type Watermark } from './watermark.js';

function sequences(...values: number[]): StapleSequence[] {
	return(values.map(function(value) {
		return(toStapleSequence(BigInt(value)));
	}));
}

function watermark(through: number, missing: Record<number, number> = {}): Watermark {
	return({
		through: toStapleSequence(BigInt(through)),
		missingSince: new Map(Object.entries(missing).map(function([sequence, since]) {
			return([toStapleSequence(BigInt(sequence)), since]);
		}))
	});
}

describe('toStapleSequence', function() {
	test('accepts zero and positive sequences and rejects negative ones', function() {
		expect(toStapleSequence(0n)).toBe(0n);
		expect(toStapleSequence(7n)).toBe(7n);
		expect(function() {
			return(toStapleSequence(-1n));
		}).toThrow(new RangeError('A staple sequence is not negative: -1'));
	});
});

describe('advanceWatermark', function() {
	test('a contiguous run advances through to its end and leaves nothing missing', function() {
		expect(advanceWatermark(watermark(0), sequences(1, 2, 3), 0)).toEqual(watermark(3));
	});

	test('a gap holds through before it and is recorded when first seen', function() {
		expect(advanceWatermark(watermark(0), sequences(1, 3), 0)).toEqual(watermark(1, { 2: 0 }));
	});

	test('a gap one millisecond short of the grace still holds', function() {
		expect(advanceWatermark(watermark(1, { 2: 0 }), sequences(3), GAP_GRACE_MILLISECONDS - 1)).toEqual(watermark(1, { 2: 0 }));
	});

	test('a gap as old as the grace is passed', function() {
		expect(advanceWatermark(watermark(1, { 2: 0 }), sequences(3), GAP_GRACE_MILLISECONDS)).toEqual(watermark(3));
	});

	test('a gap that fills before the grace advances and is forgotten', function() {
		expect(advanceWatermark(watermark(1, { 2: 0 }), sequences(2, 3), 10)).toEqual(watermark(3));
	});

	test('the first sighting of a gap is kept when it is seen again', function() {
		expect(advanceWatermark(watermark(1, { 2: 5 }), sequences(3), 20)).toEqual(watermark(1, { 2: 5 }));
	});

	test('a custom grace replaces the default', function() {
		expect(advanceWatermark(watermark(1, { 2: 0 }), sequences(3), 100, 100)).toEqual(watermark(3));
		expect(advanceWatermark(watermark(1, { 2: 0 }), sequences(3), 99, 100)).toEqual(watermark(1, { 2: 0 }));
	});

	test('several gaps seen in one walk are all recorded and expire together', function() {
		const seen = advanceWatermark(watermark(0), sequences(1, 3, 5, 7), 0);
		expect(seen).toEqual(watermark(1, { 2: 0, 4: 0, 6: 0 }));
		expect(advanceWatermark(seen, sequences(3, 5, 7), GAP_GRACE_MILLISECONDS)).toEqual(watermark(7));
	});

	test('gaps beyond an unexpired one are recorded though through stops before it', function() {
		const first = advanceWatermark(watermark(0), sequences(1, 3), 0);
		const second = advanceWatermark(first, sequences(3, 5), 30_000);
		expect(second).toEqual(watermark(1, { 2: 0, 4: 30_000 }));
		expect(advanceWatermark(second, sequences(3, 5), GAP_GRACE_MILLISECONDS)).toEqual(watermark(3, { 4: 30_000 }));
	});

	test('missingSince keeps only gaps above the new through', function() {
		const advanced = advanceWatermark(watermark(1, { 2: 0 }), sequences(3, 5), GAP_GRACE_MILLISECONDS);
		expect(advanced).toEqual(watermark(3, { 4: GAP_GRACE_MILLISECONDS }));
	});

	test('nothing indexed above keeps through and the map', function() {
		const current = watermark(4, { 5: 3 });
		expect(advanceWatermark(current, [], 999_999)).toEqual(current);
	});
});
