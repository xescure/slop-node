import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { describe, expect, inject, onTestFinished, test } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import pg from 'pg';
import { GENESIS_VARIABLES, NODE_VARIABLES, TRUSTED_ACCOUNT_VARIABLE } from './node/config.js';
import type { Environment } from './node/config.js';
import { API_LINE, PEER_LINE, startCLI } from './testing/cli.js';
import { endpointOf, RECEIVER, STORAGES_UNDER_TEST, SUPPLY, TRUSTED_SIGNER, useSDKNodes } from './testing/sdk.js';
import type { StorageUnderTest } from './testing/sdk.js';
import { createDatabase } from './testing/postgres.js';
import { deriveTestKeys, TEST_NETWORK_SEEDS } from './testing/network.js';
import { startSilentPeer } from './testing/silent-peer.js';
import { assertNever } from './util/assert-never.js';
import { NODE_VERSION } from './version.js';

const lib = KeetaNet.lib;

const keys = deriveTestKeys(TEST_NETWORK_SEEDS, 1);
const TRUSTED = keys.trustedRoot.publicKeyString.get();

const NODE: Environment = {
	KEETANET_LOCAL_NODE_SEED: TEST_NETWORK_SEEDS.representative,
	KEETANET_INITIAL_TRUSTED_ACCOUNT: TRUSTED,
	KEETANET_LOCAL_NODE_LISTEN_PORT: '0'
};

const GENESIS: Environment = {
	KEETANET_GENESIS_TRUSTED_SEED: TEST_NETWORK_SEEDS.trustedRoot,
	KEETANET_GENESIS_SUPPLY: '1000000'
};

async function getJSON(url: string): Promise<unknown> {
	const response = await fetch(url);
	expect(response.status).toBe(200);
	return(await response.json());
}

async function createTestDatabaseURL(): Promise<string> {
	const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
	onTestFinished(function() {
		return(database.drop());
	});
	return(database.connectionString);
}

describe('slop-node run', function() {
	test.each(['SIGTERM', 'SIGINT'] as const)('serves the API from memory until %s, then exits cleanly', async function(signal) {
		const cli = startCLI(['run'], NODE);
		const [, api] = await cli.printed(API_LINE);
		expect(await getJSON(`${api ?? ''}/node/version`)).toEqual({ node: NODE_VERSION });
		cli.signal(signal);
		expect(await cli.exited).toEqual({ code: 0, signal: null });
		expect(cli.stderr()).toContain('the ledger is kept in memory, so it is lost when the node stops');
	});

	test('names what it serves', async function() {
		const cli = startCLI(['run'], NODE);
		await cli.printed(API_LINE);
		cli.signal('SIGTERM');
		await cli.exited;
		expect(cli.stdout()).toContain(`representative: ${lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 0).publicKeyString.get()}\n`);
		expect(cli.stdout()).toContain('network: local (0)\n');
		expect(cli.stdout()).toContain('storage: memory\n');
	});

	test.each(['main', 'test'] as const)('refuses to vote on the %s network before it starts', async function(network) {
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_NETWORK: network });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stdout()).toBe('');
		expect(cli.stderr()).toContain(`the ${network} network is public, so the node may only follow it`);
	});

	test('refuses a configuration it cannot read, naming the variable', async function() {
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_LISTEN_PORT: 'eighty' });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain('KEETANET_LOCAL_NODE_LISTEN_PORT');
	});
});

/** Lines the switch logs, and nothing else, so that a test can wait for what it does. */
const SWITCH_LOG: Environment = { KEETANET_LOCAL_NODE_LOG_LEVEL: 'DEBUG', KEETANET_LOCAL_NODE_LOG_FILTER: '^P2P$' };

