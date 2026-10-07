import { assertNever } from './assert-never.js';

type HoldKind = 'shared' | 'exclusive';

type Waiter = {
	readonly kind: HoldKind;
	readonly admit: () => void;
};

/**
 * Lets any number of shared holders in together, or one exclusive holder
 * alone. Holders are admitted in the order they arrive, so an exclusive
 * holder that waits is never overtaken by shared holders that arrive after it.
 */
export class SharedExclusiveGate {
	#sharedInside = 0;
	#exclusiveInside = false;
	readonly #waiting: Waiter[] = [];

	shared<Result>(work: () => Promise<Result>): Promise<Result> {
		return(this.#run('shared', work));
	}

	exclusive<Result>(work: () => Promise<Result>): Promise<Result> {
		return(this.#run('exclusive', work));
	}

	async #run<Result>(kind: HoldKind, work: () => Promise<Result>): Promise<Result> {
		await this.#enter(kind);
		try {
			return(await work());
		} finally {
			this.#leave(kind);
		}
	}

	#mayEnter(kind: HoldKind): boolean {
		switch (kind) {
			case 'shared':
				return(!this.#exclusiveInside);
			case 'exclusive':
				return(!this.#exclusiveInside && this.#sharedInside === 0);
			default:
				return(assertNever(kind));
		}
	}

	#admit(kind: HoldKind): void {
		switch (kind) {
			case 'shared':
				this.#sharedInside++;
				return;
			case 'exclusive':
				this.#exclusiveInside = true;
				return;
			default:
				assertNever(kind);
		}
	}

	#enter(kind: HoldKind): Promise<void> {
		if (this.#waiting.length === 0 && this.#mayEnter(kind)) {
			this.#admit(kind);
			return(Promise.resolve());
		}
		return(new Promise<void>((resolve) => {
			this.#waiting.push({ kind, admit: resolve });
		}));
	}

	#leave(kind: HoldKind): void {
		switch (kind) {
			case 'shared':
				this.#sharedInside--;
				break;
			case 'exclusive':
				this.#exclusiveInside = false;
				break;
			default:
				assertNever(kind);
		}
		for (let next = this.#waiting[0]; next !== undefined && this.#mayEnter(next.kind); next = this.#waiting[0]) {
			this.#waiting.shift();
			this.#admit(next.kind);
			next.admit();
		}
	}
}
