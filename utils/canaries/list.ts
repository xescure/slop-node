import type { NamedTest } from './report.js';

/**
 * The fix a canary reverts: a commit of this repository, or a release of
 * upstream's client, whose bundle the canary patches in the clone's copy of
 * node_modules.
 */
export type Fix =
	| { readonly kind: 'commit'; readonly commit: string }
	| { readonly kind: 'release'; readonly version: string };

/** A test that must catch a canary, with the files that give the titles of its name: its own, and the shared suite a file runs. */
export type CanaryTest = NamedTest & {
	readonly titlesIn: readonly string[];
};

/**
 * A scripted revert of a safety fix, utils/canaries/patches/<name>.patch,
 * which must turn every one of its named tests red by assertion.
 */
export type Canary = {
	readonly name: string;
	readonly fix: Fix;
	/** What the patch does to the tree, which the tests must notice. */
	readonly reverts: string;
	readonly catchers: readonly CanaryTest[];
};

export const PATCH_DIRECTORY = 'utils/canaries/patches';

export function patchOf(canary: Canary): string {
	return(`${PATCH_DIRECTORY}/${canary.name}.patch`);
}

/** The test files a canary runs, each once. */
export function testFilesOf(canary: Canary): string[] {
	return([...new Set(canary.catchers.map(function(test): string {
		return(test.file);
	}))]);
}

function commit(hash: string): Fix {
	return({ kind: 'commit', commit: hash });
}

function caughtBy(file: string, ...name: readonly string[]): CanaryTest {
	return({ file, name, titlesIn: [file] });
}

function caughtBySuite(file: string, suite: string, ...name: readonly string[]): CanaryTest {
	return({ file, name, titlesIn: [file, suite] });
}

const DRIVERS = 'src/ledger/storage/drivers.test.ts';

/** Both drivers run the shared suite, each supplying every read the ledger makes. */
function caughtByBothDrivers(suite: string, ...name: readonly string[]): CanaryTest[] {
	return(['\'memory\' driver', '\'postgres\' driver'].map(function(driver): CanaryTest {
		return(caughtBySuite(DRIVERS, suite, driver, ...name));
	}));
}

const P2P = 'src/node/p2p.test.ts';

const CONFIG = 'src/node/config.test.ts';

const PASS = 'src/node/bootstrap-pass.test.ts';

const SIMULATION = 'src/node/bootstrap-simulation.test.ts';

const BOOTSTRAP = 'src/node/bootstrap.test.ts';

const STATS = 'src/node/stats.test.ts';

const POSTGRES_DRIVER = 'src/ledger/storage/postgres/driver.test.ts';

/*
 * Every safety fix since the storage contract, reverted. The three
 * permission bypasses of keetanet-client 0.18.4 are fixed upstream, and
 * this repository holds no part of those fixes: their canaries revert each
 * in the client's bundle, which the storage suite's permission cases must
 * then catch through each driver.
 */
