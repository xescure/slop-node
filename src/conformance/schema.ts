import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';

type Violations = (value: unknown) => readonly string[];

/*
 * The published JSON Schemas are the language-neutral statements of the
 * formats; the decoders also check what a schema cannot, such as which steps
 * a reference may name or the order of a dump's records.
 */
function compileSchema(file: URL): Violations {
	const validate = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(readFileSync(file, 'utf8')));
	return(function(value: unknown): readonly string[] {
		if (validate(value)) {
			return([]);
		}
		return((validate.errors ?? []).map(function(error): string {
			return(`${error.instancePath}: ${error.message ?? error.keyword}`);
		}));
	});
}

/** Every violation of the vote-case schema, as "path: message"; empty when the value conforms. */
export const voteCaseViolations: Violations = compileSchema(new URL('../../conformance/vote-cases.schema.json', import.meta.url));

/** Every violation of the state-dump schema by one line of a dump, as "path: message"; empty when the line conforms. */
export const stateDumpViolations: Violations = compileSchema(new URL('../../conformance/state-dump.schema.json', import.meta.url));
