import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Fixtures violate the policy on purpose and are linted only by
// utils/lint-policy.test.ts, which disables ignore handling.
const ignoredPaths = ['dist/', 'build/', 'reference/', 'node_modules/', '.devenv/', 'utils/lint-fixtures/**'];

// Rejects "Id", "Url", "Http", "Api", "Json" and "Sql" when they end a word
// inside an identifier, so initialisms are spelled ID, URL, HTTP, API, JSON, SQL.
// A plural "s" may follow, so "accountIds" is caught as well as "accountId".
const mangledInitialism = '(Id|Url|Http|Api|Json|Sql)s?(?=[A-Z0-9_]|$)';

export default defineConfig(
	globalIgnores(ignoredPaths),
	{
		files: ['**/*.ts'],
		extends: [
			eslint.configs.recommended,
			tseslint.configs.strictTypeChecked
		],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			'no-ternary': 'error',
			'no-nested-ternary': 'error',
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/explicit-module-boundary-types': 'error',
			'@typescript-eslint/no-unused-vars': ['error', {
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_'
			}],
			'@typescript-eslint/naming-convention': ['error',
				{
					selector: 'default',
					modifiers: ['requiresQuotes'],
					format: null
				},
				{
					selector: 'default',
					format: null,
					custom: {
						regex: mangledInitialism,
						match: false
					}
				}
			]
		}
	}
);
