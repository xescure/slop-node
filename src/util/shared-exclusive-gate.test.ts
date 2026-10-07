import { describe, expect, test } from 'vitest';
import { SharedExclusiveGate } from './shared-exclusive-gate.js';

type Held = {
	readonly entered: Promise<void>;
	readonly release: () => void;
	readonly done: Promise<void>;
};

/** Work that enters the gate and stays inside until released. */
function hold(gate: SharedExclusiveGate, kind: 'shared' | 'exclusive', log: string[], name: string): Held {
	let signalEntered: () => void = function() {
		throw(new Error('entered before the promise existed'));
	};
	const entered = new Promise<void>(function(resolve) {
		signalEntered = resolve;
	});
	let release: () => void = function() {
		throw(new Error('released before the promise existed'));
	};
	const released = new Promise<void>(function(resolve) {
		release = resolve;
	});
	const work = async function(): Promise<void> {
		log.push(`${name} in`);
		signalEntered();
		await released;
		log.push(`${name} out`);
	};
	let done: Promise<void>;
	if (kind === 'shared') {
		done = gate.shared(work);
	} else {
		done = gate.exclusive(work);
	}
	return({ entered, release, done });
}

describe('SharedExclusiveGate', function() {
	test('shared holders run together', async function() {
		const gate = new SharedExclusiveGate();
		const log: string[] = [];
		const first = hold(gate, 'shared', log, 'a');
		const second = hold(gate, 'shared', log, 'b');
		await Promise.all([first.entered, second.entered]);
		expect(log).toEqual(['a in', 'b in']);
		first.release();
		second.release();
		await Promise.all([first.done, second.done]);
	});

	test('an exclusive holder waits for the shared holders inside, and later shared holders wait for it', async function() {
		const gate = new SharedExclusiveGate();
		const log: string[] = [];
		const before = hold(gate, 'shared', log, 'before');
		await before.entered;
		const exclusive = hold(gate, 'exclusive', log, 'exclusive');
		const after = hold(gate, 'shared', log, 'after');
		before.release();
		await exclusive.entered;
		expect(log).toEqual(['before in', 'before out', 'exclusive in']);
		exclusive.release();
		await after.entered;
		after.release();
		await Promise.all([before.done, exclusive.done, after.done]);
		expect(log).toEqual(['before in', 'before out', 'exclusive in', 'exclusive out', 'after in', 'after out']);
	});

	test('work that fails leaves the gate and passes its failure on', async function() {
		const gate = new SharedExclusiveGate();
		await expect(gate.exclusive(function(): Promise<never> {
			return(Promise.reject(new Error('failed inside')));
		})).rejects.toThrow('failed inside');
		await expect(gate.shared(function(): Promise<string> {
			return(Promise.resolve('entered'));
		})).resolves.toBe('entered');
	});
});