describe('slop-node run with peers', function() {
	const nodes = useSDKNodes();

	async function storageEnvironment(storage: StorageUnderTest): Promise<Environment> {
		switch (storage) {
			case 'memory':
				return({});
			case 'postgres':
				return({ KEETANET_LOCAL_NODE_POSTGRES_URL: (await nodes.database()).connectionString });
			default:
				return(assertNever(storage));
		}
	}

	test.each(STORAGES_UNDER_TEST)('peers two nodes configured by their environment alone, on %s, so that a staple published to one applies on the other', async function(storage) {
		const first = startCLI(['run'], { ...NODE, ...await storageEnvironment(storage) });
		const [, firstAPI = ''] = await first.printed(API_LINE);
		const [, firstPeer = ''] = await first.printed(PEER_LINE);
		const firstKey = lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 0).publicKeyString.get();
		expect(firstPeer.startsWith(`${firstKey}@${firstAPI}|`)).toBe(true);

		const secondRepresentative = lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 1);
		const second = startCLI(['run'], { ...NODE, ...await storageEnvironment(storage), ...SWITCH_LOG, KEETANET_LOCAL_NODE_SEED_INDEX: '1', KEETANET_LOCAL_NODE_MANUAL_PEERS: firstPeer });
		const [, secondAPI = ''] = await second.printed(API_LINE);
		expect(second.stdout()).toContain('manual peers: 1\n');
		// The switch records the peer it dialed once the peer has greeted it [Keeta TS] index.js:73642-73645.
		await second.printed(new RegExp(`Added knownPeer: ${firstKey}$`, 'm'));

		const holder = nodes.userClient(endpointOf(firstAPI, lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 0)), TRUSTED_SIGNER);
		const initialized = await holder.initializeNetwork({ addSupplyAmount: SUPPLY });
		expect(initialized.publish).toBe(true);
		/*
		 * A node weighs a staple's votes before it would defer it
		 * [Keeta TS] index.js:69396-69401, and the weight that votes for the
		 * send is the weight genesis delegates. A node still adding genesis
		 * refuses the send, which then reaches it only by its next bootstrap,
		 * a minute later, so the send waits until genesis is added there.
		 */
		await second.printed(new RegExp(`\\[${initialized.voteStaple.blocksHash.toString()}\\] Sending message add`));
		const sent = await holder.send(RECEIVER, 100n, holder.baseToken);
		if (sent.from !== 'direct') {
			throw(new Error('the client published through a publish aid'));
		}
		// A node passes a staple on to its own peers once it has added it [Keeta TS] index.js:71409-71435, 71460-71463, 73009-73010.
		await second.printed(new RegExp(`\\[${sent.voteStaple.blocksHash.toString()}\\] Sending message add`));
		const observer = nodes.userClient(endpointOf(secondAPI, secondRepresentative), null);
		expect(await observer.client.getBalance(RECEIVER, holder.baseToken)).toBe(100n);

		second.signal('SIGTERM');
		first.signal('SIGTERM');
		expect(await second.exited).toEqual({ code: 0, signal: null });
		expect(await first.exited).toEqual({ code: 0, signal: null });
	});

	/*
	 * The switch keeps its peers in its store [Keeta TS] index.js:72626-72633, 73451,
	 * and dials and broadcasts to them whatever the environment names
	 * [Keeta TS] index.js:72519-72620, 73250-73306.
	 */
	test('refuses to vote on dev with the peers it remembers from following it, until they are cleared', async function() {
		const port = await closedPort();
		const peerKey = lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 1).publicKeyString.get();
		const dev: Environment = { ...NODE, KEETANET_LOCAL_NODE_NETWORK: 'dev', KEETANET_LOCAL_NODE_POSTGRES_URL: (await nodes.database()).connectionString };

		const following = startCLI(['run'], { ...dev, KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only', KEETANET_LOCAL_NODE_MANUAL_PEERS: `${peerKey}@http://127.0.0.1:${String(port)}/api|ws://127.0.0.1:${String(port)}/p2p` });
		await following.printed(PEER_LINE);
		following.signal('SIGTERM');
		expect(await following.exited).toEqual({ code: 0, signal: null });

		const voting = startCLI(['run'], dev);
		expect(await voting.exited).toEqual({ code: 1, signal: null });
		expect(voting.stdout()).toBe('');
		expect(voting.stderr()).toBe('slop-node: the dev network is Keeta\'s, and the store of KEETANET_LOCAL_NODE_POSTGRES_URL remembers peers (in lastSeenPeers, manualPeerCheckIn), which the node would reach even without KEETANET_LOCAL_NODE_MANUAL_PEERS: run "slop-node clear-peers" with the same environment to forget them, or set KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE to read-only or bootstrap-only (it is read-write)\n');

		const clearing = startCLI(['clear-peers'], dev);
		expect(await clearing.exited).toEqual({ code: 0, signal: null });
		expect(clearing.stdout()).toBe('cleared knownPeers: 0\ncleared potentialPeers: 0\ncleared lastSeenPeers: 1\ncleared connectedPeers: 0\ncleared manualPeerCheckIn: 1\ncleared messageFilters: 0\n');

		const cleared = startCLI(['run'], dev);
		await cleared.printed(API_LINE);
		expect(cleared.stdout()).toContain('network: dev (');
		cleared.signal('SIGTERM');
		expect(await cleared.exited).toEqual({ code: 0, signal: null });
	});

	test('clears no peers in memory, where none are kept', async function() {
		const cli = startCLI(['clear-peers'], NODE);
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toBe('slop-node: clear-peers needs KEETANET_LOCAL_NODE_POSTGRES_URL: a node in memory forgets its peers when it stops\n');
	});

	/* Stopping waits for a dial, which waits for the peer's greeting [Keeta TS] index.js:72145-72156, 71373-71376. */
	test('stops cleanly on SIGTERM while a peer it dialed has not greeted it', async function() {
		const peer = await startSilentPeer(lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 1));
		const cli = startCLI(['run'], { ...NODE, ...await storageEnvironment('postgres'), KEETANET_LOCAL_NODE_MANUAL_PEERS: peer.setting });
		await cli.printed(PEER_LINE);
		await peer.greeted;
		cli.signal('SIGTERM');
		expect(await cli.exited).toEqual({ code: 0, signal: null });
		expect(cli.stderr()).toBe('');
	});

	test('refuses peers named automatically', async function() {
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_MANUAL_PEERS: 'auto' });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toBe('slop-node: KEETANET_LOCAL_NODE_MANUAL_PEERS=auto is not supported: this node finds no peers by itself, so list each as <keeta_ account>@<api URL>|<p2p URL>[|http or websocket[|signature]]\n');
	});
});

