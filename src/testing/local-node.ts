import { afterEach, vi } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { LogEntry, LogEntryFilled, LogTarget } from '@keetanetwork/keetanet-client/lib/log/common.js';
import type { NodeConfig } from '@keetanetwork/keetanet-client/lib/node/index.js';
import type { LocalNode as DeclaredLocalNode, LocalNodeConfig } from '@keetanetwork/keetanet-client/lib/node/local.js';
import type { LedgerStorageDriverBase } from '../ledger/storage/base.js';
import { driverUnderTestNamed } from '../ledger/storage/suite/drivers.js';
import { GENESIS_MOMENT, requireAt } from '../ledger/storage/suite/support.js';
import type { DriverUnderTest } from '../ledger/storage/suite/types.js';
import { bootstrapFrom } from '../node/bootstrap-peers.js';
import { LocalNode } from '../node/local.js';
import type { LimitedLocalNodeConfig } from '../node/local.js';
import type { PeerLimits } from '../node/peer-limits.js';
import { assertNever } from '../util/assert-never.js';
import { createTestNetwork, freezeClock } from './network.js';
import type { TestFeePolicy, TestLedgerOptions, TestNetwork } from './network.js';

const lib = KeetaNet.lib;

const LOOPBACK = '127.0.0.1';

export type LocalNodeOptions = {
	readonly driver?: DriverUnderTest;
	/** Which representative of the network the node votes as; nodes of one test share the network. */
	readonly representative?: number;
	readonly p2p?: NodeConfig['p2p'];
	readonly run?: Parameters<DeclaredLocalNode['run']>[0];
	readonly nodeOptions?: LocalNodeConfig['nodeOptions'];
	readonly endpoints?: LocalNodeConfig['endpoints'];
	readonly fee?: TestFeePolicy;
	readonly representativeWeights?: readonly bigint[];
	readonly ledgerWriteMode?: TestLedgerOptions['ledgerWriteMode'];
	/** Whether the node starts holding genesis, as it does unless told otherwise, or must bootstrap it. */
	readonly genesis?: 'held' | 'absent';
	readonly bootstrap?: LocalNodeConfig['bootstrap'];
	/** API endpoints the node bootstraps from besides the peers it knows. */
	readonly bootstrapFrom?: readonly string[];
	/** The node's own defaults unless given. */
	readonly peerLimits?: PeerLimits;
	/** Whether the node's log entries are kept, as they are unless told otherwise; each holds whatever was logged, until the test ends. */
	readonly captureLogs?: boolean;
};

/** A representative node of a test network, holding genesis, as built before it runs. */
export type CreatedLocalNode = {
	readonly node: LocalNode;
	readonly network: TestNetwork;
	readonly storage: LedgerStorageDriverBase;
	/** Every log entry the node emitted, once it has synced. */
	readonly logs: readonly LogEntry[];
};

export type RunningLocalNode = CreatedLocalNode & {
	/** Where the API is served, with no trailing slash. */
	readonly apiURL: string;
};

export type LocalNodes = {
	/** A representative of the network, 0 unless chosen; the clock is frozen at genesis. */
	readonly create: (options?: LocalNodeOptions) => Promise<CreatedLocalNode>;
	/** The same node, listening on a port of the loopback interface. */
	readonly start: (options?: LocalNodeOptions) => Promise<RunningLocalNode>;
};

function capturingTarget(logs: LogEntry[]): LogTarget {
	return({
		logLevel: 'ALL',
		filter: null,
		emitLogs: function(entries: (LogEntry | LogEntryFilled)[]): Promise<void> {
			logs.push(...entries);
			return(Promise.resolve());
		}
	});
}

function droppingTarget(): LogTarget {
	return({
		logLevel: 'ALL',
		filter: null,
		emitLogs: function(): Promise<void> {
			return(Promise.resolve());
		}
	});
}

function apiURLOf(node: LocalNode): string {
	const advertised = node.config.endpoints?.api;
	if (advertised === undefined) {
		throw(new Error('the node advertises no API endpoint'));
	}
	return(advertised.replace(/\/$/, ''));
}

