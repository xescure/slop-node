import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BloomFilter } from '@keetanetwork/keetanet-client/lib/utils/bloom.js';
import { pageURL } from './bootstrap-page.js';
import { BLOOM_CAPACITY, NamedStaples } from './bootstrap-window.js';
import type { NamedStaple } from './bootstrap-window.js';

const lib = KeetaNet.lib;

/** The longest URL the client requests [Keeta TS] index.js:59614-59617. */
const CLIENT_URL_LIMIT = 8192;

/** About the size of a staple of one send with two votes. */
const STAPLE_BYTES = 600;

/** A staple of fixed, distinct bytes. */
function stapleNamed(name: string): NamedStaple {
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
		}
	});
}

function staplesNamed(prefix: string, count: number): NamedStaple[] {
	return(Array.from({ length: count }, function(_ignored, index): NamedStaple {
		return(stapleNamed(`${prefix}${String(index)}`));
	}));
}

function filterOf(named: NamedStaples, seed = 1): BloomFilter {
	const serialized = named.serialize(seed);
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
		expect(named.serialize(1)).toBeUndefined();
		const held = stapleNamed('held');
		const sent = stapleNamed('sent');
		named.hold([held]);
		named.receive([sent]);
		expect(inFilter(named, [held, sent, stapleNamed('other')])).toEqual([true, true, false]);
		expect(named.names(sent)).toBe(true);
		expect(named.size).toBe(2);
	});

	test('make a filter of one size however many are named, so that its false positive rate is never above the target', function() {
		const few = new NamedStaples();
		few.hold(staplesNamed('one', 1));
		const full = new NamedStaples();
		full.hold(staplesNamed('many', BLOOM_CAPACITY));
		expect(filterOf(few).size).toBe(filterOf(full).size);
	});

	test('let go of the earliest named once more are named than a filter holds', function() {
		const named = new NamedStaples();
		const held = staplesNamed('held', BLOOM_CAPACITY);
		named.hold(held);
		const sent = stapleNamed('sent');
		named.receive([sent]);
		expect(named.size).toBe(BLOOM_CAPACITY);
		expect(named.names(sent)).toBe(true);
		expect([held[0], held[1]].map(function(staple): boolean {
			return(staple !== undefined && named.names(staple));
		})).toEqual([false, true]);
	});

	test('let go, as the start moves past a page\'s staple, of what the peer sent before it, and keep what the node held', function() {
		const named = new NamedStaples();
		const held = stapleNamed('held');
		const earlier = stapleNamed('earlier-page');
		const page = staplesNamed('page', 4);
		named.hold([held]);
		named.receive([earlier]);
		named.moveOn(page, 2);
		expect([held, earlier, ...page].map(function(staple): boolean {
			return(named.names(staple));
		})).toEqual([true, false, false, false, true, true]);
	});

	test('keep everything the peer sent when the start moves no further than a page\'s first staple', function() {
		const named = new NamedStaples();
		const earlier = stapleNamed('earlier-page');
		const page = staplesNamed('page', 2);
		named.receive([earlier]);
		named.moveOn(page, 0);
		expect([earlier, ...page].map(function(staple): boolean {
			return(named.names(staple));
		})).toEqual([true, true, true]);
	});

	test('keep a full filter, and so its request, within the URL the client allows', function() {
		const named = new NamedStaples();
		named.hold(staplesNamed('held', BLOOM_CAPACITY));
		const url = pageURL({ endpoint: 'https://representative-with-a-long-name.example.keeta.network:65535/api', start: new Date(), limit: 1000, bloomFilter: named.serialize(2 ** 31 - 1) });
		expect(url.toString().length).toBeLessThanOrEqual(CLIENT_URL_LIMIT);
	});

	test('make a filter with the seed given, so that a staple named by mistake once is not named by mistake every time', function() {
		const named = new NamedStaples();
		named.hold([stapleNamed('held')]);
		expect([filterOf(named, 7).seed, filterOf(named, 8).seed]).toEqual([7, 8]);
	});
});
