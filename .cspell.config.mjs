/** @type { import("cspell").CSpellSettings } */
export default {
	language: 'en',
	dictionaries: ['typescript', 'softwareTerms'],
	words: [
		'keeta',
		'keetanet',
		'staple',
		'staples',
		'devenv',
		'nixpkgs',
		'jaccard',
		'nvmrc',
		'vitest'
	],
	ignorePaths: [
		'reference/',
		'node_modules/',
		'dist/',
		'build/',
		'LICENSE',
		'*.lock',
		'package-lock.json'
	],
	useGitignore: true
};
