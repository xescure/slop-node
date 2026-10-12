import { appendFile, mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shadowRunStateOf, shadowVoteEntryOf } from './log.js';
import type { ShadowRunState, ShadowVoteEntry } from './log.js';
import type { ShadowState } from './shadow-live.js';

/** Where a shadow-vote run keeps its standing and its votes, within the follower's directory. */
export const SHADOW_DIRECTORY = 'shadow-live';

const CURSOR_FILE = 'cursor.json';
const VOTES_FILE = 'votes.jsonl';

/** The standing, and how much of the votes file it covers. */
type Cursor = { readonly state: ShadowRunState; readonly votesBytes: number };

export function shadowDirectory(followerDirectory: string): string {
	return(join(followerDirectory, SHADOW_DIRECTORY));
}

function isMissing(error: unknown): boolean {
	return(error instanceof Error && 'code' in error && error.code === 'ENOENT');
}

async function sizeOf(path: string): Promise<number> {
	try {
		return((await stat(path)).size);
	} catch (error: unknown) {
		if (isMissing(error)) {
			return(0);
		}
		throw(error);
	}
}

function cursorOf(text: string, path: string): Cursor {
	const value: unknown = JSON.parse(text);
	if (typeof value !== 'object' || value === null || !('state' in value) || !('votesBytes' in value)) {
		throw(new Error(`${path} holds no shadow-vote cursor`));
	}
	const state = shadowRunStateOf(value.state);
	const { votesBytes } = value;
	if (state === undefined || typeof votesBytes !== 'number' || !Number.isSafeInteger(votesBytes) || votesBytes < 0) {
		throw(new Error(`${path} holds no shadow-vote cursor this version writes`));
	}
	return({ state, votesBytes });
}

/** The length of the text up to and with its last whole line. */
function wholeLinesLength(bytes: Buffer): number {
	return(bytes.lastIndexOf(0x0A) + 1);
}

/** The standing a run's cursor holds, or nothing when no run saved one, read without touching the run's files, so beside a run. */
export async function readShadowStanding(directory: string): Promise<ShadowRunState | undefined> {
	const cursorPath = join(directory, CURSOR_FILE);
	try {
		return(cursorOf(await readFile(cursorPath, 'utf8'), cursorPath).state);
	} catch (error: unknown) {
		if (isMissing(error)) {
			return(undefined);
		}
		throw(error);
	}
}

/**
 * The standing in a cursor file, replaced whole by a rename, and the votes
 * in a file of one JSON line each, appended. A vote is appended before its
 * staple is added, and the cursor saved after, naming how many bytes of the
 * votes it covers, so the votes past that are those of the batch a stop cut
 * short. Each write is handed to the system before the run goes on, so a
 * stop of the process loses none; a crash of the machine may lose the
 * latest, and the run then votes on their staples again from a ledger that
 * already holds them, which it refuses with an error rather than miscount.
 */
export function fileShadowState(directory: string): ShadowState & { clear(): Promise<void> } {
	const cursorPath = join(directory, CURSOR_FILE);
	const votesPath = join(directory, VOTES_FILE);
	let votesBytes = 0;
	return({
		async load(): Promise<ShadowRunState | undefined> {
			let text: string;
			try {
				text = await readFile(cursorPath, 'utf8');
			} catch (error: unknown) {
				if (isMissing(error)) {
					return(undefined);
				}
				throw(error);
			}
			const cursor = cursorOf(text, cursorPath);
			// A line the stop cut short is dropped, so that the next vote starts a line of its own.
			const votes = await readFile(votesPath).catch(function(error: unknown): Buffer {
				if (isMissing(error)) {
					return(Buffer.alloc(0));
				}
				throw(error);
			});
			const whole = wholeLinesLength(votes);
			if (whole < cursor.votesBytes) {
				throw(new Error(`${votesPath} holds fewer votes than ${cursorPath} counts`));
			}
			if (whole < votes.length) {
				await truncate(votesPath, whole);
			}
			votesBytes = cursor.votesBytes;
			return(cursor.state);
		},
		async save(state: ShadowRunState): Promise<void> {
			await mkdir(directory, { recursive: true });
			const cursor: Cursor = { state, votesBytes: await sizeOf(votesPath) };
			const written = `${cursorPath}.tmp`;
			await writeFile(written, `${JSON.stringify(cursor)}\n`);
			await rename(written, cursorPath);
			votesBytes = cursor.votesBytes;
		},
		async record(entry: ShadowVoteEntry): Promise<void> {
			await mkdir(directory, { recursive: true });
			await appendFile(votesPath, `${JSON.stringify(entry)}\n`);
		},
		async recordedSinceSaved(): Promise<ReadonlyMap<string, ShadowVoteEntry>> {
			const recorded = new Map<string, ShadowVoteEntry>();
			const size = await sizeOf(votesPath);
			if (size <= votesBytes) {
				return(recorded);
			}
			const file = await open(votesPath, 'r');
			try {
				const tail = Buffer.alloc(size - votesBytes);
				await file.read(tail, 0, tail.length, votesBytes);
				for (const line of tail.subarray(0, wholeLinesLength(tail)).toString('utf8').split('\n')) {
					if (line === '') {
						continue;
					}
					const entry = shadowVoteEntryOf(JSON.parse(line));
					if (entry === undefined) {
						throw(new Error(`${votesPath} holds a line that is no shadow vote: ${line}`));
					}
					recorded.set(entry.blocksHash, entry);
				}
			} finally {
				await file.close();
			}
			return(recorded);
		},
		async clear(): Promise<void> {
			await rm(directory, { recursive: true, force: true });
			votesBytes = 0;
		}
	});
}
