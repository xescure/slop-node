import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';
import { pageURL } from './bootstrap-page.js';
import { ACCEPTED_ERROR_RATE, BLOOM_CAPACITY, BLOOM_ERROR_RATE, MAX_NAMED, NamedStaples, stapleKey } from './bootstrap-window.js';
import type { NamedStaple } from './bootstrap-window.js';

const lib = KeetaNet.lib;

/** The longest URL the client requests [Keeta TS] index.js:59614-59617. */
const CLIENT_URL_LIMIT = 8192;

/** About the size of a staple of one send with two votes. */
const STAPLE_BYTES = 600;

/** A staple of fixed, distinct bytes, on the blocks named, with the votes named. */
function stapleNamed(name: string, votes = ''): NamedStaple {
	const bytes = Buffer.alloc(STAPLE_BYTES);
	for (let at = 0; at < STAPLE_BYTES; at += 32) {
		createHash('sha256').update(`${name}:${votes}:${String(at)}`).digest().copy(bytes, at);
	}
	return({
		blocksHash: { toString: function(): string {
			return(name);
		} },
		toBytes: function(): ArrayBuffer {
			return(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		}
	});
}

function staplesNamed(prefix: string, count: number): NamedStaple[] {
	return(Array.from({ length: count }, function(_ignored, index): NamedStaple {
		return(stapleNamed(`${prefix}${String(index)}`));
	}));
}

function filterOf(named: NamedStaples, seed = 1): BloomFilter {
	const serialized = named.filter(seed).serialized;
	if (serialized === undefined) {
		throw(new Error('nothing is named'));
	}
	return(lib.Utils.Bloom.deserializeBloomFilter(serialized));
}

function inFilter(named: NamedStaples, staples: readonly NamedStaple[]): boolean[] {
	const filter = filterOf(named);
	return(staples.map(function(staple): boolean {
		return(filter.has(staple.toBytes()));
	}));
}

describe('the staples a filter names', function() {
	test('make no filter while none is named, and name what the node held and what the peer sent', function() {
		const named = new NamedStaples();
		expect(named.filter(1)).toEqual({ serialized: undefined, errorRate: 0 });
		const held = stapleNamed('held');
		const sent = stapleNamed('sent');
		named.hold([held]);
		named.receive([sent]);
		expect(inFilter(named, [held, sent, stapleNamed('other')])).toEqual([true, true, false]);
		expect(named.names(sent)).toBe(true);
		expect(named.size).toBe(2);
	});

	test('make a filter of one size however many are named, so that its false positive rate is never above the target while it holds no more than its capacity', function() {
		const few = new NamedStaples();
		few.hold(staplesNamed('one', 1));
		const full = new NamedStaples();
		full.hold(staplesNamed('many', BLOOM_CAPACITY));
		const overfull = new NamedStaples();
		overfull.receive(staplesNamed('more', 2 * BLOOM_CAPACITY));
		expect(filterOf(few).size).toBe(filterOf(full).size);
		expect(filterOf(overfull).size).toBe(filterOf(full).size);
	});

	test('name what the node held only while there is room, and let the latest of it go to make room for what the peer sent', function() {
		const named = new NamedStaples();
		const held = staplesNamed('held', BLOOM_CAPACITY + 1);
		named.hold(held);
		expect(named.size).toBe(BLOOM_CAPACITY);
		const sent = stapleNamed('sent');
		named.receive([sent]);
		expect(named.size).toBe(BLOOM_CAPACITY);
		expect([held[0], held[BLOOM_CAPACITY - 2], held[BLOOM_CAPACITY - 1], sent].map(function(staple): boolean {
			return(staple !== undefined && named.names(staple));
		})).toEqual([true, true, false, true]);
	});

	test('name every staple the peer sent, past the capacity, at an error rate that rises with their number', function() {
		const named = new NamedStaples();
		named.hold(staplesNamed('held', 10));
		const sent = staplesNamed('sent', 3 * BLOOM_CAPACITY);
		named.receive(sent);
		expect(named.size).toBe(3 * BLOOM_CAPACITY);
		expect(sent.every(function(staple): boolean {
			return(named.names(staple));
		})).toBe(true);
		expect(inFilter(named, sent).every(Boolean)).toBe(true);
		const rate = named.filter(1).errorRate;
		expect(rate).toBeGreaterThan(ACCEPTED_ERROR_RATE);
		expect(rate).toBeLessThan(0.01);
	});

	test('name a full filter at the rate a pass accepts: the rate its cells were made for, and the chance that a staple\'s cells are a named staple\'s', function() {
		const named = new NamedStaples();
		named.receive(staplesNamed('sent', BLOOM_CAPACITY));
		const cells = filterOf(named).size;
		expect(named.filter(1).errorRate).toBe(ACCEPTED_ERROR_RATE);
		expect(ACCEPTED_ERROR_RATE - BLOOM_CAPACITY / cells ** 2).toBeCloseTo(BLOOM_ERROR_RATE, 9);
		const fewer = new NamedStaples();
		fewer.receive(staplesNamed('sent', BLOOM_CAPACITY / 2));
		expect(fewer.filter(1).errorRate).toBeLessThan(ACCEPTED_ERROR_RATE);
		expect(fewer.filter(1).errorRate).toBeGreaterThan(BLOOM_CAPACITY / 2 / cells ** 2);
	});

	/*
	 * The client places a staple's cells by two 32-bit hashes of its bytes
	 * [Keeta TS] index.js:90799-90809, so a filter names, on every cell, a
	 * staple whose two hashes agree with a named staple's modulo its size. In
	 * a filter of 53 cells, which one staple's 24 cells leave mostly clear,
	 * such a staple turns up among some three thousand.
	 */
	test('are named by a filter that names a staple whose hashes agree with theirs modulo its size', function() {
		const filter = new lib.Utils.Bloom.BloomFilter(53, 24);
		filter.seed = 7;
		const named = stapleNamed('named').toBytes();
		filter.add(named);
		const cellsOf = function(bytes: ArrayBuffer): string {
			return(filter._hashing.getIndexes(bytes, filter.size, 24, filter.seed).join());
		};
		const namedCells = cellsOf(named);
		let alike: ArrayBuffer | undefined;
		for (let index = 0; alike === undefined; index++) {
			const bytes = stapleNamed(`other ${String(index)}`).toBytes();
			if (cellsOf(bytes) === namedCells) {
				alike = bytes;
			}
		}

		expect(filter.has(alike)).toBe(true);
	});

	test('tell staples apart by their bytes, so that the same blocks with other votes are not named', function() {
		const named = new NamedStaples();
		named.receive([stapleNamed('blocks', 'first votes')]);
		expect(named.names(stapleNamed('blocks', 'first votes'))).toBe(true);
		expect(named.names(stapleNamed('blocks', 'other votes'))).toBe(false);
	});

	test('let go, as the start moves on, of what the peer sent before, and of what the node held, which is named again from the new start', function() {
		const named = new NamedStaples();
		const held = stapleNamed('held');
		const earlier = stapleNamed('earlier-page');
		const page = staplesNamed('page', 4);
		named.hold([held]);
		named.receive([earlier]);
		named.moveOn(page.slice(2));
		expect([held, earlier, ...page].map(function(staple): boolean {
			return(named.names(staple));
		})).toEqual([false, false, false, false, true, true]);
	});

	test('carry of what another received only what the peer may list again, and what it held', function() {
		const named = new NamedStaples();
		const held = stapleNamed('held');
		const behind = stapleNamed('behind');
		const ahead = stapleNamed('ahead');
		named.hold([held]);
		named.receive([behind, ahead]);
		const following = new NamedStaples();
		following.carry(named, function(key): boolean {
			return(key !== stapleKey(behind));
		});
		expect([held, behind, ahead].map(function(staple): boolean {
			return(following.names(staple));
		})).toEqual([true, false, true]);
	});

	test('carry, as far as there is room, what another names, after what they name already', function() {
		const named = new NamedStaples();
		const held = stapleNamed('held');
		const earlier = stapleNamed('earlier-page');
		named.hold([held]);
		named.receive([earlier]);
		const page = staplesNamed('page', BLOOM_CAPACITY - 1);
		const following = new NamedStaples();
		following.receive(page);
		following.carry(named, function(): boolean {
			return(true);
		});
		expect([earlier, held].map(function(staple): boolean {
			return(following.names(staple));
		})).toEqual([true, false]);
		expect(following.size).toBe(BLOOM_CAPACITY);
		expect(following.received).toBe(BLOOM_CAPACITY - 1);
		following.forget(earlier);
		following.forget(page[0] ?? earlier);
		expect([earlier, page[0] ?? earlier].map(function(staple): boolean {
			return(following.names(staple));
		})).toEqual([false, false]);
	});

	test.each([BLOOM_CAPACITY, 5000, MAX_NAMED])('keep a filter of %i staples, and so its request, within the URL the client allows', function(count: number) {
		const named = new NamedStaples();
		named.receive(staplesNamed('sent', count));
		const url = pageURL({ endpoint: 'https://representative-with-a-long-name.example.keeta.network:65535/api', start: new Date(), limit: 1000, bloomFilter: named.filter(2 ** 31 - 1).serialized });
		expect(url.toString().length).toBeLessThanOrEqual(CLIENT_URL_LIMIT);
	});

	test('make a filter with the seed given, so that a staple named by mistake once is not named by mistake every time', function() {
		const named = new NamedStaples();
		named.hold([stapleNamed('held')]);
		expect([filterOf(named, 7).seed, filterOf(named, 8).seed]).toEqual([7, 8]);
	});

	test('count a staple once whether the node held it or the peer sent it, or both', function() {
		const named = new NamedStaples();
		const [first, second] = staplesNamed('both', 2);
		if (first === undefined || second === undefined) {
			throw(new Error('two staples are made'));
		}
		named.receive([first]);
		named.hold([first]);
		expect(named.size).toBe(1);
		named.hold([second]);
		named.receive([second]);
		expect(named.size).toBe(2);
		const carrying = new NamedStaples();
		carrying.receive([first]);
		carrying.carry(named, function(): boolean {
			return(true);
		});
		expect(carrying.size).toBe(2);
	});

	test('name exactly its capacity with as many hashes as a filter made for it at the target rate', function() {
		const full = new NamedStaples();
		full.hold(staplesNamed('full', BLOOM_CAPACITY));

		expect(filterOf(full)._nbHashes).toBe(lib.Utils.Bloom.BloomFilter.create(BLOOM_CAPACITY, BLOOM_ERROR_RATE)._nbHashes);
	});

	test('keep every staple it held while what the peer sent fills it up to its capacity', function() {
		const named = new NamedStaples();
		const held = staplesNamed('held', BLOOM_CAPACITY - 1);
		named.hold(held);
		named.receive([stapleNamed('sent')]);

		expect(named.size).toBe(BLOOM_CAPACITY);
		expect(held.every(function(staple): boolean {
			return(named.names(staple));
		})).toBe(true);
	});
});
