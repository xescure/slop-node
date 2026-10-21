import ts from 'typescript';

/** Whether a title names a block of tests or a test. */
export type TitleKind = 'describe' | 'test';

/**
 * A title a test file gives a block or a test, as the names vitest reports
 * for it: a pattern of every name it can take, or any name at all when it is
 * computed; whether it may not run, as a skipped, todo or conditional block
 * or test does, or one expected to fail; and the blocks the file nests it in,
 * outermost first.
 */
export type TitleTemplate = {
	readonly kind: TitleKind;
	readonly pattern: RegExp | 'computed';
	readonly mayNotRun: boolean;
	readonly within: readonly TitleTemplate[];
};

const CALLEE_KINDS: Readonly<Record<string, TitleKind>> = {
	describe: 'describe',
	suite: 'describe',
	test: 'test',
	it: 'test'
};

/** The calls that make a title parameterized, which vitest fills from each row of a table. */
const PARAMETERIZED = new Set(['each', 'for']);

/** The calls that make a block or test run only on a condition. */
const CONDITIONAL = new Set(['skipIf', 'runIf']);

/** The modifiers of a block or test that may keep it from running, or invert what its failing means. */
const NOT_RUN = new Set(['skip', 'todo', 'fails']);

/** What vitest puts in place of the end of a long value it shows in a title. */
const ELLIPSIS = '\u2026';

type Callee = {
	readonly kind: TitleKind;
	readonly mayNotRun: boolean;
	/** The table of a parameterized title, if any. */
	readonly table: ts.Expression | undefined;
	readonly parameterized: boolean;
};

/** The kind of block or test the callee defines, as in describe(...), test.skip(...), test.each(table)(...) or test.skipIf(condition)(...). */
function calleeOf(callee: ts.Expression): Callee | undefined {
	if (ts.isIdentifier(callee)) {
		const kind = CALLEE_KINDS[callee.text];
		if (kind === undefined) {
			return(undefined);
		}
		return({ kind, mayNotRun: false, table: undefined, parameterized: false });
	}
	if (ts.isPropertyAccessExpression(callee)) {
		// test.each(table) and test.skipIf(condition) only build the function that defines the tests.
		if (PARAMETERIZED.has(callee.name.text) || CONDITIONAL.has(callee.name.text)) {
			return(undefined);
		}
		const base = calleeOf(callee.expression);
		if (base === undefined) {
			return(undefined);
		}
		return({ ...base, mayNotRun: base.mayNotRun || NOT_RUN.has(callee.name.text) });
	}
	if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)) {
		const builder = callee.expression.name.text;
		if (!PARAMETERIZED.has(builder) && !CONDITIONAL.has(builder)) {
			return(undefined);
		}
		const base = calleeOf(callee.expression.expression);
		if (base === undefined) {
			return(undefined);
		}
		if (CONDITIONAL.has(builder)) {
			return({ ...base, mayNotRun: true });
		}
		return({ ...base, table: callee.arguments[0], parameterized: true });
	}
	return(undefined);
}

function escaped(text: string): string {
	return(text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'));
}

/** The text, or a start of it followed by the ellipsis, as vitest shows a long value cut short. */
function cutShortPattern(text: string): string {
	let prefixes = '';
	for (let index = text.length - 1; index >= 0; index--) {
		prefixes = `(?:${escaped(text.charAt(index))}${prefixes})?`;
	}
	return(`(?:${escaped(text)}|${prefixes}${escaped(ELLIPSIS)})`);
}

const ANY = '[\\s\\S]*';

/** A value a table holds as written, if it is a literal. */
type LiteralValue = string | number | boolean;

function literalOf(expression: ts.Expression): LiteralValue | undefined {
	if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
		return(expression.text);
	}
	if (ts.isNumericLiteral(expression)) {
		return(Number(expression.text));
	}
	if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) {
		return(-Number(expression.operand.text));
	}
	if (expression.kind === ts.SyntaxKind.TrueKeyword) {
		return(true);
	}
	if (expression.kind === ts.SyntaxKind.FalseKeyword) {
		return(false);
	}
	return(undefined);
}

/** The arguments one row of a table gives a test: an array row's elements, or the row itself. */
function itemsOf(row: ts.Expression): readonly ts.Expression[] {
	if (ts.isArrayLiteralExpression(row)) {
		return(row.elements);
	}
	return([row]);
}

function propertyOf(object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === key) {
			return(property.initializer);
		}
	}
	return(undefined);
}

/** A $key placeholder, filled with the value as vitest shows it: a string quoted and cut short when long. */
function shownPattern(expression: ts.Expression | undefined): string {
	if (expression === undefined) {
		return(ANY);
	}
	const value = literalOf(expression);
	if (typeof value === 'string') {
		return(`'${cutShortPattern(value)}'`);
	}
	if (value === undefined) {
		return(ANY);
	}
	return(escaped(String(value)));
}

/** A printf directive, filled with the value as vitest formats it. */
function formattedPattern(directive: string, expression: ts.Expression | undefined, index: number): string {
	if (directive === '%#') {
		return(String(index));
	}
	if (expression === undefined) {
		return(ANY);
	}
	const value = literalOf(expression);
	if (value === undefined) {
		return(ANY);
	}
	switch (directive) {
		case '%s':
		case '%d':
		case '%i':
		case '%f':
			return(escaped(String(value)));
		case '%j':
			return(escaped(JSON.stringify(value)));
		default:
			return(ANY);
	}
}

