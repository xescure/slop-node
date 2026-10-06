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
		'blockhash'
	],
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
