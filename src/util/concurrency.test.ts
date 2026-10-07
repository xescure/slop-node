import { describe, expect, test } from 'vitest';
import { eachAtMost } from './concurrency.js';

/** Lets every promise that can settle now do so. */
function settled(): Promise<void> {
	return(new Promise(function(resolve) {
		setImmediate(resolve);
	}));
}

describe('working through items with a bound on how many at once', function() {
	test('runs no more than the bound at once, starts the next as one finishes, and answers in order', async function() {
		const finish = new Map<number, () => void>();
		const started: number[] = [];
		const done = eachAtMost([1, 2, 3, 4, 5], 2, function(item): Promise<number> {
			started.push(item);
			return(new Promise<number>(function(resolve) {
				finish.set(item, function() {
					resolve(item * 10);
				});
			}));
		});
		expect(started).toEqual([1, 2]);

		finish.get(2)?.();
		await settled();
		expect(started).toEqual([1, 2, 3]);

		for (const item of [1, 3, 4, 5]) {
			finish.get(item)?.();
			await settled();
		}
		expect(await done).toEqual([10, 20, 30, 40, 50]);
	});

	test('answers nothing for no items', async function() {
		expect(await eachAtMost([], 4, function(): Promise<number> {
			return(Promise.resolve(1));
		})).toEqual([]);
	});
});
