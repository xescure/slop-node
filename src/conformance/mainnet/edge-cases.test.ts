import { afterEach, describe, expect, test, vi } from 'vitest';
import type { VoteStaple } from '@keetanetwork/keetanet-client/lib/vote.js';
import { MemoryLedgerStorage } from '../../ledger/storage/memory/driver.js';
import { addEdgeCases, renderEdgeCaseOutcomes } from './edge-cases.js';
import type { EdgeCaseOutcome } from './edge-cases.js';
import { loadMainnetFixture } from './fixture.js';
import { replayMainnet, replayOrder } from './replay.js';

/*
 * Parsing the head and replaying 300 of its staples took about 5 s on an idle
 * machine; the limit leaves room for a machine many times slower, and for
 * make -j8 running everything else beside it.
 */
const REPLAY_TIMEOUT_MILLISECONDS = 240_000;

function requireStaple(staples: readonly VoteStaple[], index: number): VoteStaple {
	const staple = staples[index];
	if (staple === undefined) {
		throw(new Error(`the head has no staple ${String(index)}`));
	}
	return(staple);
}

function blockHashesOf(staple: VoteStaple): string[] {
	return(staple.blocks.map(function(block): string {
		return(block.hash.toString());
	}).sort());
}

describe('edge-case staples added after a replay', function() {
	afterEach(function() {
		vi.useRealTimers();
	});

	test('each is recorded as applied, deferred with the blocks it waits on, or refused with the ledger\'s code, in replay order', { timeout: REPLAY_TIMEOUT_MILLISECONDS }, async function() {
		const ordered = replayOrder(await loadMainnetFixture('head'));
		const storage = new MemoryLedgerStorage();
		const { ledger } = await replayMainnet(storage, ordered.slice(0, 300));
		const withheld = requireStaple(ordered, 300);
		const waitingOnWithheld = requireStaple(ordered, 301);
		const independent = requireStaple(ordered, 302);
		const waitingOnDeferred = requireStaple(ordered, 303);
		const genesis = requireStaple(ordered, 0);

		const outcomes = await addEdgeCases(storage, ledger, [waitingOnDeferred, independent, waitingOnWithheld, genesis]);

		expect(outcomes).toEqual([
			{ blocksHash: genesis.blocksHash.toString(), outcome: 'refused', code: 'LEDGER_INSUFFICIENT_VOTING_WEIGHT', message: 'Votes attached do not represent enough voting power' },
			{ blocksHash: waitingOnWithheld.blocksHash.toString(), outcome: 'deferred', waitingOn: blockHashesOf(withheld) },
			{ blocksHash: independent.blocksHash.toString(), outcome: 'applied' },
			{ blocksHash: waitingOnDeferred.blocksHash.toString(), outcome: 'deferred', waitingOn: blockHashesOf(waitingOnWithheld) }
		]);
	});
});

describe('the edge-case outcomes file', function() {
	test('maps each staple\'s blocks hash, in code-point order, to its outcome', function() {
		const outcomes: (EdgeCaseOutcome & { readonly blocksHash: string })[] = [
			{ blocksHash: 'C0', outcome: 'refused', code: 'LEDGER_INVALID_PERMISSIONS', message: 'no' },
			{ blocksHash: 'B0', outcome: 'deferred', waitingOn: ['01', '02'] },
			{ blocksHash: '0A', outcome: 'applied' }
		];

		expect(renderEdgeCaseOutcomes(outcomes)).toBe([
			'{',
			'  "0A": {',
			'    "outcome": "applied"',
			'  },',
			'  "B0": {',
			'    "outcome": "deferred",',
			'    "waitingOn": [',
			'      "01",',
			'      "02"',
			'    ]',
			'  },',
			'  "C0": {',
			'    "outcome": "refused",',
			'    "code": "LEDGER_INVALID_PERMISSIONS",',
			'    "message": "no"',
			'  }',
			'}',
			''
		].join('\n'));
	});
});
