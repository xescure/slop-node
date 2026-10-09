import { describe, expect, test } from 'vitest';
import { atMoment } from './frozen-clock.js';

describe('a frozen clock', function() {
	test('reads the moment wherever the time is read, and gives the real clock back', async function() {
		const moment = new Date('2025-12-30T12:34:56.789Z');
		const seen = await atMoment(moment, function() {
			return(Promise.resolve({ now: Date.now(), constructed: new Date().toISOString(), given: new Date(0).getTime(), parts: new Date(2025, 0, 2).getDate(), isDate: new Date() instanceof Date }));
		});
		expect(seen).toEqual({ now: moment.getTime(), constructed: moment.toISOString(), given: 0, parts: 2, isDate: true });
		expect(Math.abs(Date.now() - moment.getTime())).toBeGreaterThan(1000);
	});

	test('gives the real clock back when the run fails', async function() {
		await expect(atMoment(new Date(0), function() {
			return(Promise.reject(new Error('refused')));
		})).rejects.toThrow('refused');
		expect(Date.now()).toBeGreaterThan(0);
		expect(new Date().getFullYear()).toBeGreaterThan(1970);
	});
});
