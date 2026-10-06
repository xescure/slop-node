declare const webpackModuleIDBrand: unique symbol;
export type WebpackModuleID = string & { readonly [webpackModuleIDBrand]: true };

/** 1-based and inclusive on both ends. An empty range has `last` one below `first`. */
export type BundleLineRange = { readonly first: number; readonly last: number };

export type BundleModuleOrigin = 'keeta' | 'third-party';

export type BundleModule = {
	readonly id: WebpackModuleID;
	readonly lines: BundleLineRange;
	readonly origin: BundleModuleOrigin;
	readonly exportedNames: ReadonlySet<string>;
};

export type SplitBundle = {
	readonly prologue: BundleLineRange;
	readonly modules: readonly BundleModule[];
	readonly epilogue: BundleLineRange;
};

type ModuleHeader = { readonly id: WebpackModuleID; readonly index: number };

const moduleHeaderPattern = /^\/\*\*\*\/ (\S+):$/;
const epilogueMarker = '/******/';
const sourceMapMarker = '//# sourceMappingURL=';

const exportedNamePatterns: readonly RegExp[] = [
	/(?<![\w$])exports\.([\w$]+)\s*=(?!=)/g,
	/(?<![\w$])exports\["([^"]+)"\]\s*=(?!=)/g,
	/Object\.defineProperty\(exports,\s*"([^"]+)"/g
];

/** The only place a plain string becomes a module ID: call it with a webpack module key taken from the bundle. */
export function convertStringToWebpackModuleID(value: string): WebpackModuleID {
	return(value as WebpackModuleID);
}

function findModuleHeaders(lines: readonly string[]): readonly ModuleHeader[] {
	const retval: ModuleHeader[] = [];
	for (const [index, line] of lines.entries()) {
		const id = moduleHeaderPattern.exec(line)?.[1];
		if (id !== undefined) {
			retval.push({ id: convertStringToWebpackModuleID(id), index });
		}
	}
	return(retval);
}

// Module bodies never contain a line that begins with the bootstrap marker, so
// the first such line after the last module header closes the module table.
// The last module's own trailing line starts with a different marker.
function findEpilogueStart(lines: readonly string[], lastHeaderIndex: number): number {
	for (let index = lastHeaderIndex + 1; index < lines.length; index++) {
		if (lines[index]?.startsWith(epilogueMarker) === true) {
			return(index);
		}
	}
	throw(new Error('bundle has no epilogue after the last module'));
}

function collectExportedNames(lines: readonly string[]): ReadonlySet<string> {
	const retval = new Set<string>();
	for (const line of lines) {
		for (const pattern of exportedNamePatterns) {
			for (const match of line.matchAll(pattern)) {
				const name = match[1];
				if (name !== undefined && name !== '__esModule') {
					retval.add(name);
				}
			}
		}
	}
	return(retval);
}

function classifyOrigin(lines: readonly string[]): BundleModuleOrigin {
	if (lines.some(function(line): boolean {
		return(line.includes(sourceMapMarker));
	})) {
		return('third-party');
	}
	return('keeta');
}

export function splitBundle(lines: readonly string[]): SplitBundle {
	const headers = findModuleHeaders(lines);
	const firstHeader = headers[0];
	const lastHeader = headers.at(-1);
	if (firstHeader === undefined || lastHeader === undefined) {
		throw(new Error('bundle has no module headers'));
	}

	const epilogueIndex = findEpilogueStart(lines, lastHeader.index);
	const modules = headers.map(function(header, position): BundleModule {
		const endIndex = headers[position + 1]?.index ?? epilogueIndex;
		const moduleLines = lines.slice(header.index, endIndex);
		return({
			id: header.id,
			lines: { first: header.index + 1, last: endIndex },
			origin: classifyOrigin(moduleLines),
			exportedNames: collectExportedNames(moduleLines)
		});
	});

	return({
		prologue: { first: 1, last: firstHeader.index },
		modules,
		epilogue: { first: epilogueIndex + 1, last: lines.length }
	});
}