/** A port nothing listens on: one the system just handed out and took back. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>(function(resolve) {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	await new Promise<void>(function(resolve) {
		server.close(function() {
			resolve();
		});
	});
	if (address === null || typeof address === 'string') {
		throw(new Error('the test server has no port'));
	}
	return(address.port);
}

/** A port held by a listener until the test ends. */
async function heldPort(): Promise<number> {
	const server: Server = createServer();
	await new Promise<void>(function(resolve) {
		server.listen(0, '127.0.0.1', resolve);
	});
	onTestFinished(function() {
		return(new Promise<void>(function(resolve) {
			server.close(function() {
				resolve();
			});
		}));
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('the test server has no port'));
	}
	return(address.port);
}

/** A line of a stack. */
const STACK_FRAME = /^\s+at /m;

describe('slop-node when its surroundings fail', function() {
	test.each(['run', 'genesis'])('%s names a Postgres it cannot reach in one line, without the password', async function(command) {
		const port = await closedPort();
		const environment: Environment = {
			...NODE,
			...GENESIS,
			KEETANET_LOCAL_NODE_POSTGRES_URL: `postgresql://slop:hunter2@127.0.0.1:${String(port)}/ledger`
		};
		const cli = startCLI([command], environment);
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toBe(`slop-node: cannot reach Postgres at 127.0.0.1:${String(port)}\n`);
	});

	test('names a port that is in use in one line', async function() {
		const port = await heldPort();
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_LISTEN_PORT: String(port) });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain(`slop-node: port ${String(port)} in use\n`);
		expect(cli.stderr()).not.toMatch(STACK_FRAME);
	});

	test('gives the migration\'s own message when the database was migrated by a newer node', async function() {
		const database = await createDatabase(inject('postgresCluster'), inject('postgresLedgerTemplate'));
		onTestFinished(function() {
			return(database.drop());
		});
		await database.pool().query('INSERT INTO schema_version (version, sha256, applied_at) VALUES (99, decode(repeat(\'00\', 32), \'hex\'), now())');
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_POSTGRES_URL: database.connectionString });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toMatch(/^slop-node: the database is at schema version 99, newer than the newest this build knows, \d+\n$/);
	});

	test.each(['DEBUG', 'debug', 'ALL'])('adds the stack to that line at the log level %s', async function(level) {
		const port = await heldPort();
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_LISTEN_PORT: String(port), KEETANET_LOCAL_NODE_LOG_LEVEL: level });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain(`slop-node: port ${String(port)} in use\n`);
		expect(cli.stderr()).toMatch(STACK_FRAME);
	});

	test('keeps a configuration refusal to one line', async function() {
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_LISTEN_PORT: 'eighty', KEETANET_LOCAL_NODE_LOG_LEVEL: 'INFO' });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr().trimEnd().split('\n')).toHaveLength(1);
	});
});

