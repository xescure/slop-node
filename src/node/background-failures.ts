import type { Logger } from '@keetanetwork/keetanet-client/lib/log/index.js';
import { newErrorID } from '../api/errors.js';

const LOG_SOURCE = 'node';

/** Removes the listener it was returned with. */
export type Uninstall = () => void;

/**
 * Until uninstalled, logs each promise rejection that nothing handles at
 * ERROR, in full, under a new error ID, instead of letting it end the
 * process. Upstream's switch starts work it handles only later, if ever: a
 * manual peer's check-in, at once and then on a timer
 * [Keeta TS] index.js:73770-73806, 73824-73831, and the rest of a broadcast
 * once one peer has the message [Keeta TS] index.js:74163-74165, 74472.
 * A storage failure in that work would otherwise stop a representative that
 * is serving, and restarting it would not make the storage healthier.
 */
export function logUnhandledRejections(log: Logger): Uninstall {
	const handle = function(reason: unknown): void {
		const errorID = newErrorID();
		log.error({ currentRequestInfo: { id: errorID } }, LOG_SOURCE, `Background work failed, and the node carries on (error ID: ${errorID}):`, reason);
	};
	process.on('unhandledRejection', handle);
	return(function(): void {
		process.off('unhandledRejection', handle);
	});
}

/**
 * Until uninstalled, notes at DEBUG a rejection handled after it was
 * reported unhandled, as the switch handles its work once it waits for it
 * [Keeta TS] index.js:73824-73831, where Node.js would print a warning on
 * the console.
 */
export function noteRejectionsHandledLate(log: Logger): Uninstall {
	const note = function(): void {
		log.debug(LOG_SOURCE, 'A rejection reported unhandled before has since been handled');
	};
	process.on('rejectionHandled', note);
	return(function(): void {
		process.off('rejectionHandled', note);
	});
}
