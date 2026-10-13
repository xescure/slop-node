/** A package as the lock pins it: the name the registry knows it by, and its exact version. */
export type PinnedPackage = { readonly name: string; readonly version: string };

/** An entry of the lock that has no integrity, and where the lock lists it. */
export type UncheckedEntry = PinnedPackage & { readonly path: string };

/** What the registry gives as the integrity of the package's tarball, if anything. */
export type IntegrityLookup = (pinned: PinnedPackage) => Promise<string>;

type LockEntry = { readonly [field: string]: unknown };

/** A package-lock.json, of which only the packages are read; the other fields are kept as they are. */
export type PackageLock = {
	readonly packages: { readonly [path: string]: LockEntry };
	readonly [field: string]: unknown;
};

/** The only integrity the registry gives packages published since 2017, and the one the Nix fetch is checked against. */
const INTEGRITY_FORMAT = /^sha512-[A-Za-z0-9+/]{86}==$/;

const ROOT_PATH = '';

function isRecord(value: unknown): value is { readonly [field: string]: unknown } {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

export function parseLock(text: string): PackageLock {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !isRecord(parsed['packages'])) {
		throw(new Error('the lock has no packages'));
	}
	const packages: { [path: string]: LockEntry } = {};
	for (const [path, entry] of Object.entries(parsed['packages'])) {
		if (!isRecord(entry)) {
			throw(new Error(`the lock's entry ${path} is not an object`));
		}
		packages[path] = entry;
	}
	return({ ...parsed, packages });
}

function nameOf(path: string, entry: LockEntry): string {
	// An aliased package is listed under its alias, and names the package itself.
	const name = entry['name'];
	if (typeof name === 'string') {
		return(name);
	}
	return(path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length));
}

/**
 * The entries the Nix package fetches without an integrity to check them
 * against: every one but the project itself and links, which are not fetched.
 */
export function uncheckedEntries(lock: PackageLock): readonly UncheckedEntry[] {
	const unchecked: UncheckedEntry[] = [];
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path === ROOT_PATH || entry['link'] === true || typeof entry['integrity'] === 'string') {
			continue;
		}
		const version = entry['version'];
		if (typeof version !== 'string') {
			throw(new Error(`the lock's entry ${path} has no version`));
		}
		unchecked.push({ path, name: nameOf(path, entry), version });
	}
	return(unchecked);
}

export function specOf(pinned: PinnedPackage): string {
	return(`${pinned.name}@${pinned.version}`);
}

/** The entry with the integrity right after its version, where npm writes it. */
function withIntegrity(entry: LockEntry, integrity: string): LockEntry {
	const filled: { [field: string]: unknown } = {};
	for (const [field, value] of Object.entries(entry)) {
		if (field === 'integrity') {
			continue;
		}
		filled[field] = value;
		if (field === 'version') {
			filled['integrity'] = integrity;
		}
	}
	return(filled);
}

/**
 * The integrity of each package, looked up once however many entries pin it,
 * with at most the concurrency given in flight.
 */
async function lookUpAll(pinned: readonly PinnedPackage[], lookup: IntegrityLookup, concurrency: number): Promise<ReadonlyMap<string, string>> {
	const pending = [...new Map(pinned.map(function(entry): [string, PinnedPackage] {
		return([specOf(entry), { name: entry.name, version: entry.version }]);
	})).values()];
	const found = new Map<string, string>();
	async function work(): Promise<void> {
		for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
			const integrity = await lookup(next);
			if (!INTEGRITY_FORMAT.test(integrity)) {
				throw(new Error(`the registry gives no sha512 integrity for ${specOf(next)}: ${JSON.stringify(integrity)}`));
			}
			found.set(specOf(next), integrity);
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, work));
	return(found);
}

/** The lock with every unchecked entry given the integrity the registry gives its package. */
export async function fillIntegrity(lock: PackageLock, lookup: IntegrityLookup, concurrency: number): Promise<PackageLock> {
	const unchecked = uncheckedEntries(lock);
	const found = await lookUpAll(unchecked, lookup, concurrency);
	const packages: { [path: string]: LockEntry } = { ...lock.packages };
	for (const entry of unchecked) {
		const integrity = found.get(specOf(entry));
		const listed = packages[entry.path];
		if (integrity === undefined || listed === undefined) {
			throw(new Error(`no integrity was looked up for ${entry.path}`));
		}
		packages[entry.path] = withIntegrity(listed, integrity);
	}
	return({ ...lock, packages });
}

/** The lock as npm writes it. */
export function formatLock(lock: PackageLock): string {
	return(`${JSON.stringify(lock, null, '\t')}\n`);
}
