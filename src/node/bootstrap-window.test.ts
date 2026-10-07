import { createHash } from 'node:crypto';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';
import { pageURL } from './bootstrap-page.js';
import { BLOOM_CAPACITY, BOOTSTRAP_OVERLAP_MILLISECONDS, BootstrapWindow } from './bootstrap-window.js';
import type { WindowStaple } from './bootstrap-window.js';

const lib = KeetaNet.lib;

/** The longest URL the client requests [Keeta TS] index.js:59614-59617. */
const CLIENT_URL_LIMIT = 8192;

const AT = Date.UTC(2026, 0, 1);

/** About the size of a staple of one send with two votes. */
const STAPLE_BYTES = 600;

/** A staple of fixed, distinct bytes, timestamped that many milliseconds after AT. */
function stapleAt(name: string, offset: number): WindowStaple {
	const bytes = Buffer.alloc(STAPLE_BYTES);
	for (let at = 0; at < STAPLE_BYTES; at += 32) {
		createHash('sha256').update(`${name}:${String(at)}`).digest().copy(bytes, at);
	}
	return({
		blocksHash: { toString: function(): string {
			return(name);
		} },
		toBytes: function(): ArrayBuffer {
			return(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		},
		timestamp: function(): Date {
			return(new Date(AT + offset));
		}
	});
}

function staplesAt(prefix: string, count: number, offset: (index: number) => number): WindowStaple[] {
	return(Array.from({ length: count }, function(_ignored, index): WindowStaple {
		return(stapleAt(`${prefix}${String(index)}`, offset(index)));
	}));
}

function requireFilter(window: BootstrapWindow): BloomFilter {
	const filter = window.filter();
	if (filter === undefined) {
		throw(new Error('the window names no staple'));
	}
	return(filter);
}

function named(window: BootstrapWindow, staples: readonly WindowStaple[]): boolean[] {
	const filter = requireFilter(window);
	return(staples.map(function(staple): boolean {
		return(filter.has(staple.toBytes()));
	}));
}

describe('a bootstrap window', function() {
	test('names nothing before the peer has sent anything, unless the node holds staples already', function() {
		expect(new BootstrapWindow(new Date(0), []).filter()).toBeUndefined();
		const held = stapleAt('held', 0);
		expect(named(new BootstrapWindow(new Date(0), [held]), [held])).toEqual([true]);
	});

	test('moves to the latest timestamp of a page, less the overlap, whatever order the page is in', function() {
		const window = new BootstrapWindow(new Date(0), []);
		window.advance([stapleAt('late', 90_000), stapleAt('early', 10_000)]);
		expect(window.start).toEqual(new Date(AT + 90_000 - BOOTSTRAP_OVERLAP_MILLISECONDS));
	});

	test('tells a page that brings the pass no further, as from a peer that ignores the filter', function() {
		const window = new BootstrapWindow(new Date(AT), []);
		const page = [stapleAt('first', 0), stapleAt('second', 0)];
		expect(window.advance(page)).toBe(true);
		expect(window.advance([stapleAt('third', 0), ...page])).toBe(true);
		expect(window.advance(page)).toBe(false);
		expect(window.advance([stapleAt('later', 60_000), ...page])).toBe(true);
	});

	test('moves no further than the clock, however far ahead of it a vote is timestamped', function() {
		vi.setSystemTime(new Date(AT));
		onTestFinished(function() {
			vi.useRealTimers();
		});
		const window = new BootstrapWindow(new Date(0), []);
		window.advance([stapleAt('ahead', 600_000)]);
		expect(window.start).toEqual(new Date(AT - BOOTSTRAP_OVERLAP_MILLISECONDS));
	});

	test('never moves back, and stays put on an empty page', function() {
		const window = new BootstrapWindow(new Date(AT), []);
		window.advance([]);
		expect(window.start).toEqual(new Date(AT));
		window.advance([stapleAt('old', -60_000)]);
		expect(window.start).toEqual(new Date(AT));
	});

	test('names what the peer may send again: what came since the start last moved, and what is timestamped at or after it', function() {
		const window = new BootstrapWindow(new Date(0), []);
		const before = stapleAt('before', 0);
		const within = stapleAt('within', 50_000);
		const latest = stapleAt('latest', 60_000);
		window.advance([before, within, latest]);
		expect(window.start).toEqual(new Date(AT + 60_000 - BOOTSTRAP_OVERLAP_MILLISECONDS));
		expect(named(window, [before, within, latest])).toEqual([false, true, true]);

		// A page that moves the start no further is named whole, so that the next page brings something new.
		const lateCommit = stapleAt('late-commit', 0);
		window.advance([lateCommit]);
		expect(named(window, [lateCommit, within, latest])).toEqual([true, true, true]);
	});

	test('lets go of what came before the start once it moves on', function() {
		const window = new BootstrapWindow(new Date(0), [stapleAt('held', 0)]);
		window.advance([stapleAt('first', 0)]);
		window.advance([stapleAt('next', 120_000)]);
		expect(named(window, [stapleAt('held', 0), stapleAt('first', 0), stapleAt('next', 120_000)])).toEqual([false, false, true]);
	});

	test('names what came since the start last moved first when it knows more than a filter holds', function() {
		const held = staplesAt('held', BLOOM_CAPACITY, function(): number {
			return(0);
		});
		const window = new BootstrapWindow(new Date(AT), held);
		const page = [stapleAt('sent', 0)];
		window.advance(page);
		expect(named(window, page)).toEqual([true]);
		expect(named(window, held).filter(Boolean)).toHaveLength(BLOOM_CAPACITY - 1);
	});

	test('moves on without the overlap once what came since the start last moved fills a filter, so that a peer cannot hold it in place', function() {
		const window = new BootstrapWindow(new Date(AT), []);
		window.advance(staplesAt('burst', BLOOM_CAPACITY, function(index): number {
			return(index);
		}));
		expect(window.start).toEqual(new Date(AT + BLOOM_CAPACITY - 1));
	});

	test('keeps a full filter, and so its request, within the URL the client allows', function() {
		const window = new BootstrapWindow(new Date(AT), staplesAt('held', BLOOM_CAPACITY, function(index): number {
			return(index);
		}));
		const bloomFilter = lib.Utils.Bloom.serializeBloomFilter(requireFilter(window));
		const url = pageURL({ endpoint: 'https://representative-with-a-long-name.example.keeta.network:65535/api', start: window.start, limit: 1000, bloomFilter });
		expect(url.toString().length).toBeLessThanOrEqual(CLIENT_URL_LIMIT);
	});

	test('seeds each filter afresh, so that a staple named by mistake once is not named by mistake every time', function() {
		const window = new BootstrapWindow(new Date(AT), [stapleAt('held', 0)]);
		expect(requireFilter(window).seed).not.toBe(requireFilter(window).seed);
	});
});
