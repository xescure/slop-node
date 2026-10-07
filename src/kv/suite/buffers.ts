import { createHash } from 'node:crypto';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { BufferStorage } from '@keetanetwork/keetanet-client/lib/utils/buffer.js';
import { describe, expect, test } from 'vitest';
import { useStores } from './support.js';
import type { KVProviderUnderTest } from './types.js';

const BufferStorageClass = KeetaNet.lib.Utils.Buffer.BufferStorage;

const HASH_LENGTH = 32;

/*
 * Upstream's own fold data is not in the package, only its type, so these
 * sixteen values come from fixed seeds, and the fold below was computed from
 * them independently of any store.
 */
const FOLDED_VALUES: readonly string[] = Array.from({ length: 16 }, function(_ignored, index) {
	return(createHash('sha256').update(`kv-xor-${String(index)}`).digest('hex').toUpperCase());
});
const FOLDED_VALUES_XOR = '665328F061F92F0E511D66C5096A56654F76F68ACD64ED45A4D56A7A7380B444';

const bufferOf = function(hex: string): BufferStorage {
	return(new BufferStorageClass(hex, hex.length / 2));
};

export function defineBufferCases(provider: KVProviderUnderTest): void {
	describe('buffers', function() {
		const openStore = useStores(provider);

		test('xor folds values into a buffer key of the null arena, in any order', async function() {
			const store = await openStore();
			for (const value of FOLDED_VALUES) {
				await store.xor(null, '@buffer:forward', bufferOf(value));
			}
			await Promise.all(Array.from(FOLDED_VALUES).reverse().map(function(value) {
				return(store.xor(null, '@buffer:concurrent', bufferOf(value)));
			}));

			expect(await store.get(null, '@buffer:forward')).toBe(FOLDED_VALUES_XOR);
			expect(await store.get(null, '@buffer:concurrent')).toBe(FOLDED_VALUES_XOR);
		});

		test('xor of a value with itself leaves zeros of its length', async function() {
			const store = await openStore();
			const value = requireValue(FOLDED_VALUES[0]);
			await store.xor(null, '@buffer:twice', bufferOf(value));
			await store.xor(null, '@buffer:twice', bufferOf(value));

			expect(await store.get(null, '@buffer:twice')).toBe('00'.repeat(HASH_LENGTH));
		});

		test('xor aligns values of different lengths at their last byte, and keeps the longer length', async function() {
			const store = await openStore();
			await store.xor(null, '@buffer:mixed', bufferOf('1234'));
			await store.xor(null, '@buffer:mixed', bufferOf('01'));

			expect(await store.get(null, '@buffer:mixed')).toBe('1235');

			await store.xor(null, '@buffer:mixed', bufferOf('010000'));

			expect(await store.get(null, '@buffer:mixed')).toBe('011235');
		});

		test('xor refuses a key that does not begin with @buffer:', async function() {
			const store = await openStore();

			await expect(store.xor(null, 'ledgerChecksum', bufferOf('01'))).rejects.toThrow('Key provided for XOR must begin with "@buffer"');
			expect(await store.get(null, 'ledgerChecksum')).toBeUndefined();
		});

		test('a buffer key lives in the null arena only', async function() {
			const store = await openStore();
			await store.xor(null, '@buffer:checksum', bufferOf('0F'));
			await store.set('stats', '@buffer:checksum', 'named');

			expect(await store.get(null, '@buffer:checksum')).toBe('0F');
			expect(await store.get('stats', '@buffer:checksum')).toBe('named');
			expect(await store.get(null, '@buffer:absent')).toBeUndefined();
		});

		test('upstream statistics keep their counters and checksums in the store', async function() {
			const store = await openStore();
			const writer = new KeetaNet.lib.Stats({ kv: store });
			writer.incr('ledger', 'blocks', 2);
			writer.incr('ledger', 'blocks', 3);
			for (const value of FOLDED_VALUES) {
				writer.xor('ledgerChecksum', bufferOf(value));
			}
			await writer.sync();

			const reader = new KeetaNet.lib.Stats({ kv: store });

			expect(await reader.get('ledger', 'blocks')).toBe(5);
			expect((await reader.getXor('ledgerChecksum')).toString('hex')).toBe(FOLDED_VALUES_XOR);
		});
	});
}

function requireValue(value: string | undefined): string {
	if (value === undefined) {
		throw(new Error('a folded value expected'));
	}
	return(value);
}
