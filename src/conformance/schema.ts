import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';

const SCHEMA_FILE = new URL('../../conformance/vote-cases.schema.json', import.meta.url);

/*
 * The published JSON Schema is the language-neutral statement of the format;
 * the decoder in case.ts also checks what a schema cannot, such as which
 * steps a reference may name.
 */
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')));

/** Every violation of the published schema, as "path: message"; empty when the value conforms. */
export function schemaViolations(value: unknown): readonly string[] {
	if (validate(value)) {
		return([]);
	}
	return((validate.errors ?? []).map(function(error): string {
		return(`${error.instancePath}: ${error.message ?? error.keyword}`);
	}));
}
