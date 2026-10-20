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
		'devenv',
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
		'regnamespace',
		'rolname',
		'xact',
		// The column of pg_stat_activity that names a session's role.
		'usename',
		// The PL/pgSQL option that gives a raised error its SQLSTATE.
		'errcode',
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
		// The explorer's migration lock key, 0x6b65657461657870, read as ASCII.
		'keetaexp',
		// The explorer's indexer lock key, 0x6b65657461696478, read as ASCII.
		'keetaidx',
		// The columns of pg_locks that hold an advisory lock's key.
		'classid',
		'objid',
		// The image's init, its labels' namespace, and the settings a container runs with.
		'tini',
		'opencontainers',
		'tzdir',
		'zoneinfo',
		'nofile',
		'devnet',
		// A Postgres setting the follower's cluster runs with.
		'autovacuum',
		// The MCP SDK's package and transport, and the explorer's health route.
		'modelcontextprotocol',
		'streamable',
		'healthz'
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
