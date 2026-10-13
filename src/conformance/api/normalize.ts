import { inflateSync } from 'node:zlib';
import { assertNever } from '../../util/assert-never.js';

/**
 * The fields of an answer compared only once normalized, each because two
 * nodes holding the same ledger still answer it differently.
 */
export type Normalization =
	/*
	 * An internal failure is named only by an error ID, drawn afresh for each
	 * failure, so no two answers share one.
	 */
	| 'error-id'
	/*
	 * A representative gives a history entry the time of its own vote in the
	 * staple [Keeta TS] index.js:82213-82239. A node that voted in none of
	 * the staples gives its entries the votes' average.
	 */
	| 'staple-time'
	/*
	 * A staple's "$binary" is its DER compressed with zlib
	 * [Keeta TS] index.js:82168-82179. Compression is not canonical: a node
	 * that rebuilds a staple from its blocks and votes compresses it with
	 * zlib's defaults, while the representative serves the same DER
	 * compressed differently. The DER, which the client inflates and decodes,
	 * is compared byte for byte instead.
	 */
	| 'staple-encoding';

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** The base64 of the zlib header a staple's compressed bytes start with, 78 9C. */
const ZLIB_BASE64_PREFIX = 'eJ';

const ERROR_ID = /^Internal error occurred \(error ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/;

/** The value with each zlib-compressed "$binary" in it, at any depth, replaced by the bytes it inflates to. */
function inflatedStaples(value: unknown): unknown {
	if (Array.isArray(value)) {
		return(value.map(inflatedStaples));
	}
	if (!isFields(value)) {
		return(value);
	}
	const inflated: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(value)) {
		inflated[name] = inflatedStaples(entry);
	}
	const binary = value['$binary'];
	if (typeof binary === 'string' && binary.startsWith(ZLIB_BASE64_PREFIX)) {
		inflated['$binary'] = inflateSync(Buffer.from(binary, 'base64')).toString('base64');
	}
	return(inflated);
}

export function normalized(body: unknown, normalization: Normalization): unknown {
	switch (normalization) {
		case 'error-id': {
			if (isFields(body) && typeof body['message'] === 'string' && ERROR_ID.test(body['message'])) {
				return({ ...body, message: 'Internal error occurred (error ID: <error ID>)' });
			}
			return(body);
		}
		case 'staple-time': {
			if (!isFields(body) || !Array.isArray(body['history'])) {
				return(body);
			}
			return({
				...body,
				history: body['history'].map(function(entry: unknown): unknown {
					if (!isFields(entry)) {
						return(entry);
					}
					return({ ...entry, $timestamp: '<the representative\'s own vote>' });
				})
			});
		}
		case 'staple-encoding':
			return(inflatedStaples(body));
		default:
			return(assertNever(normalization));
	}
}

export function normalizedAll(body: unknown, normalize: readonly Normalization[]): unknown {
	return(normalize.reduce(normalized, body));
}
