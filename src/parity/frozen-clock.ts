/**
 * The ledger reads the time as "new Date()" and "Date.now()" when it votes.
 * A shadow vote must run at the staple's own moment, as a representative
 * asked then would, so the process's Date is replaced while it runs, as a
 * test's frozen clock does (src/testing/network.ts). Timers are left alone,
 * so whatever else the process awaits keeps its own pace.
 */
const RealDate: DateConstructor = globalThis.Date;

function frozenDate(at: number): DateConstructor {
	return(new Proxy(RealDate, {
		construct(target, args: readonly unknown[]): object {
			const [value] = args;
			if (args.length === 0) {
				return(new target(at));
			}
			if (args.length === 1 && (typeof value === 'number' || typeof value === 'string' || value instanceof RealDate)) {
				return(new target(value));
			}
			// The year, month and the rest, in local time.
			const [year = 0, month = 0, day = 1, hours = 0, minutes = 0, seconds = 0, milliseconds = 0] = args.map(Number);
			return(new target(year, month, day, hours, minutes, seconds, milliseconds));
		},
		apply(): string {
			return(new RealDate(at).toString());
		},
		get(target, property, receiver): unknown {
			if (property === 'now') {
				return(function(): number {
					return(at);
				});
			}
			return(Reflect.get(target, property, receiver));
		}
	}));
}

/** Runs with the clock stopped at the moment; the real clock is back once it ends, however it ends. */
export async function atMoment<Result>(moment: Date, run: () => Promise<Result>): Promise<Result> {
	const previous = globalThis.Date;
	globalThis.Date = frozenDate(moment.getTime());
	try {
		return(await run());
	} finally {
		globalThis.Date = previous;
	}
}
