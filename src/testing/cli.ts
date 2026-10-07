import { spawn } from 'node:child_process';
import { onTestFinished } from 'vitest';
import type { Environment } from '../node/config.js';

/*
 * The command as built, which "make test" builds first, so that what is
 * tested is what the package runs.
 */
const BUILT_CLI = new URL('../../dist/main.js', import.meta.url);

/** Starting a process that loads the client takes about a second; a hung shutdown fails the test instead of the run. */
export const PROCESS_TIMEOUT_MILLISECONDS = 30_000;

export type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type CLIProcess = {
	readonly exited: Promise<Exit>;
	/** The first match of the pattern in standard output, once it has been written. */
	readonly printed: (pattern: RegExp) => Promise<RegExpMatchArray>;
	readonly signal: (signal: NodeJS.Signals) => void;
	readonly stdout: () => string;
	readonly stderr: () => string;
};

/** The built command, with nothing of this process's environment but the search path. */
export function startCLI(args: readonly string[], environment: Environment): CLIProcess {
	const child = spawn(process.execPath, [BUILT_CLI.pathname, ...args], {
		env: { PATH: process.env['PATH'], ...environment },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', function(chunk: string) {
		stderr += chunk;
	});
	const exited = new Promise<Exit>(function(resolve) {
		child.once('exit', function(code, signal) {
			resolve({ code, signal });
		});
	});
	const waiting: (() => void)[] = [];
	child.stdout.on('data', function(chunk: string) {
		stdout += chunk;
		for (const check of waiting) {
			check();
		}
	});
	onTestFinished(function() {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
		}
	});
	return({
		exited,
		printed: function(pattern) {
			return(new Promise<RegExpMatchArray>(function(resolve, reject) {
				const check = function(): void {
					const match = stdout.match(pattern);
					if (match !== null) {
						resolve(match);
					}
				};
				waiting.push(check);
				check();
				void exited.then(function(exit) {
					reject(new Error(`the command exited (${JSON.stringify(exit)}) without printing ${String(pattern)}; it wrote ${JSON.stringify(stderr)}`));
				});
			}));
		},
		signal: function(signal) {
			child.kill(signal);
		},
		stdout: function() {
			return(stdout);
		},
		stderr: function() {
			return(stderr);
		}
	});
}

/** The line of the startup summary that names where the API is served. */
export const API_LINE: RegExp = /^api: (\S+)$/m;

