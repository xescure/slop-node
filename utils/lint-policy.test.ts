import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

const linter = new ESLint({ overrideConfigFile: '.eslint.config.mjs', ignore: false });

async function lintRuleIDs(fixture: string): Promise<string[]> {
	const [result] = await linter.lintFiles([`utils/lint-fixtures/${fixture}`]);
	expect(result).toBeDefined();
	return result?.messages.map(function(message): string {
		return message.ruleId ?? 'parse-error';
	}) ?? [];
}

test('rejects conditional expressions', async function(): Promise<void> {
	expect(await lintRuleIDs('ternary.ts')).toContain('no-ternary');
});

test('rejects mangled initialisms', async function(): Promise<void> {
	expect(await lintRuleIDs('mangled-initialism.ts')).toContain('@typescript-eslint/naming-convention');
});

test('rejects any', async function(): Promise<void> {
	expect(await lintRuleIDs('explicit-any.ts')).toContain('@typescript-eslint/no-explicit-any');
});

test('rejects exports without declared types', async function(): Promise<void> {
	expect(await lintRuleIDs('untyped-export.ts')).toContain('@typescript-eslint/explicit-module-boundary-types');
});

test('accepts correct initialisms', async function(): Promise<void> {
	expect(await lintRuleIDs('clean.ts')).toEqual([]);
});
