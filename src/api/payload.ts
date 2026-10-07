/**
 * Reading a request body the client builds: the node reads the fields a
 * route lists and ignores any other, so that a client of another version
 * sending one more field is still served. A body without a listed field, or
 * with one of the wrong kind, is no request the client sends; it fails as
 * any other unanticipated input does.
 */

export class PayloadError extends Error {
	constructor(message: string) {
		super(`malformed request body: ${message}`);
		this.name = 'PayloadError';
	}
}

export type Payload = Readonly<Record<string, unknown>>;

export function asPayload(body: unknown): Payload {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw(new PayloadError('not a JSON object'));
	}
	// Checked above to be a non-array object; JSON gives it string keys only.
	return(body as Payload);
}

export function requiredString(payload: Payload, name: string): string {
	const value = payload[name];
	if (typeof value !== 'string') {
		throw(new PayloadError(`"${name}" is not a string`));
	}
	return(value);
}

export function optionalString(payload: Payload, name: string): string | undefined {
	if (payload[name] === undefined) {
		return(undefined);
	}
	return(requiredString(payload, name));
}

export function requiredStringList(payload: Payload, name: string): string[] {
	const value = payload[name];
	if (!Array.isArray(value)) {
		throw(new PayloadError(`"${name}" is not a list`));
	}
	return(value.map(function(entry: unknown, index): string {
		if (typeof entry !== 'string') {
			throw(new PayloadError(`"${name}"[${String(index)}] is not a string`));
		}
		return(entry);
	}));
}

export function optionalStringList(payload: Payload, name: string): string[] | undefined {
	if (payload[name] === undefined) {
		return(undefined);
	}
	return(requiredStringList(payload, name));
}

export function requiredObject(payload: Payload, name: string): Payload {
	const value = payload[name];
	try {
		return(asPayload(value));
	} catch {
		throw(new PayloadError(`"${name}" is not an object`));
	}
}
