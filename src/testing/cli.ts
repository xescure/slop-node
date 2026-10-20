import { spawn } from 'node:child_process';
import { onTestFinished } from 'vitest';
import type { Environment } from '../node/config.js';
import { assertNever } from '../util/assert-never.js';

/*
 * The command as built, which "make test" builds first, so that what is
 * tested is what the package runs.
 */
const BUILT_CLI = new URL('../../dist/main.js', import.meta.url);

export type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type OutputStream = 'stdout' | 'stderr';

export type CLIProcess = {
	readonly exited: Promise<Exit>;
	/** The first match of the pattern in standard output, or in standard error, once it has been written. */
	readonly printed: (pattern: RegExp, stream?: OutputStream) => Promise<RegExpMatchArray>;
	readonly signal: (signal: NodeJS.Signals) => void;
	readonly stdout: () => string;
	readonly stderr: () => string;
};

/** The built command, with nothing of this process's environment but the search path. */
export function startCLI(args: readonly string[], environment: Environment, command: URL = BUILT_CLI): CLIProcess {
	const child = spawn(process.execPath, [command.pathname, ...args], {
		env: { PATH: process.env['PATH'], ...environment },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	const waiting: (() => void)[] = [];
	const wake = function(): void {
		for (const check of waiting) {
			check();
		}
	};
	child.stderr.on('data', function(chunk: string) {
		stderr += chunk;
		wake();
	});
	const exited = new Promise<Exit>(function(resolve) {
		child.once('exit', function(code, signal) {
			resolve({ code, signal });
		});
	});
	child.stdout.on('data', function(chunk: string) {
		stdout += chunk;
		wake();
	});
	onTestFinished(function() {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
		}
	});
	return({
		exited,
		printed: function(pattern, stream = 'stdout') {
			const written = function(): string {
				switch (stream) {
					case 'stdout':
						return(stdout);
					case 'stderr':
						return(stderr);
					default:
						return(assertNever(stream));
				}
			};
			return(new Promise<RegExpMatchArray>(function(resolve, reject) {
				const check = function(): void {
					const match = written().match(pattern);
					if (match !== null) {
						resolve(match);
					}
				};
				waiting.push(check);
				check();
				void exited.then(function(exit) {
					reject(new Error(`the command exited (${JSON.stringify(exit)}) without printing ${String(pattern)} to ${stream}; it wrote ${JSON.stringify(stderr)}`));
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

/** The line of the startup summary that names the node as another names it in KEETANET_LOCAL_NODE_MANUAL_PEERS. */
export const PEER_LINE: RegExp = /^peer: (\S+)$/m;
