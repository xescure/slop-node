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
		'locktype',
		'localtime',
		'localtimestamp',
		'timeofday',
		'pgdata',
		'pghost',
		'pgport',
		'nextval',
		'ordinality',
		'datname',
		'pkey',
		'cmdline',
		// Elliptic curve names in upstream's key algorithms.
		'secp',
		// The migration lock key, 0x6b656574616c6467, read as ASCII.
		'keetaldg'
	],
	// Account strings are base32 public keys, not words.
	ignoreRegExpList: ['/keeta_[a-z2-7]+/g'],
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
