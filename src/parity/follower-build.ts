import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Where "up" writes the process ID of the follower's node as it starts it (src/parity/follower.ts). */
const NODE_PID_FILE = 'node.pid';

async function nodeProcessOf(directory: string): Promise<string | null> {
	let text: string;
	try {
		text = await readFile(join(directory, NODE_PID_FILE), 'utf8');
	} catch {
		return(null);
	}
	const processID = text.trim();
	if (!/^[1-9][0-9]*$/.test(processID)) {
		return(null);
	}
	return(processID);
}

/**
 * When the follower's node was started, as "up" wrote its process ID then,
 * or null when no node runs: a staple it holds back counts from then, since
 * a node that was down retried nothing meanwhile.
 */
export async function nodeStartedAt(directory: string, processes = '/proc'): Promise<Date | null> {
	const processID = await nodeProcessOf(directory);
	if (processID === null) {
		return(null);
	}
	try {
		await stat(join(processes, processID));
		return((await stat(join(directory, NODE_PID_FILE))).mtime);
	} catch {
		return(null);
	}
}

/**
 * The build the follower's node runs, named by the script it was started
 * with and when that script was last written: each build of the node writes
 * it again, so records of two builds never name the same one. Null when no
 * node runs, as its process's command line names no script.
 */
export async function followerBuildOf(directory: string, processes = '/proc'): Promise<string | null> {
	const processID = await nodeProcessOf(directory);
	if (processID === null) {
		return(null);
	}
	let commandLine: string;
	try {
		commandLine = await readFile(join(processes, processID, 'cmdline'), 'utf8');
	} catch {
		return(null);
	}
	const script = commandLine.split('\0').find(function(argument): boolean {
		return(/\.[cm]?js$/.test(argument));
	});
	if (script === undefined) {
		return(null);
	}
	try {
		return(`${script}@${(await stat(script)).mtime.toISOString()}`);
	} catch {
		return(null);
	}
}
