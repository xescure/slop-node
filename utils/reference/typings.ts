import ts from 'typescript';

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return(ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(function(modifier): boolean {
		return(modifier.kind === kind);
	}));
}

function declaredValueName(statement: ts.Statement): string | undefined {
	if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) {
		return(statement.name?.text);
	}
	return(undefined);
}

function variableNames(statement: ts.VariableStatement): readonly string[] {
	return(statement.declarationList.declarations.map(function(declaration): string {
		if (!ts.isIdentifier(declaration.name)) {
			throw(new Error('destructured exports are not valid in a typings file'));
		}
		return(declaration.name.text);
	}));
}

/*
 * `export { Foo }` can name a local interface or type alias, which has no
 * runtime value and so never appears among a module's exports.
 */
function localTypeOnlyNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
	const typeNames = new Set<string>();
	const valueNames = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
			typeNames.add(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			variableNames(statement).forEach(function(name): void {
				valueNames.add(name);
			});
		} else {
			const name = declaredValueName(statement);
			if (name !== undefined) {
				valueNames.add(name);
			}
		}
	}
	return(new Set([...typeNames].filter(function(name): boolean {
		return(!valueNames.has(name));
	})));
}

function namedExportNames(statement: ts.ExportDeclaration, typeOnlyNames: ReadonlySet<string>): readonly string[] {
	const clause = statement.exportClause;
	if (clause === undefined || statement.isTypeOnly) {
		return([]);
	}
	if (ts.isNamespaceExport(clause)) {
		return([clause.name.text]);
	}
	return(clause.elements.filter(function(element): boolean {
		const localName = (element.propertyName ?? element.name).text;
		const isLocalType = statement.moduleSpecifier === undefined && typeOnlyNames.has(localName);
		return(!element.isTypeOnly && !isLocalType);
	}).map(function(element): string {
		return(element.name.text);
	}));
}

export function collectTypingsValueExports(source: string, fileName: string): ReadonlySet<string> {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const typeOnlyNames = localTypeOnlyNames(sourceFile);
	const retval = new Set<string>();

	for (const statement of sourceFile.statements) {
		if (ts.isExportDeclaration(statement)) {
			namedExportNames(statement, typeOnlyNames).forEach(function(name): void {
				retval.add(name);
			});
		} else if (ts.isExportAssignment(statement)) {
			if (statement.isExportEquals !== true) {
				retval.add('default');
			}
		} else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
			if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
				retval.add('default');
			} else if (ts.isVariableStatement(statement)) {
				variableNames(statement).forEach(function(name): void {
					retval.add(name);
				});
			} else {
				const name = declaredValueName(statement);
				if (name !== undefined) {
					retval.add(name);
				}
			}
		}
	}
	return(retval);
}