const PLACEHOLDER = /(%%|%(?:s|d|i|f|j|o|O|c|#)|\$[$\w.]+)/u;

/** The title as one row of the table fills it, as @vitest/runner's formatTitle does. */
function rowPattern(text: string, row: ts.Expression | undefined, index: number): string {
	let items: readonly ts.Expression[] = [];
	if (row !== undefined) {
		items = itemsOf(row);
	}
	const [first] = items;
	let object: ts.ObjectLiteralExpression | undefined;
	if (first !== undefined && ts.isObjectLiteralExpression(first)) {
		object = first;
	}
	let consumed = 0;
	return(text.split(PLACEHOLDER).map(function(token, position): string {
		if (position % 2 === 0) {
			return(escaped(token));
		}
		if (token === '%%') {
			return('%');
		}
		if (token.startsWith('%')) {
			if (row === undefined) {
				return(ANY);
			}
			const item = items[consumed];
			if (token !== '%#') {
				consumed++;
			}
			return(formattedPattern(token, item, index));
		}
		const key = token.slice(1);
		if (/^\d+$/u.test(key)) {
			return(shownPattern(items[Number(key)]));
		}
		if (row === undefined) {
			return(ANY);
		}
		if (object === undefined) {
			return(escaped(token));
		}
		return(shownPattern(propertyOf(object, key)));
	}).join(''));
}

/**
 * Every name the title can take: written out, the row of a literal table it
 * is filled from, or any value where the table or a value is computed.
 */
function patternOf(title: ts.Expression, callee: Callee): RegExp | 'computed' {
	if (ts.isTemplateExpression(title)) {
		const pieces = [title.head.text, ...title.templateSpans.map(function(span): string {
			return(span.literal.text);
		})];
		return(new RegExp(`^${pieces.map(escaped).join(ANY)}$`, 'u'));
	}
	if (!ts.isStringLiteral(title) && !ts.isNoSubstitutionTemplateLiteral(title)) {
		return('computed');
	}
	if (!callee.parameterized) {
		return(new RegExp(`^${escaped(title.text)}$`, 'u'));
	}
	const table = callee.table;
	if (table === undefined || !ts.isArrayLiteralExpression(table)) {
		return(new RegExp(`^${rowPattern(title.text, undefined, 0)}$`, 'u'));
	}
	const rows = table.elements.map(function(row, index): string {
		return(rowPattern(title.text, row, index));
	});
	return(new RegExp(`^(?:${rows.join('|')})$`, 'u'));
}

/** Every title the source gives a block or a test. */
export function titleTemplatesOf(source: string, fileName: string): TitleTemplate[] {
	const templates: TitleTemplate[] = [];
	const visit = function(node: ts.Node, within: readonly TitleTemplate[]): void {
		let inner = within;
		if (ts.isCallExpression(node)) {
			const callee = calleeOf(node.expression);
			const [title] = node.arguments;
			if (callee !== undefined && title !== undefined) {
				const template: TitleTemplate = { kind: callee.kind, pattern: patternOf(title, callee), mayNotRun: callee.mayNotRun, within };
				templates.push(template);
				if (callee.kind === 'describe') {
					inner = [...within, template];
				}
			}
		}
		ts.forEachChild(node, function(child): void {
			visit(child, inner);
		});
	};
	visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS), []);
	return(templates);
}

function matches(template: TitleTemplate, kind: TitleKind, title: string): boolean {
	return(template.kind === kind && (template.pattern === 'computed' || template.pattern.test(title)));
}

/** Whether the blocks, outermost first, name the template and every block the file nests it in, all of which run. */
function namesNested(template: TitleTemplate, kind: TitleKind, path: readonly string[]): boolean {
	const title = path.at(-1);
	if (title === undefined || template.mayNotRun || !matches(template, kind, title)) {
		return(false);
	}
	const outer = path.slice(0, -1);
	return(outer.length === template.within.length && template.within.every(function(block, index): boolean {
		return(!block.mayNotRun && matches(block, 'describe', outer[index] ?? ''));
	}));
}

/**
 * Whether the files' titles define the test the file runs, as vitest names
 * it: the titles of the blocks around it, outermost first, and then its own.
 * A test of the file itself must be nested as named. A test of a shared suite
 * the file runs may be nested in a block of the file, as a suite defined
 * inside a describe of the file is; its blocks of the suite then end the name.
 * Neither it nor any block around it may be skipped, todo, conditional or
 * expected to fail.
 */
export function definesTest(templatesByFile: ReadonlyMap<string, readonly TitleTemplate[]>, file: string, name: readonly string[]): boolean {
	const own = templatesByFile.get(file) ?? [];
	return([...templatesByFile].some(function([templatesFile, templates]): boolean {
		return(templates.some(function(template): boolean {
			if (template.kind !== 'test') {
				return(false);
			}
			const depth = template.within.length + 1;
			if (name.length < depth || !namesNested(template, 'test', name.slice(-depth))) {
				return(false);
			}
			const outer = name.slice(0, -depth);
			if (outer.length === 0) {
				return(true);
			}
			if (templatesFile === file) {
				return(false);
			}
			return(own.some(function(block): boolean {
				return(namesNested(block, 'describe', outer));
			}));
		}));
	}));
}
