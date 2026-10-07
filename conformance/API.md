# The node HTTP API

`api/openapi.json` describes the HTTP API a KeetaNet node serves, as an OpenAPI 3.1 document. It is the contract the node's server follows, and the reference that live representatives are compared against.

## Sources

The document describes version 0.18.7 of `@keetanetwork/keetanet-client`:

- **Routes** come from the package's API typings. `api/index.d.ts` declares the route tree `rootTree`: each key is a path segment, `_root` stands for the subtree's own path, a `:name` key is a path parameter, and the methods are the leaves. Every route is served below `/api` [Keeta TS] index.js:61390. `api/node.d.ts`, `api/vote.d.ts` and `api/p2p.d.ts` type the handlers' arguments and results.
- **Shapes** come from the package's bundle, `client/index.js`. A response body is the handler's result passed through the package's JSON conversion: integers become `0x` and uppercase hexadecimal [Keeta TS] index.js:78420-78433, dates ISO 8601 strings [Keeta TS] index.js:78436-78437, bytes uppercase hexadecimal [Keeta TS] index.js:78439-78443, and library values their own `toJSON` [Keeta TS] index.js:78450-78453. Blocks, votes, quotes and staples at the top of a response also carry their binary encoding in `$binary`, which the client decodes [Keeta TS] index.js:58891, 58977, 59808, 59814, 59923. The document cites the bundle by line wherever it states behavior, and the typings by file where a shape is known only from them.
- **Request parameters** come from the client's own calls: the query parameters it sends, and how it encodes path parameters and bodies.

`src/conformance/api/routes.test.ts: "the document covers exactly the routes of the typings"` reads the route tree from the typings with the TypeScript compiler API and requires the document's operations to be exactly those routes.

## Validation against real responses

`src/conformance/api/responses.test.ts` validates real responses against the document with Ajv in the JSON Schema 2020-12 dialect, each against the schema the document gives for its route and status:

- **Mainnet captures** (`api/mainnet/`): every captured body validates; together the captures cover every GET route but one (see below); every capture is JSON; and every status a representative answered with is one the operation documents.
- **Fixtures** (`api/fixtures/`): every fixture validates against its route's 200 schema.
- **Library serialization:** every block, vote and staple in a captured body or a fixture is exactly what the package's JSON conversion with `addBinary` makes of the value its `$binary` encodes [Keeta TS] index.js:78476-78481, 63910-63939, 80606-80630, 81088-81101.
- **History pages:** the `$id` of each entry is the hash of its staple's blocks [Keeta TS] index.js:81044-81053, and `nextKey` is the `$id` of the page's last entry.
- **POST routes**, which the capture never sends: request bodies are built locally the way the client builds them, from blocks, votes, quotes and staples made by the package on a local test network, and validate against the request schemas: `POST /api/vote/quote` [Keeta TS] index.js:59844-59849, `POST /api/vote` with another representative's vote and a quote [Keeta TS] index.js:59852-59866, 59775, `POST /api/node/publish` [Keeta TS] index.js:58481-58485 and `POST /api/p2p/message` with an `add` message and a representative's greeting [Keeta TS] index.js:71402-71404, 73043-73047, 72200-72212. The quote and the vote the local ledger returns validate against the response schemas once serialized as above, and so does a refused vote's error in the envelope every captured failure has.

### Mainnet captures

`api/mainnet/` holds one file per request, named after it. A file is a JSON object with sorted keys, indented by two spaces and ending in a line feed:

| Field | Holds |
|---|---|
| `request` | `method` (always `GET`), `path` as sent, with each path parameter percent-encoded as the client encodes it [Keeta TS] index.js:59717-59725, and `query`, the query parameters |
| `status` | the HTTP status |
| `headers` | `content-type` |
| `body` | the body, parsed as JSON |

The capture was made on 2026-10-07 between 08:44:15 and 08:44:54 UTC from `https://rep1.main.network.api.keeta.com/api`, a representative of the Keeta mainnet, network `0x5382` [Keeta TS] index.js:61293-61298. `GET /api/node/version` reported the version `0.18.4+gbd3f30c7e7903e4990e5a283f15c23d0df18bbb4`.

