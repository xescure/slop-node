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
		'datname'
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
