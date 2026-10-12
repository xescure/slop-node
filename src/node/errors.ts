import type { Networks } from '@keetanetwork/keetanet-client/config/index.js';
import { assertNever } from '../util/assert-never.js';
import type { PeerArena } from './peer-store.js';

/** Why a LocalNode refused a lifecycle step. */
export type LocalNodeProblem =
	| { readonly kind: 'already-running' }
	| { readonly kind: 'routes-already-mounted'; readonly mountedPrefix: string; readonly requestedPrefix: string }
	| { readonly kind: 'no-address-to-advertise'; readonly listenIP: string | undefined }
	| { readonly kind: 'invalid-endpoint'; readonly endpoint: string }
	| { readonly kind: 'manual-peers-on-closed-network'; readonly network: Networks; readonly peers: number }
	| { readonly kind: 'remembered-peers-on-closed-network'; readonly network: Networks; readonly arenas: readonly PeerArena[] };

function describeProblem(problem: LocalNodeProblem): string {
	switch (problem.kind) {
		case 'already-running':
			return('the node is already running');
		case 'routes-already-mounted':
			return(`the API is already served below ${problem.mountedPrefix}, so it cannot also be served below ${problem.requestedPrefix}`);
		case 'no-address-to-advertise':
			return(`the node listens on every interface (${problem.listenIP ?? 'no address given'}), so it cannot tell peers where to reach it; configure its endpoints`);
		case 'invalid-endpoint':
			return(`the endpoint ${problem.endpoint} is not a URL`);
		case 'manual-peers-on-closed-network':
			return(`the node keeps its peer-to-peer surface closed on the ${problem.network} network, so it dials none of the ${String(problem.peers)} manual peers it was given`);
		case 'remembered-peers-on-closed-network':
			return(`the node keeps its peer-to-peer surface closed on the ${problem.network} network, but its store remembers peers (in ${problem.arenas.join(', ')}), which its switch would dial; forget them first ("slop-node clear-peers")`);
		default:
			return(assertNever(problem));
	}
}

export class LocalNodeError extends Error {
	readonly problem: LocalNodeProblem;

	constructor(problem: LocalNodeProblem, options?: ErrorOptions) {
		super(describeProblem(problem), options);
		this.name = 'LocalNodeError';
		this.problem = problem;
	}
}
