import { assertNever } from '../util/assert-never.js';

/** Why a LocalNode refused a lifecycle step. */
export type LocalNodeProblem =
	| { readonly kind: 'already-running' }
	| { readonly kind: 'routes-already-mounted'; readonly mountedPrefix: string; readonly requestedPrefix: string }
	| { readonly kind: 'no-address-to-advertise'; readonly listenIP: string | undefined }
	| { readonly kind: 'invalid-endpoint'; readonly endpoint: string };

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
