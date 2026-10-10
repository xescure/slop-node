// @ts-check
import { PluginKind, declareValuePlugin } from '@stryker-mutator/api/plugin';

/**
 * @typedef {{
 *   readonly node: { readonly type: string };
 *   readonly parent: { readonly type: string; readonly callee?: unknown; readonly arguments?: readonly unknown[] } | null;
 *   readonly parentPath: unknown;
 * }} NodePath
 */

const LITERALS = new Set(['StringLiteral', 'TemplateLiteral']);

const QUERY_METHODS = new Set(['query', 'execute']);

/**
 * @param {unknown} callee
 * @returns {string | undefined}
 */
function calleeName(callee) {
	if (typeof callee !== 'object' || callee === null || !('type' in callee)) {
		return(undefined);
	}
	if (callee.type === 'Identifier' && 'name' in callee && typeof callee.name === 'string') {
		return(callee.name);
	}
	if (callee.type === 'MemberExpression' && 'property' in callee) {
		return(calleeName(callee.property));
	}
	return(undefined);
}

/**
 * Where the Postgres driver writes SQL: both arguments of statement(), which
 * are a statement's name and text, and a literal first argument of query()
 * or execute(), the text of a statement run unprepared.
 * @param {NodePath} path
 * @returns {boolean}
 */
function isSQLText(path) {
	const { node, parent } = path;
	if (parent?.type !== 'CallExpression' || parent.arguments === undefined) {
		return(false);
	}
	const position = parent.arguments.indexOf(node);
	const callee = calleeName(parent.callee);
	if (callee === 'statement') {
		return(position >= 0);
	}
	return(position === 0 && LITERALS.has(node.type) && callee !== undefined && QUERY_METHODS.has(callee));
}

export const strykerPlugins = [
	declareValuePlugin(PluginKind.Ignore, 'postgres-sql', {
		/**
		 * @param {NodePath} path
		 * @returns {string | undefined}
		 */
		shouldIgnore(path) {
			if (isSQLText(path)) {
				return('SQL text, which the driver suite and the corpus run');
			}
			return(undefined);
		}
	})
];