export const CANARIES: readonly Canary[] = [
	{
		name: 'permission-same-staple-self-grant',
		fix: { kind: 'release', version: '0.18.5' },
		reverts: 'a grant satisfies a permission requirement whatever entity and target it is for, so a thief\'s grant to itself on its own account lets it send from the victim\'s',
		catchers: caughtByBothDrivers('src/ledger/storage/suite/canaries.ts', 'permission canaries', 'same-staple self-grant is rejected')
	},
	{
		name: 'permission-subtract-as-grant',
		fix: { kind: 'release', version: '0.18.5' },
		reverts: 'a SUBTRACT of a permission satisfies a requirement for it',
		catchers: caughtByBothDrivers('src/ledger/storage/suite/canaries.ts', 'permission canaries', 'subtract does not satisfy a grant requirement')
	},
	{
		name: 'permission-self-operation-return',
		fix: { kind: 'release', version: '0.18.5' },
		reverts: 'an operation of an account on itself returns from the requirements of its block rather than skip that one, so a token sends itself into a storage account that granted nothing',
		catchers: caughtByBothDrivers('src/ledger/storage/suite/canaries.ts', 'permission canaries', 'token self-send into storage is rejected')
	},
	{
		name: 'http-greeting-unsigned-fields',
		fix: commit('39b9b67'),
		reverts: 'the switch is handed a greeting posted over HTTP as it came, a filter beside the signed advertisement included',
		catchers: [caughtBy(P2P, 'peers over HTTP republish', 'takes from a replayed greeting only what its signature covers, so a filter in it does not keep staples from that representative')]
	},
	{
		name: 'smuggled-inner-greeting',
		fix: commit('09a388e'),
		reverts: 'a greeting posted over HTTP as the message, inside the republished message, reaches the switch',
		catchers: [caughtBy(P2P, 'peers over HTTP republish', 'refuses a greeting as the message from a sender greeting with \'its own key\', so a filter in it does not keep staples from that representative')]
	},
	{
		name: 'voting-on-main-network',
		fix: commit('2baa96f'),
		reverts: 'a node that votes is accepted on main, keeping to itself there as on dev and staging',
		catchers: [
			caughtBy(CONFIG, 'the safety rule', 'applies to the default write mode'),
			caughtBy(CONFIG, 'the safety rule', '\'main\' in \'read-write\' mode, with peers: false'),
			caughtBy(CONFIG, 'the safety rule', 'refuses a node voting on the ID of the main network in every spelling')
		]
	},
	{
		name: 'votes-in-memory',
		fix: commit('2899141'),
		reverts: 'a node votes with peers on test with its ledger in memory, forgetting its votes and their serials each time it stops',
		catchers: [
			caughtBy(CONFIG, 'a node voting in memory', 'is refused on test, by every spelling of its ID'),
			caughtBy(CONFIG, 'a node voting in memory', 'is refused on test in the default write mode, with peers or without')
		]
	},
	{
		name: 'public-network-open-to-followers',
		fix: commit('80095a6'),
		reverts: 'a node only following main or test is open to peers there, as a node that does not vote is',
		catchers: [
			caughtBy(CONFIG, 'the closure of a node\'s network to its peers', 'closes \'main\' in \'bootstrap-only\' mode: true'),
			caughtBy(P2P, 'a node configured from its environment', 'serves no /p2p WebSocket and refuses a message posted over HTTP while it follows \'main\' in \'bootstrap-only\' mode, handing the switch nothing and keeping no peer')
		]
	},
	{
		name: 'remembered-peers',
		fix: commit('8346423'),
		reverts: 'a node starts on a network closed to its peers with the peers its store remembers, which the switch dials',
		catchers: [
			caughtBy('src/node/peer-store.test.ts', 'a node that may not have peers on its network', 'refuses to start on \'dev\' in \'read-write\' mode when \'knownPeers\' remembers a peer'),
			caughtBy('src/node/peer-store.test.ts', 'a node that may not have peers on its network', 'refuses to start following \'main\' in \'bootstrap-only\' mode when \'knownPeers\' remembers a peer, its peer-to-peer surface being closed there')
		]
	},
	{
		name: 'remembered-peers-built-in-code',
		fix: commit('583e98b'),
		reverts: 'a node built in code runs on a network closed to its peers with the peers its store remembers',
		catchers: [
			caughtBy('src/node/local.test.ts', 'a node built in code on main', 'refuses to run in bootstrap-only mode with peers its store remembers'),
			caughtBy('src/node/local.test.ts', 'a node built in code on main', 'refuses to run in read-write mode with peers its store remembers')
		]
	},
	{
		name: 'bootstrap-short-page-drains',
		fix: commit('189ebc6'),
		reverts: 'a pass ends drained on a short page, which a peer answers when it caps the limit or its time runs out',
		catchers: [
			caughtBy(PASS, 'a pass over a peer', 'holds every staple of a peer that caps the limit, whose short pages are not the end'),
			caughtBy(PASS, 'a pass over a peer', 'holds every staple of a peer that runs out of time for a request, whose short pages are not the end')
		]
	},
	{
		name: 'bootstrap-capped-page-whole',
		fix: commit('4615052'),
		reverts: 'a page shorter than the limit asked for counts as listed in full, though the peer may cap the limit below it',
		catchers: [
			caughtBy('src/node/bootstrap-evidence.test.ts', 'what a page shows of how far a peer read', 'a page counts in full only for the reads no limit cut, when it is as long as the longest answer: none of its last read'),
			caughtBy(SIMULATION, 'bootstrapping against a peer keyed by votes, as the main network\'s representatives are', 'holds every staple of a peer that caps the limit below what a read lists')
		]
	},
	{
		name: 'bootstrap-late-votes-undetected',
		fix: commit('4615052'),
		reverts: 'a peer that keys votes later than the tolerance after they were made is taken to key them as its last answer showed, by votes or by when it applied them, rather than late',
		catchers: [
			caughtBy(PASS, 'a pass checking what it concludes', 'moves past a moment only once each further filter\'s page shows it read up to there, from a peer it takes to key votes'),
			caughtBy(PASS, 'a pass at the edges of what a peer answers', 'reports a peer it learns keys votes late')
		]
	},
	{
		name: 'side-both-refused',
		fix: commit('6479dc3'),
		reverts: 'a block asked for on both ledgers is refused, as the client asks for one when it recovers an account',
		catchers: [caughtBy('src/api/routes.test.ts', 'requests a representative answers without a failure', 'a block is found on either ledger when both are asked, as the client asks for the blocks of an account it recovers')]
	},
	{
		name: 'missing-gc',
		fix: commit('818ee18'),
		reverts: 'no garbage collection runs after a bootstrap update, which alone applies the staples deferred past the replay window',
		catchers: [caughtBy(BOOTSTRAP, 'a bootstrap client', 'runs the ledger\'s garbage collection after each update, which applies staples deferred past the replay window, in short slices until it reports nothing left, and none once stopped')]
	},
	{
		name: 'gc-cut-short',
		fix: commit('e474d76'),
		reverts: 'the garbage collection after an update stops after five slices, though more is left',
		catchers: [caughtBy(BOOTSTRAP, 'a bootstrap client', 'runs the ledger\'s garbage collection after each update, which applies staples deferred past the replay window, in short slices until it reports nothing left, and none once stopped')]
	},
	{
		name: 'stats-failed-sync-kept',
		fix: commit('df27226'),
		reverts: 'the node\'s statistics keep a failed sync, which every later sync and read awaits, as upstream\'s do',
		catchers: [caughtBy(STATS, 'the node\'s statistics', 'a sync after a failed one writes what the failed one could not, and reads succeed again')]
	},
	{
		name: 'stats-sync-awaits-failure',
		fix: commit('df27226'),
		reverts: 'a sync made while the one before it is failing fails with it, the changes it had taken lost',
		catchers: [caughtBy(STATS, 'the node\'s statistics', 'a sync made while the one before it is failing writes its own changes, and the next writes the failed one\'s')]
	},
	{
		name: 'stats-failed-changes-lost',
		fix: commit('df27226'),
		reverts: 'a statistics change whose write failed is dropped rather than kept for the next sync',
		catchers: [caughtBy(STATS, 'the node\'s statistics', 'a sync after a failed one writes what the failed one could not, and reads succeed again')]
	},
	{
		name: 'stats-sync-fails-early',
		fix: commit('b6a2667'),
		reverts: 'a sync fails at its first failed write, before the others end and take back their changes',
		catchers: [caughtBy(STATS, 'the node\'s statistics', 'a read waits for every write of a sync that failed, not only for the first to fail')]
	},
	{
		name: 'request-timing-kept',
		fix: commit('80f940b'),
		reverts: 'the long-lived node keeps its request timing, to which its own work adds sections without end',
		catchers: [caughtBy(BOOTSTRAP, 'a bootstrap client', 'leaves no record of its transactions on the node however long it catches up, while a request still times its own')]
	},
	{
		name: 'timing-error-as-refusal',
		fix: commit('ffefd0c'),
		reverts: 'a timing error is answered as a refusal, its message naming the section',
		catchers: [caughtBy('src/api/routes.test.ts', 'the reads of a request', 'fail as an internal error when the request\'s timing refuses a section\'s name, without the name')]
	},
	{
		name: 'checksum-after-commit',
		fix: commit('407e8d1'),
		reverts: 'the Postgres driver folds a staple\'s part of the ledger checksum in the next staple\'s transaction, apart from its blocks, as the node\'s statistics, which once kept the checksum, were written at a sync after the commit',
		catchers: [caughtBy(POSTGRES_DRIVER, 'the Postgres driver', 'a node killed after its commits, before it writes its statistics, leaves a checksum covering every staple it committed')]
	},
	{
		name: 'checksum-read-every-staple',
		fix: commit('521ed0b'),
		reverts: 'the ledger checksum is read by folding every staple\'s checksum, as before the fold table, at a cost that grows with the ledger',
		catchers: [caughtBy(POSTGRES_DRIVER, 'the Postgres driver', 'keeps the checksum folded in a row per first byte of the staples\' blocks hashes, which a read reads instead of the staples')]
	},
	{
		name: 'history-requirement-accounts',
		fix: commit('e27cc4e'),
		reverts: 'a staple is listed in the history of every account it touches, an account a permission requirement only names included (D18)',
		catchers: caughtByBothDrivers('src/ledger/storage/suite/confirmed.ts', 'confirmed ledger', 'history lists a staple under its signers and the accounts it has an effect on, not under an account a permission requirement only names')
	},
	{
		name: 'ranges-added-as-read',
		fix: commit('fc748b3'),
		reverts: 'what the ranges read is added as it is staged, rather than in the order of its votes up to where every range before has read',
		catchers: [
			caughtBy('src/node/bootstrap-stage.test.ts', 'staging what the ranges read', 'adds before the overlap before where the range that reached least has reached, and every staple once no range is left'),
			caughtBy(SIMULATION, 'reading the history it lacks in ranges, one per peer, while far behind', 'adds the history it read in ranges in the order of its votes, so that staples voted before voting weight moved are added before the move, which refuses them for good when each range is added as it is read')
		]
	},
	{
		name: 'block-count-with-stage',
		fix: commit('280f15f'),
		reverts: 'the follower\'s block count is compared with the representatives\' while it has staples staged',
		catchers: [caughtBy('src/parity/checksum.test.ts', 'comparing the follower\'s block count with each representative\'s', 'does not count while the follower has staples staged, though a pass has completed')]
	},
	{
		name: 'gc-retry-records-kept',
		fix: commit('b83cdff'),
		reverts: 'gc keeps its retry records of a staple an add applies or it drops as dead, for as long as the process lives',
		catchers: caughtByBothDrivers('src/ledger/storage/suite/gc.ts', 'gc', 'nothing is kept of a failed retry once an add applies its staple, or gc drops it as dead')
	},
	{
		name: 'staging-rejects-unsettled',
		fix: commit('fc748b3'),
		reverts: 'adding what was staged fails on a failed read of the stage before the work it runs alongside has settled, so Bootstrap.stop() can return with writers running',
		catchers: [caughtBy('src/node/bootstrap-stage.test.ts', 'staging what the ranges read', 'fails when reading the stage fails only once the work has settled, so that nothing it runs outlives the adding')]
	}
];
