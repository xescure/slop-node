import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { documentRoutes } from './routes.js';
import type { Route } from './routes.js';

const DOCUMENT_FILE = new URL('../../../api/openapi.json', import.meta.url);

/** The key the document is registered under, so its schemas are reached as fragments of it. */
const DOCUMENT_ID = 'openapi.json';

/** The OpenAPI fields at the top of the document; they hold no schema of their own. */
const OPENAPI_TOP_LEVEL_FIELDS = ['openapi', 'info', 'jsonSchemaDialect', 'paths', 'components'];

const JSON_MEDIA_TYPE = 'application/json';

const RESPONSE_REF_PREFIX = '#/components/responses/';

type JSONObject = Readonly<Record<string, unknown>>;

export function isJSONObject(value: unknown): value is JSONObject {
	return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

function field(object: JSONObject, name: string, where: string): JSONObject {
	const value = object[name];
	if (!isJSONObject(value)) {
		throw(new Error(`${where} has no "${name}" object`));
	}
	return(value);
}

/** One reference token of a JSON pointer, escaped as RFC 6901 asks and then as a URI fragment. */
function pointerToken(token: string): string {
	return(encodeURIComponent(token.replaceAll('~', '~0').replaceAll('/', '~1')));
}

function pointer(tokens: readonly string[]): string {
	return(`#/${tokens.map(pointerToken).join('/')}`);
}

export type Violations = readonly string[];

/** The node API document, with its request and response schemas compiled for validation. */
export class APIDocument {
	readonly document: JSONObject;
	readonly routes: readonly Route[];
	readonly #ajv: Ajv2020;

	constructor(file: URL = DOCUMENT_FILE) {
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (!isJSONObject(parsed)) {
			throw(new Error('the document is not an object'));
		}
		this.document = parsed;
		this.routes = documentRoutes(parsed);
		this.#ajv = new Ajv2020({ strict: true, allErrors: true });
		this.#ajv.addVocabulary(OPENAPI_TOP_LEVEL_FIELDS);
		this.#ajv.addSchema(parsed, DOCUMENT_ID);
	}

	#operation(route: Route): JSONObject {
		const where = `${route.method} ${route.path}`;
		return(field(field(field(this.document, 'paths', 'the document'), route.path, 'paths'), route.method.toLowerCase(), where));
	}

	#validate(tokens: readonly string[], value: unknown): Violations {
		const location = `${DOCUMENT_ID}${pointer(tokens)}`;
		const validate = this.#ajv.getSchema(location);
		if (validate === undefined) {
			throw(new Error(`no schema at ${location}`));
		}
		if (validate(value)) {
			return([]);
		}
		return((validate.errors ?? []).map(function(error): string {
			return(`${error.instancePath}: ${error.message ?? error.keyword}`);
		}));
	}

	/** Every way a value breaks the document's schema of that name. */
	schemaViolations(name: string, value: unknown): Violations {
		return(this.#validate(['components', 'schemas', name], value));
	}

	/** The statuses an operation documents, as the document spells them. */
	statuses(route: Route): readonly string[] {
		return(Object.keys(field(this.#operation(route), 'responses', `${route.method} ${route.path}`)));
	}

	/**
	 * Every way a response body breaks the document's schema for the route
	 * and status; a status the operation does not list is itself a violation.
	 */
	responseViolations(route: Route, status: number, body: unknown): Violations {
		const where = `${route.method} ${route.path}`;
		const responses = field(this.#operation(route), 'responses', where);
		const code = String(status);
		const response = responses[code];
		if (!isJSONObject(response)) {
			return([`${where} documents no ${code} response`]);
		}
		let tokens = ['paths', route.path, route.method.toLowerCase(), 'responses', code];
		const ref = response['$ref'];
		if (typeof ref === 'string') {
			if (!ref.startsWith(RESPONSE_REF_PREFIX)) {
				throw(new Error(`${where} ${code}: unexpected reference ${ref}`));
			}
			tokens = ['components', 'responses', ref.slice(RESPONSE_REF_PREFIX.length)];
		}
		return(this.#validate([...tokens, 'content', JSON_MEDIA_TYPE, 'schema'], body));
	}

	/** Every way a request body breaks the document's schema for the route. */
	requestViolations(route: Route, body: unknown): Violations {
		return(this.#validate(['paths', route.path, route.method.toLowerCase(), 'requestBody', 'content', JSON_MEDIA_TYPE, 'schema'], body));
	}
}