The capture made 50 HTTP GET requests, one at a time with half a second between them, and nothing else: it published nothing, asked for no vote or quote and sent no peer message. `GET /api/node/ledger/clearstats` was not requested: it clears the representative's statistics, so it changes the representative's state although it is a GET.

The requests name accounts, blocks and a token that `mainnet/head.state.jsonl` lists, chosen by fixed rules:

- the base token, which most accounts hold
- the first account with a secp256k1 key, a chain, a representative and at least two balances, and the head block the dump gives it, which has since gained a successor
- the network address
- the multisig account, which is also the principal for the permission routes, with the base token as entity
- the representative with the most weight

Where a request needs a value only an earlier response holds, it takes it from there: the `start` of a second history page is the `nextKey` of the first, as the client pages [Keeta TS] index.js:58986-58995.

Some requests name values that do not exist or are malformed. The representative answered them as follows:

| Request | Status | Answer |
|---|---|---|
| a block, its successor or its votes, by a well-formed hash no block has | 200 | `block`, `successorBlock` or `votes` null |
| a block or its votes on the side ledger, for a confirmed block | 200 | `block` or `votes` null |
| an account no block has touched, its state or its head | 200 | a state with null head, no balances and empty info; a head with null block and height |
| a malformed account, alone or in a list | 200 | `{"account", "error"}` in place of that account's state |
| a certificate by a hash the account does not hold | 200 | `certificate` and `intermediates` null |
| a block by an idempotent key no block has | 200 | `block` null |
| bootstrap votes without `start` | 500 | `API_START_MISSING` |
| history, of the ledger or of an account, with `limit=0` | 500 | `API_LIMIT_NOT_GREATER_THAN_ZERO` |
| a block with `side=neither` | 500 | `API_INVALID_SIDE` |
| a block or its votes by a malformed hash | 500 | only `error` and a message naming an error ID |

Every failure the representative reported had status 500, whether it refused the request or failed to serve it, and the body of every failure had `"error": true`, so the document gives each operation a 200 and a 500 response.

To capture again, run:

```
utils/capture-api-responses conformance/mainnet/head.state.jsonl conformance/api/mainnet
```

It needs only Python's standard library. It writes into a directory beside the output and replaces the output only once every request has been answered, so a request that fails to connect or times out (after 60 seconds) leaves the previous capture in place. A later capture differs in its bodies, because the ledger keeps moving, and the test then checks the new bodies.

### Fixtures

`api/fixtures/` holds eight responses that mainnet representatives served, as recorded in the test suite of an independent node implementation and copied here byte for byte:

| File | Route |
|---|---|
| `account_base_token.json`, `account_storage.json`, `account_with_representative.json` | `GET /api/node/ledger/account/{account}` |
| `acl_granted_base_token.json` | `GET /api/node/ledger/account/{account}/acl/granted` |
| `balance.json` | `GET /api/node/ledger/account/{account}/balance` |
| `head_base_token.json`, `head_no_chain.json` | `GET /api/node/ledger/account/{account}/head` |
| `representatives.json` | `GET /api/node/ledger/representatives` |

They cover a storage account, which the capture does not request.

## Differences

Places where the document deliberately differs from what a live representative returns, and places where the typings and live responses disagree.

- **Malformed parameters.** The document's parameter schemas describe the values the client sends: well-formed accounts and hashes, positive limits, and `main` or `side`. A representative also answers requests outside them, as the table above shows: a malformed account with a 200 and an `{"account", "error"}` object, and a malformed hash, a zero limit or another side with a 500. These answers validate against the documented 200 and 500 responses.

No captured response or fixture disagrees with the typings. Where the typings give only `string`, the document states the form every captured response has, which is narrower:

- **History entries.** `$id` is the hash of the staple's blocks in uppercase hexadecimal, and `$timestamp` an ISO 8601 date (api/node.d.ts, GetAccountHistoryResponse). `$timestamp` is not the staple's own timestamp, the average of its votes' validity [Keeta TS] index.js:81061-81087.
- **Statistics.** `ledger.moment` of `GET /api/node/stats` is an ISO 8601 date (lib/ledger/types.d.ts, LedgerStatistics).
