/** @type { import("cspell").CSpellSettings } */
export default {
	language: 'en',
	dictionaries: ['typescript', 'softwareTerms'],
	words: [
		'keeta',
		'keetanet',
		'keetanetwork',
		'staple',
		'staples',
		'nixpkgs',
		'jaccard',
		'nvmrc',
		'vitest',
		'retval',
		'wordlist',
		'esac',
		'blockhash',
		'savepoint',
		'savepoints',
		'sqlstate',
		'bytea',
		'timestamptz',
		'regclass',
		'ctid',
		'locktype',
		'localtime',
		'localtimestamp',
		'timeofday',
		'pgdata',
		'fillfactor',
		'hardlinks',
		'reloptions',
		'relname',
		'pghost',
		'pgport',
		'nextval',
		'ordinality',
		'datname',
		'plpgsql',
		'pkey',
		'cmdline',
		// Planner settings, which tests turn off to see the index a query can use.
		'seqscan',
		'bitmapscan',
		// The name of a Postgres socket, and a file of /proc.
		'pgsql',
		'smaps',
		// Names in upstream's API: a route segment and a switch statistic.
		'clearstats',
		'ungreeted',
		// The capture of the account that holds a key pair is named for it.
		'keypair',
		// Elliptic curve names in upstream's key algorithms.
		'secp',
		// The migration lock key, 0x6b656574616c6467, read as ASCII.
		'keetaldg',
		// The image's init, its labels' namespace, and the settings a container runs with.
		'tini',
		'opencontainers',
		'tzdir',
		'zoneinfo',
		'nofile',
		'devnet',
		// A Postgres setting the follower's cluster runs with.
		'autovacuum'
	],
	// Account strings are base32 public keys, not words, and a Unix socket
	// directory as the host of a Postgres URL has each "/" written %2F.
	ignoreRegExpList: ['/keeta_[a-z2-7]+/g', '/%2F[a-z]+/gi'],
	ignorePaths: [
		'/reference/',
		'node_modules/',
		'dist/',
		'build/',
		'LICENSE',
		'*.lock',
		'package-lock.json'
	],
	useGitignore: true
};
