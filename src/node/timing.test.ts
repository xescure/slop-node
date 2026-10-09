import { describe, expect, test, vi } from 'vitest';
import { useLocalNodes } from '../testing/local-node.js';
import { recordNoTiming } from './timing.js';

const nodes = useLocalNodes();

describe('a timing that records nothing', function() {
	test('runs the code it times and ends the sections it hands out, holding none of them, while a copy of its node times its own', async function() {
		const { node } = await nodes.create();
		const quiet = node.copy();
		recordNoTiming(quiet.timing);
		const errors = vi.spyOn(quiet.timing.log, 'error');

		for (let section = 0; section < 1000; section++) {
			const handle = quiet.timing.startTime(`section-${String(section)}`);
			handle.end();
			handle[Symbol.dispose]();
			expect(await quiet.timing.runTimer('timed', function() {
				return(Promise.resolve(section));
			})).toBe(section);
		}

		expect(quiet.timing.getAllTiming()).toEqual({});
		expect(errors).not.toHaveBeenCalled();
		const copy = quiet.copy();
		await copy.timing.runTimer('timed', function() {
			return(Promise.resolve());
		});
		expect(Object.keys(copy.timing.getAllTiming())).toHaveLength(1);
	});
});
