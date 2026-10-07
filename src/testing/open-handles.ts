import { createHook } from 'node:async_hooks';

/** The kinds of resource that keep the process alive: timers, TCP servers and TCP sockets. */
const WATCHED_TYPES: ReadonlySet<string> = new Set(['Timeout', 'TCPSERVERWRAP', 'TCPWRAP']);

/** Turns of the event loop that closing handles get to be released in; two were enough on loopback. */
const RELEASE_TURNS = 10;

export type OpenHandleWatch = {
	/** The resources created since watching began that still keep the process alive, by type. */
	readonly open: () => Promise<readonly string[]>;
};

/** A timer, which may have been told not to keep the process alive. */
type Referable = { hasRef(): boolean };

function isReferable(resource: object): resource is Referable {
	return('hasRef' in resource && typeof resource.hasRef === 'function');
}

function keepsProcessAlive(resource: object): boolean {
	if (isReferable(resource)) {
		return(resource.hasRef());
	}
	return(true);
}

function yieldTurn(): Promise<void> {
	return(new Promise<void>(function(resolve) {
		setImmediate(resolve);
	}));
}

/**
 * Records every timer and TCP handle created from now on, as Jest's
 * --detectOpenHandles does, and forgets each one that is destroyed. A handle
 * closed during a turn of the event loop is destroyed only after that turn's
 * close callbacks, and a peer's socket once the end of its connection has
 * been read, so open() first lets a few turns run, with no time passing.
 */
export function watchOpenHandles(): OpenHandleWatch {
	const live = new Map<number, { readonly type: string; readonly resource: object }>();
	const hook = createHook({
		init: function(asyncID: number, type: string, _ignoredTrigger: number, resource: object): void {
			if (WATCHED_TYPES.has(type)) {
				live.set(asyncID, { type, resource });
			}
		},
		destroy: function(asyncID: number): void {
			live.delete(asyncID);
		}
	});
	hook.enable();

	function stillOpen(): string[] {
		return([...live.values()].filter(function({ resource }): boolean {
			return(keepsProcessAlive(resource));
		}).map(function({ type }): string {
			return(type);
		}).sort());
	}

	async function open(): Promise<readonly string[]> {
		for (let turn = 0; turn < RELEASE_TURNS && stillOpen().length > 0; turn++) {
			await yieldTurn();
		}
		hook.disable();
		return(stillOpen());
	}

	return({ open });
}