/** A representative's manual peer that nothing listens for. */
async function unreachablePeer(): Promise<string> {
	const port = await closedPort();
	const key = lib.Account.fromSeed(TEST_NETWORK_SEEDS.representative, 1).publicKeyString.get();
	return(`${key}@http://127.0.0.1:${String(port)}/api|ws://127.0.0.1:${String(port)}/p2p`);
}

/**
 * Node.js options that load, before the command, a module that makes a
 * promise rejection nothing handles as the node's HTTP server starts
 * listening or closing. Listening is delayed by a turn of the event loop, so
 * that Node.js has dealt with the rejection before the node listens.
 */
type ServerMoment = 'listen' | 'close';

const CALL_THROUGH: Readonly<Record<ServerMoment, string>> = {
	listen: 'setImmediate(() => original.apply(this, input)); return(this);',
	close: 'return(original.apply(this, input));'
};

function rejectingAt(moment: ServerMoment): Environment {
	const source = [
		'import http from "node:http";',
		`const original = http.Server.prototype.${moment};`,
		`http.Server.prototype.${moment} = function(...input) {`,
		`	Promise.reject(new Error("a rejection nothing handles, at ${moment}"));`,
		`	${CALL_THROUGH[moment]}`,
		'};'
	].join('\n');
	return({ NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(source)}` });
}

describe('slop-node and failures nothing handles', function() {
	/* The switch checks in with a manual peer as the node runs, writing to the store without waiting for the write [Keeta TS] index.js:72622-72658. */
	test('logs one in background work under an error ID while it serves, and carries on serving', async function() {
		const url = await createTestDatabaseURL();
		const pool = new pg.Pool({ connectionString: url });
		onTestFinished(function() {
			return(pool.end());
		});
		await pool.query(`CREATE FUNCTION refuse_check_ins() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'check-ins are refused'; END $$`);
		await pool.query('CREATE TRIGGER refuse_check_ins BEFORE INSERT OR UPDATE ON kv_entries FOR EACH ROW WHEN (NEW.arena = \'manualPeerCheckIn\') EXECUTE FUNCTION refuse_check_ins()');
		const cli = startCLI(['run'], { ...NODE, KEETANET_LOCAL_NODE_POSTGRES_URL: url, KEETANET_LOCAL_NODE_MANUAL_PEERS: await unreachablePeer() });
		const [, api] = await cli.printed(API_LINE);

		const [line, errorID] = await cli.printed(/^\[([0-9a-f-]{36})\] ERROR node: Background work failed, and the node carries on \(error ID: \1\):.*$/m, 'stderr');
		expect(cli.stderr()).toContain('check-ins are refused');
		expect(line).toContain(errorID);
		expect(await getJSON(`${api ?? ''}/node/version`)).toEqual({ node: NODE_VERSION });

		cli.signal('SIGTERM');
		expect(await cli.exited).toEqual({ code: 0, signal: null });
		expect(cli.stderr()).not.toContain('Warning');
	});

	test('ends with status 1 on one while it starts, before it listens', async function() {
		const cli = startCLI(['run'], { ...NODE, ...rejectingAt('listen') });

		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stdout()).not.toMatch(API_LINE);
		expect(cli.stderr()).toContain('a rejection nothing handles, at listen');
	});

	test('ends with status 1 on one while it stops', async function() {
		const cli = startCLI(['run'], { ...NODE, ...rejectingAt('close') });
		await cli.printed(PEER_LINE);

		cli.signal('SIGTERM');

		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain('a rejection nothing handles, at close');
	});
});

describe('slop-node reindex-history', function() {
	test('lists the ledger in Postgres anew, a ledger this build wrote unchanged', async function() {
		const environment: Environment = { ...NODE, KEETANET_LOCAL_NODE_POSTGRES_URL: await createTestDatabaseURL() };
		const genesis = startCLI(['genesis'], { ...environment, ...GENESIS });
		expect(await genesis.exited).toEqual({ code: 0, signal: null });

		const cli = startCLI(['reindex-history'], environment);
		expect(await cli.exited).toEqual({ code: 0, signal: null });
		expect(cli.stdout()).toBe('reindexed 1 staples: 0 history entries removed, 0 added\ndone: 1 staples, 0 history entries removed, 0 added\n');
	});

	test('is refused in memory', async function() {
		const cli = startCLI(['reindex-history'], NODE);
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toBe('slop-node: reindex-history needs KEETANET_LOCAL_NODE_POSTGRES_URL: a node in memory writes its history anew each time it starts\n');
	});
});

describe('slop-node genesis', function() {
	test('creates the network in Postgres, where the node then serves it', async function() {
		const environment: Environment = { ...NODE, KEETANET_LOCAL_NODE_POSTGRES_URL: await createTestDatabaseURL() };
		const genesis = startCLI(['genesis'], { ...environment, ...GENESIS });
		expect(await genesis.exited).toEqual({ code: 0, signal: null });
		expect(genesis.stdout()).toMatch(/^genesis: [0-9A-F]{64}$/m);

		const run = startCLI(['run'], environment);
		const [, api] = await run.printed(API_LINE);
		const { baseToken } = lib.Account.generateBaseAddresses(0n);
		const balance = await getJSON(`${api ?? ''}/node/ledger/account/${TRUSTED}/balance/${baseToken.publicKeyString.get()}`);
		expect(balance).toMatchObject({ balance: lib.Utils.Conversion.toJSONSerializable(1000000n) });
		expect(run.stdout()).toContain('storage: postgres\n');
		expect(run.stderr()).not.toContain('memory');
		run.signal('SIGTERM');
		expect(await run.exited).toEqual({ code: 0, signal: null });

		const again = startCLI(['genesis'], { ...environment, ...GENESIS });
		expect(await again.exited).toEqual({ code: 1, signal: null });
		expect(again.stderr()).toContain('the network already has its genesis');
	});

	test('is refused in memory', async function() {
		const cli = startCLI(['genesis'], { ...NODE, ...GENESIS });
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain('genesis needs KEETANET_LOCAL_NODE_POSTGRES_URL');
	});

	test.each(['main', 'test'] as const)('is refused on the %s network', async function(network) {
		const environment: Environment = {
			...NODE,
			...GENESIS,
			KEETANET_LOCAL_NODE_NETWORK: network,
			KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE: 'read-only',
			KEETANET_LOCAL_NODE_POSTGRES_URL: 'postgresql://slop@db.invalid/ledger'
		};
		const cli = startCLI(['genesis'], environment);
		expect(await cli.exited).toEqual({ code: 1, signal: null });
		expect(cli.stderr()).toContain(`the ${network} network is public and already has its genesis`);
	});
});

describe('slop-node', function() {
	test.each(['help', '--help', '-h'])('explains itself when asked with %j', async function(argument) {
		const cli = startCLI([argument], {});
		expect(await cli.exited).toEqual({ code: 0, signal: null });
		expect(cli.stdout()).toContain('Usage: slop-node <command>');
		expect(cli.stdout()).toContain('KEETANET_LOCAL_NODE_POSTGRES_URL');
		expect(cli.stdout()).toContain('KEETANET_GENESIS_TRUSTED_SEED');
	});

	test('describes every variable it reads in its help', async function() {
		const cli = startCLI(['--help'], {});
		expect(await cli.exited).toEqual({ code: 0, signal: null });
		for (const variable of [...NODE_VARIABLES, TRUSTED_ACCOUNT_VARIABLE, ...GENESIS_VARIABLES]) {
			expect(cli.stdout()).toMatch(new RegExp(`^  ${variable} +\\S`, 'm'));
		}
	});

	test.each([[[]], [['serve']], [['run', 'now']]])('refuses the arguments %j with its usage', async function(args) {
		const cli = startCLI(args, NODE);
		expect(await cli.exited).toEqual({ code: 2, signal: null });
		expect(cli.stderr()).toContain('Usage: slop-node <command>');
	});
});
