import ts from 'typescript';

/** Whether a title names a block of tests or a test. */
export type TitleKind = 'describe' | 'test';

/**
 * A title a test file gives a block or a test, as the names vitest reports
 * for it: a pattern when it is written out, with any value a parameterized
 * title or a template expression puts in it, or any name at all when it is
 * computed.
 */
export type TitleTemplate = {
	readonly kind: TitleKind;
	readonly pattern: RegExp | 'computed';
};

const CALLEE_KINDS: Readonly<Record<string, TitleKind>> = {
	describe: 'describe',
	suite: 'describe',
	test: 'test',
	it: 'test'
};

/** The calls that make a title parameterized, which vitest fills from each row of a table. */
const PARAMETERIZED = new Set(['each', 'for']);

/** A placeholder vitest fills in a parameterized title: $name or $name.field, or a printf directive. */
const PLACEHOLDER = /\$[A-Za-z_][\w.]*|%(?:s|d|i|f|j|o|O|c|#)/gu;

function escaped(text: string): string {
	return(text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'));
}

function placeholdersOf(text: string): string {
	return(text.split('%%').map(function(part): string {
		return(part.split(PLACEHOLDER).map(escaped).join('[\\s\\S]*'));
	}).join('%'));
}

/** The kind of block or test the callee defines, as in describe(...), test.skip(...) or test.each(table)(...). */
function calleeKind(callee: ts.Expression): { readonly kind: TitleKind; readonly parameterized: boolean } | undefined {
	if (ts.isIdentifier(callee)) {
		const kind = CALLEE_KINDS[callee.text];
		if (kind === undefined) {
			return(undefined);
		}
		return({ kind, parameterized: false });
	}
	if (ts.isPropertyAccessExpression(callee)) {
		// test.each(table) only builds the function that defines the tests.
		if (PARAMETERIZED.has(callee.name.text)) {
			return(undefined);
		}
		return(calleeKind(callee.expression));
	}
	if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && PARAMETERIZED.has(callee.expression.name.text)) {
		const table = calleeKind(callee.expression.expression);
		if (table === undefined) {
			return(undefined);
		}
		return({ kind: table.kind, parameterized: true });
	}
	return(undefined);
}

function patternOf(title: ts.Expression, parameterized: boolean): RegExp | 'computed' {
	let pieces: readonly string[];
	if (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) {
		pieces = [title.text];
	} else if (ts.isTemplateExpression(title)) {
		pieces = [title.head.text, ...title.templateSpans.map(function(span): string {
			return(span.literal.text);
		})];
	} else {
		return('computed');
	}
	const written = pieces.map(function(piece): string {
		if (parameterized) {
			return(placeholdersOf(piece));
		}
		return(escaped(piece));
	});
	return(new RegExp(`^${written.join('[\\s\\S]*')}$`, 'u'));
}

/** Every title the source gives a block or a test. */
export function titleTemplatesOf(source: string, fileName: string): TitleTemplate[] {
	const templates: TitleTemplate[] = [];
	const visit = function(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			const callee = calleeKind(node.expression);
			const [title] = node.arguments;
			if (callee !== undefined && title !== undefined) {
				templates.push({ kind: callee.kind, pattern: patternOf(title, callee.parameterized) });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
	return(templates);
}

function matches(template: TitleTemplate, kind: TitleKind, title: string): boolean {
	return(template.kind === kind && (template.pattern === 'computed' || template.pattern.test(title)));
}

/**
 * Whether the titles could name the test, as vitest names it: the titles of
 * the blocks around it and then its own. Each block's title must be one some
 * block is given, and the test's one some test is given; where they nest is
 * not checked.
 */
export function definesTest(templates: readonly TitleTemplate[], name: readonly string[]): boolean {
	const title = name.at(-1);
	if (title === undefined) {
		return(false);
	}
	const blocks = name.slice(0, -1);
	return(templates.some(function(template): boolean {
		return(matches(template, 'test', title));
	}) && blocks.every(function(block): boolean {
		return(templates.some(function(template): boolean {
			return(matches(template, 'describe', block));
		}));
	}));
}
