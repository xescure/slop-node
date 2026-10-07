import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { Environment } from '../node/config.js';
import { assertNever } from '../util/assert-never.js';

/** How the node is run: the program and the arguments before the command. */
export type NodeCommand = {
	readonly program: string;
	readonly leadingArgs: readonly string[];
};

/** The node's subcommands the devnet runs. */
export type NodeSubcommand = 'run' | 'genesis';

export type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

/**
 * The built node run by this Node.js, which is the code path of the package,
 * unless DEVNET_BINARY names a program to run instead, such as the package's
 * own bin/slop-node.
 */
export function nodeCommandOf(environment: NodeJS.ProcessEnv, builtCLI: URL): NodeCommand {
	const binary = environment['DEVNET_BINARY'];
	if (binary !== undefined && binary !== '') {
		return({ program: binary, leadingArgs: [] });
	}
	return({ program: process.execPath, leadingArgs: [builtCLI.pathname] });
}

type Stream = 'stdout' | 'stderr';

type NodeChild = ChildProcessByStdio<null, Readable, Readable>;

/** Children still running, killed outright if this process exits before stopping them. */
const running = new Set<NodeChild>();

process.on('exit', function() {
	for (const child of running) {
		child.kill('SIGKILL');
	}
});

/** The last lines of a log, to put in a failure. */
export async function logTail(path: string, lines: number): Promise<string> {
	let text: string;
	try {
		text = await readFile(path, 'utf-8');
	} catch (error: unknown) {
		return(`(no log at ${path}: ${String(error)})`);
	}
	return(text.split('\n').slice(-lines - 1).join('\n'));
}

/**
 * A node process with nothing of this process's environment but the search
 * path. Each line it writes is appended to its log, marked with its stream,
 * and kept to be matched.
 */
export class NodeProcess {
	readonly processID: number;
	readonly exited: Promise<Exit>;
	readonly logPath: string;
	readonly #child: NodeChild;
	readonly #waiting = new Set<() => void>();
	#stdout = '';
	#stderr = '';

	private constructor(child: NodeChild, processID: number, logPath: string) {
		this.#child = child;
		this.processID = processID;
		this.logPath = logPath;
		this.exited = new Promise<Exit>((resolve) => {
			child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
				running.delete(child);
				this.#log('exit', `exited with ${JSON.stringify({ code, signal })}`);
				resolve({ code, signal });
			});
		});
		this.#capture(child.stdout, 'stdout');
		this.#capture(child.stderr, 'stderr');
	}

	static spawn(command: NodeCommand, subcommand: NodeSubcommand, environment: Environment, logPath: string): NodeProcess {
		const child = spawn(command.program, [...command.leadingArgs, subcommand], {
			env: { PATH: process.env['PATH'], ...environment },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const processID = child.pid;
		if (processID === undefined) {
			// The reason arrives as an event, which would otherwise end this process.
			child.once('error', function() {
				// The failure is thrown here instead.
			});
			throw(new Error(`${command.program} could not be started`));
		}
		running.add(child);
		appendFileSync(logPath, `--- ${new Date().toISOString()} ${subcommand}, process ${String(processID)}\n`);
		return(new NodeProcess(child, processID, logPath));
	}

	get stdout(): string {
		return(this.#stdout);
	}

	get stderr(): string {
		return(this.#stderr);
	}

	/** The first match of the pattern in standard output, once written; refused if the process exits first. */
	printed(pattern: RegExp): Promise<RegExpMatchArray> {
		return(new Promise<RegExpMatchArray>((resolve, reject) => {
			const check = (): void => {
				const match = this.#stdout.match(pattern);
				if (match !== null) {
					this.#waiting.delete(check);
					resolve(match);
				}
			};
			this.#waiting.add(check);
			check();
			void this.exited.then((exit) => {
				this.#waiting.delete(check);
				reject(new Error(`the node exited (${JSON.stringify(exit)}) without printing ${String(pattern)}; its log is ${this.logPath}`));
			});
		}));
	}

	signal(signal: NodeJS.Signals): void {
		this.#child.kill(signal);
	}

	#capture(stream: Readable, name: Stream): void {
		let partial = '';
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			switch (name) {
				case 'stdout':
					this.#stdout += chunk;
					for (const check of [...this.#waiting]) {
						check();
					}
					break;
				case 'stderr':
					this.#stderr += chunk;
					break;
				default:
					assertNever(name);
			}
			const lines = (partial + chunk).split('\n');
			partial = lines.pop() ?? '';
			for (const line of lines) {
				this.#log(name, line);
			}
		});
		stream.on('end', () => {
			if (partial !== '') {
				this.#log(name, partial);
			}
		});
	}

	#log(stream: Stream | 'exit', line: string): void {
		appendFileSync(this.logPath, `${stream}| ${line}\n`);
	}
}
