/** A JSON object's fields, as an answer or a log line holds them. */
export type Fields = Readonly<Record<string, unknown>>;

export function isFields(value: unknown): value is Fields {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

export function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return(error.message);
	}
	return(String(error));
}

export function isoOrNull(moment: Date | undefined): string | null {
	if (moment === undefined) {
		return(null);
	}
	return(moment.toISOString());
}

/** Read through a call, as a signal is aborted while the caller awaits, which a check of its field before the await would not show. */
export function isStopped(signal: AbortSignal): boolean {
	return(signal.aborted);
}