/**
 * Nodes for one test file, each stopped and its storage destroyed after the
 * test that made it, with mocks and the clock restored.
 */
export function useLocalNodes(): LocalNodes {
	const made: { readonly node: LocalNode; readonly driver: DriverUnderTest; readonly storage: LedgerStorageDriverBase }[] = [];

	afterEach(async function() {
		vi.restoreAllMocks();
		for (const { node, driver, storage } of made.splice(0)) {
			await node.stop();
			await driver.destroy(storage);
		}
		vi.useRealTimers();
	});

	async function create(options: LocalNodeOptions = {}): Promise<CreatedLocalNode> {
		const driver = options.driver ?? driverUnderTestNamed('memory');
		freezeClock(GENESIS_MOMENT);
		const network = await createTestNetwork({ representativeWeights: options.representativeWeights ?? [1000n] });
		const storage = await driver.create();
		const logs: LogEntry[] = [];
		const log = new lib.Log();
		// A log without a target keeps its entries for one to come, so those dropped still need one.
		if (options.captureLogs === false) {
			log.registerTarget(droppingTarget());
		} else {
			log.registerTarget(capturingTarget(logs));
		}
		const ledgerOptions: { -readonly [Option in keyof TestLedgerOptions]: TestLedgerOptions[Option] } = {};
		if (options.fee !== undefined) {
			ledgerOptions.fee = options.fee;
		}
		if (options.ledgerWriteMode !== undefined) {
			ledgerOptions.ledgerWriteMode = options.ledgerWriteMode;
		}
		const config: LimitedLocalNodeConfig = {
			...network.nodeConfig(storage, requireAt(network.representatives, options.representative ?? 0), ledgerOptions),
			log,
			nodeOptions: { listenIP: LOOPBACK, listenPort: 0, ...options.nodeOptions }
		};
		if (options.endpoints !== undefined) {
			config.endpoints = { ...options.endpoints };
		}
		if (options.p2p !== undefined) {
			config.p2p = options.p2p;
		}
		if (options.bootstrap !== undefined) {
			config.bootstrap = options.bootstrap;
		}
		if (options.peerLimits !== undefined) {
			config.peerLimits = options.peerLimits;
		}
		bootstrapFrom(config, options.bootstrapFrom ?? []);
		const node = new LocalNode(config);
		made.push({ node, driver, storage });
		const genesis = options.genesis ?? 'held';
		switch (genesis) {
			case 'held':
				await node.ledger.add(network.genesis);
				break;
			case 'absent':
				break;
			default:
				assertNever(genesis);
		}
		return({ node, network, storage, logs });
	}

	async function start(options: LocalNodeOptions = {}): Promise<RunningLocalNode> {
		const created = await create(options);
		await created.node.run(options.run);
		return({ ...created, apiURL: apiURLOf(created.node) });
	}

	return({ create, start });
}

/** An HTTP answer, its body parsed when it is JSON. */
export type HTTPAnswer = {
	readonly status: number;
	readonly contentType: string | null;
	readonly text: string;
	readonly body: unknown;
};

export async function request(running: Pick<RunningLocalNode, 'apiURL'>, path: string, init: RequestInit = {}): Promise<HTTPAnswer> {
	const response = await fetch(`${running.apiURL}${path}`, init);
	const text = await response.text();
	let body: unknown = undefined;
	if (response.headers.get('content-type')?.startsWith('application/json') === true) {
		body = JSON.parse(text);
	}
	return({ status: response.status, contentType: response.headers.get('content-type'), text, body });
}

/** A POST of a JSON body, as the client sends one [Keeta TS] index.js:60582-60585, 60610-60618; upstream's client also sends `accept: application/vnd.keeta.binary+json`, which our node does not negotiate. */
export function postJSON(running: Pick<RunningLocalNode, 'apiURL'>, path: string, body: unknown): Promise<HTTPAnswer> {
	return(request(running, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
