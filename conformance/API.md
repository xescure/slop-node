# The node HTTP API

`api/openapi.json` describes the HTTP API a KeetaNet node serves, as an OpenAPI 3.1 document. It is the contract the node's server follows, and the reference that live representatives are compared against.

## Sources

The document describes version 0.18.7 of `@keetanetwork/keetanet-client`:

- **Routes** come from the package's API typings. `api/index.d.ts` declares the route tree `rootTree`: each key is a path segment, `_root` stands for the subtree's own path, a `:name` key is a path parameter, and the methods are the leaves. Every route is served below `/api` [Keeta TS] index.js:61390. `api/node.d.ts`, `api/vote.d.ts` and `api/p2p.d.ts` type the handlers' arguments and results.
- **Shapes** come from the package's bundle, `client/index.js`. A response body is the handler's result passed through the package's JSON conversion: integers become `0x` and uppercase hexadecimal [Keeta TS] index.js:78420-78433, dates ISO 8601 strings [Keeta TS] index.js:78436-78437, bytes uppercase hexadecimal [Keeta TS] index.js:78439-78443, and library values their own `toJSON` [Keeta TS] index.js:78450-78453. Blocks, votes, quotes and staples at the top of a response also carry their binary encoding in `$binary`, which the client decodes [Keeta TS] index.js:58891, 58977, 59808, 59814, 59923. The document cites the bundle by line wherever it states behavior, and the typings by file where a shape is known only from them.
- **Request parameters** come from the client's own calls: the query parameters it sends, and how it encodes path parameters and bodies.

`src/conformance/api/routes.test.ts: "the document covers exactly the routes of the typings"` reads the route tree from the typings with the TypeScript compiler API and requires the document's operations to be exactly those routes.

## Closed and open objects

Every object in a response is closed (`"additionalProperties": false`) and lists every field the package writes into it, so a field the document does not name is an error in the response. That includes the two objects whose fields the package writes in several places:

- **`Certificate`**, the certificate an operation carries, lists the fields a certificate writes [Keeta TS] index.js:78141-78167, down to each base extension the package parses [Keeta TS] index.js:78236-78275. An operation always includes the PEM text in `$binary` [Keeta TS] index.js:65760-65767.
- **`Error`** is closed in each of its two forms. A refusal lists every field a KeetaNet error writes or the client reads back [Keeta TS] index.js:66067-66073, 66533-66540, 66575-66590, 66334-66410, and an internal failure is exactly `error` and `message`.

The request bodies of `POST /api/vote`, `POST /api/vote/quote`, `POST /api/node/publish` and `POST /api/p2p/message` are the only open objects. The client sends exactly the fields each lists [Keeta TS] index.js:59844-59849, 59852-59866, 58481-58485, 72209-72212; the node reads those and ignores any other, so a client of another version that sends one more field is still served.

The vote request's lists have a lower bound where something enforces one: `blocks` holds at least one block, because the ledger issues no vote for none [Keeta TS] index.js:69012-69015, and `votes`, when present, at least one vote, because the client refuses to ask with an empty list [Keeta TS] index.js:59861-59863. The quote request's `blocks` has none: the client sends the list it is given [Keeta TS] index.js:59844-59849, and the ledger's quote, unlike its vote, makes no such check [Keeta TS] index.js:69356-69360.

## Validation against real responses

`src/conformance/api/responses.test.ts` validates real responses against the document with Ajv in the JSON Schema 2020-12 dialect, each against the schema the document gives for its route and status:

- **Mainnet captures** (`api/mainnet/`): every captured body validates; together the captures cover every GET route but one (see below); every capture is JSON; and every status a representative answered with is one the operation documents.
- **Capture parameters:** every capture's path parameters, decoded, and query parameters are parameters of its operation and validate against their schemas, apart from the captures that send a malformed value on purpose (see the table below), each of which breaks exactly the one parameter it is meant to.
- **One page, two routes:** a page of an account's history is the same whether the staple it continues after is named in the path or in `start`.
- **Fixtures** (`api/fixtures/`): every fixture validates against its route's 200 schema.
- **Library serialization:** every block, vote and staple in a captured body or a fixture is exactly what the package's JSON conversion with `addBinary` makes of the value its `$binary` encodes [Keeta TS] index.js:78476-78481, 63910-63939, 80606-80630, 81088-81101.
- **Votes and quotes:** a quote is told from a vote by `quote`, which is true for a quote and false or absent for a vote, and a quote always carries its fee [Keeta TS] index.js:80213-80218, 80660-80662, 80696-80698; the local quote and vote each validate only as their own kind.
- **Certificates:** every certificate and intermediate a representative served is PEM text, and parses into exactly the fields `Certificate` lists; a block adding a certificate authority's certificate, made locally, validates as a block.
- **History pages:** the `$id` of each entry is the hash of its staple's blocks [Keeta TS] index.js:81044-81053, and `nextKey` is the `$id` of the page's last entry or, for a page without entries, the `start` it was asked for.
- **POST routes**, which the capture never sends: request bodies are built locally the way the client builds them, from blocks, votes, quotes and staples made by the package on a local test network, and validate against the request schemas: `POST /api/vote/quote` [Keeta TS] index.js:59844-59849, `POST /api/vote` with another representative's vote and a quote [Keeta TS] index.js:59852-59866, 59775, `POST /api/node/publish` [Keeta TS] index.js:58481-58485 and `POST /api/p2p/message` with an `add` message and a representative's greeting [Keeta TS] index.js:71402-71404, 73043-73047, 72200-72212. The quote and the vote the local ledger returns validate against the response schemas once serialized as above, and the error the ledger refuses a vote with, `LEDGER_NOT_SUCCESSOR`, validates as a refusal in the envelope every captured failure has.

### Mainnet captures

`api/mainnet/` holds one file per request, named after it. A file is a JSON object with sorted keys, indented by two spaces and ending in a line feed:

| Field | Holds |
|---|---|
| `request` | `method` (always `GET`), `path` as sent, with each path parameter percent-encoded as the client encodes it [Keeta TS] index.js:59717-59725, and `query`, the query parameters |
| `status` | the HTTP status |
| `headers` | `content-type` |
| `body` | the body, parsed as JSON |

The capture was made on 2026-10-07 between 08:44:15 and 08:44:54 UTC from `https://rep1.main.network.api.keeta.com/api`, a representative of the Keeta mainnet, network `0x5382` [Keeta TS] index.js:61293-61298. `GET /api/node/version` reported the version `0.18.4+gbd3f30c7e7903e4990e5a283f15c23d0df18bbb4`. The three pages of the account's history were captured again from the same representative on 2026-10-07 between 09:16:09 and 09:16:12 UTC, with one staple to a page rather than two, since a single staple of this account can hold a block of several hundred operations.

A third run, on 2026-10-07 between 10:36:51 and 10:39:24 UTC, captured the requests that probe how the representative reads limits, sides, starts and ends, and where paging stops (the rows of the table below from the bootstrap with a `start` that is no date onwards). It made 26 requests in three passes while their list was settled; each file holds the answer to the last request of its name.

The capture made 50 HTTP GET requests, the second run 3 and the third 26, one at a time with half a second between them, and nothing else: it published nothing, asked for no vote or quote and sent no peer message. `GET /api/node/ledger/clearstats` was not requested: it clears the representative's statistics, so it changes the representative's state although it is a GET.

The requests name accounts, blocks and a token that `mainnet/head.state.jsonl` lists, chosen by fixed rules:

- the base token, which most accounts hold
- the first account with a secp256k1 key, a chain, a representative and at least two balances, and the head block the dump gives it, which has since gained a successor
- the network address
- the multisig account, which is also the principal for the permission routes, with the base token as entity
- the representative with the most weight

Where a request needs a value only an earlier response holds, it takes it from there: the `start` of a second history page is the `nextKey` of the first, as the client pages [Keeta TS] index.js:58986-58995; the `end` of a range of the chain is the `nextKey` of the chain page that starts at the account's head block in the head; and the `start` of the last pages of the ledger's history is the hash of the blocks of the second staple a bootstrap from the epoch returns, the SHA3-256 of its blocks' hashes [Keeta TS] index.js:80126-80135, 78985.

Some requests name values that do not exist or are malformed, or probe where pages stop. The representative answered them as follows:

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
| bootstrap votes with a `start` that is no date (`yesterday`) | 500 | only `error` and a message naming an error ID |
| a block with an empty `side` | 500 | `API_INVALID_SIDE` |
| history with `limit=-1`, or with an empty `limit` | 500 | `API_LIMIT_NOT_GREATER_THAN_ZERO` |
| history with `limit=abc` | 500 | `API_LIMIT_NOT_NUMBER` |
| history with `limit=1.5`, or with `limit=0.5` | 200 | one staple, or none |
| the chain, or bootstrap votes, with `limit=1.5` | 200 | two blocks, or two staples |
| the chain from a block to an `end` two blocks older | 200 | three blocks, `end` the last, and `nextKey` null |
| the same range with `limit=2` | 200 | two blocks, and `nextKey` the `end` |
| the ledger's history after its third-oldest staple, with no `limit`, and with `limit=2` | 200 | the two oldest staples, and `nextKey` the last of them |
| the ledger's history after its oldest staple | 200 | no staples, and `nextKey` the `start` |

A representative lists an account's balances by token, the permissions a principal holds by entity, the permissions on an entity by principal, and the votes for a block by `$id`, each in the order of the strings' character codes.

The order of a block's votes is provisional. One capture supports it, a block with four votes. A staple orders its own votes by vote hash [Keeta TS] index.js:80752-80763, so the representative sorts them again when it answers, and `$id`, the hash of the vote's issuer and serial [Keeta TS] index.js:80569-80570, is the key that the capture fits. The signature bytes fit it as well. A block whose votes order differently by `$id` and by signature settles which.

A failure of the whole request may have any non-2xx status: the client reads the error from the body of any response that is not ok [Keeta TS] index.js:59629-59652, and returns the body of a 200 as data [Keeta TS] index.js:59673-59685. Representatives use 500: every failure the representative reported had status 500, whether it refused the request or failed to serve it, so the document gives each operation a 200 and a 500 response. The body of a failure has `"error": true` and one of two forms: a refusal names the KeetaNet error's `type`, `code` and `message`, and an internal failure has nothing but a `message` naming an error ID, `Internal error occurred (error ID: <UUID>)`. A malformed account is not a failure of the whole request: it is answered with a 200 (see Differences).

A path that names no route is outside the API, and the document does not describe it: the HTTP server answers it with status 404 and an HTML page, `Cannot GET <path>`, not with the `Error` envelope.

The capture sends no POST, so the 500 of the four POST routes is inferred from the GET routes rather than observed, and the document says so on each.

To capture again, run:

```
utils/capture-api-responses conformance/mainnet/head.state.jsonl conformance/api/mainnet
```

It needs only Python's standard library. It writes into a directory beside the output and replaces the output only once every request has been answered, so a request that fails to connect or times out (after 60 seconds) leaves the previous capture in place. A later capture differs in its bodies, because the ledger keeps moving, and the test then checks the new bodies.

`--only`, followed by file names without `.json` separated by commas, sends only those requests and replaces only their files, once all of them have been answered. A request that pages from one left out is refused, and then no file is replaced. The second run was:

```
utils/capture-api-responses --only ledger-account-history,ledger-account-history-from-start,ledger-account-history-start conformance/mainnet/head.state.jsonl conformance/api/mainnet
```

The third run's requests, with the two they page from, are sent again by:

```
utils/capture-api-responses --only node-bootstrap-votes-malformed-start,node-bootstrap-votes-fractional-limit,ledger-block-empty-side,ledger-account-chain-from-start,ledger-account-chain-fractional-limit,ledger-account-chain-to-end,ledger-account-chain-full-page-at-end,ledger-history-final-page,ledger-history-full-final-page,ledger-history-after-final-page,ledger-account-history-limit-fractional,ledger-account-history-limit-below-one,ledger-account-history-limit-negative,ledger-account-history-limit-empty,ledger-account-history-limit-not-a-number conformance/mainnet/head.state.jsonl conformance/api/mainnet
```

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

- **Malformed parameters.** The document's parameter schemas describe the values the client sends: well-formed accounts, hashes and dates, positive integer limits, and `main` or `side`. A representative also answers requests outside them, as the table above shows: a malformed account with a 200 and an `{"account", "error"}` object, and a malformed hash, a start that is no date, a limit that is no number or not above zero, or an empty or another side with a 500. It reads a limit as a number, fraction and all, so an empty limit is zero, and a fractional limit is answered with a 200: the chain and a bootstrap hold entries until their count reaches the limit, as the ledger's own bootstrap loop does [Keeta TS] index.js:69639, and history holds the whole staples it allows. These answers validate against the documented 200 and 500 responses.

No captured response or fixture disagrees with the typings. Where the typings give only `string`, the document states the form every captured response has, which is narrower:

- **History entries.** `$id` is the hash of the staple's blocks in uppercase hexadecimal, and `$timestamp` an ISO 8601 date (api/node.d.ts, GetAccountHistoryResponse). `$timestamp` is not the staple's own timestamp, the average of its votes' validity [Keeta TS] index.js:81061-81087.
- **Statistics.** `ledger.moment` of `GET /api/node/stats` is an ISO 8601 date (lib/ledger/types.d.ts, LedgerStatistics).

## Peer-to-peer messages over HTTP

The package publishes the side that posts a peer-to-peer message, not the handler that receives it: `api/p2p.d.ts` declares only the handler's arguments and result. A representative that prefers updates over HTTP is sent each message as `POST /api/p2p/message`, with the message as JSON text and the sender's own advertisement as `greeting`, and the sender ignores the answer [Keeta TS] index.js:72195-72218. The node's handler is derived from that and from the switch the package publishes:

- The greeting must be a representative's advertisement that its signature covers, as the switch's peer parser checks [Keeta TS] index.js:71828-71867, 71911-71986. Otherwise the answer is `{"success": false}`, and nothing reaches the switch.
- The message must be one the switch reads [Keeta TS] index.js:72751-72783, of a type a representative posts over HTTP. Otherwise the answer is `{"success": false}`, and only the greeting reaches the switch. By the type the switch reads:
  - `add`, a staple, is taken as it is. Representatives broadcast staples with a TTL, and pass on those they apply [Keeta TS] index.js:71402-71404, 71451-71464; the ledger checks the staple [Keeta TS] index.js:71415-71431. The switch keeps nothing of it under the connection's name.
  - `peer`, a representative another representative passes on [Keeta TS] index.js:73466-73479, is taken with a TTL of 0 or none, and with only what the signature covers, rebuilt as for the greeting. The switch keeps a peer's advertisement as the message carries it, as a potential peer under the representative's key [Keeta TS] index.js:72880-72893, and dials it, and keeps it as a known peer, from that record [Keeta TS] index.js:73609-73648. A representative passes peers on with a TTL of 0; with a higher one the switch would pass the advertisement of a representative it knows on to every peer [Keeta TS] index.js:72900-72920, 72946-72961. The advertisement of a node that is no representative is refused: the switch keeps each under a fresh random ID [Keeta TS] index.js:72088-72102, so each such message would add a record.
  - `greeting` is refused. The switch handles a greeting on an HTTP connection as it comes, even from a peer it knows [Keeta TS] index.js:72851-72866: it takes the connection's peer from it and keeps any `filter` beside it under the name of that peer's connection [Keeta TS] index.js:73548-73582, whatever the greeting field holds. A representative's first post to a node is its greeting as the message [Keeta TS] index.js:72693-72703, 73541-73545; the greeting field of that post, and of every later one, carries the same advertisement.
  - `test` is refused. The switch passes it on to every peer [Keeta TS] index.js:72927-72930, 72946-72961, and no node sends one.
  - Any other type is refused. The node acts on no other [Keeta TS] index.js:71413-71447.
- Only what the signature covers is taken from the greeting: the kind, the key, the `p2p` and `api` endpoints and `preferUpdates` [Keeta TS] index.js:71854-71863, with the signature, serialized as the switch serializes a peer [Keeta TS] index.js:71988-72019. Any other field is dropped, both beside the advertisement and inside its endpoints, which the parser passes on as they are [Keeta TS] index.js:71946. In particular `filter`, which the switch keeps under the connection's name [Keeta TS] index.js:73576-73582, 73657-73668: for an HTTP connection that name is the representative and its `api` endpoint [Keeta TS] index.js:72183-72194, which is also the name of the node's own connection to that representative, so a filter replayed beside a representative's advertisement would hold back from it every staple outside the filter. A peer that filters does so on its own WebSocket, whose name is its socket's [Keeta TS] index.js:72385-72392.
- When both are taken, the answer is `{"success": true}`, and the message then reaches the switch on an HTTP connection to the sender: the greeting, as a `greeting` message, which the switch handles on an HTTP connection even from a peer it knows [Keeta TS] index.js:72851-72866, and the message. The greeting's message ID is the SHA3-256 of the JSON text of what the signature covers. The switch drops a message whose ID it has seen within its `seenMessageTTL` [Keeta TS] index.js:72830-72843, so it handles a sender's greeting once in that period rather than with every message, however the greeting is encoded; handling a greeting sends the sender every peer the node knows [Keeta TS] index.js:73466-73479, 73592, which two nodes that both post over HTTP would otherwise answer each other with without end.
- The message does not wait for the greeting to be handled, since the connection already carries the sender's advertisement [Keeta TS] index.js:72175-72181. The messages one sender posts reach the switch in the order they arrive, as on a WebSocket [Keeta TS] index.js:72362-72369.
- The switch handles the message after the answer, as it handles a message on a WebSocket without the sender waiting [Keeta TS] index.js:72362-72369, and the node is not synced before answering. Handling a staple syncs the node [Keeta TS] index.js:71436, and syncing waits for the node's own pending posts to peers [Keeta TS] index.js:71377-71383, 72677-72683, which may be waiting for the sender's answer, so two nodes posting to each other would each wait for the other.
- A node that stops waits for the messages posted to it to be handled for 5 seconds at most, since handling one can wait on the node's own posts to peers, which have no time limit [Keeta TS] index.js:72203-72218.
- An advertisement is signed by the key it names [Keeta TS] index.js:71854-71863, so any key can advertise any `api` endpoint. Handling a greeting that arrived over HTTP sends the sender every peer the node knows, each as a post to the advertised `api` endpoint [Keeta TS] index.js:73466-73479, 72195-72218. The switch also keeps the advertisement of a greeting it receives on a WebSocket, and of a peer another peer passes on, as a potential peer [Keeta TS] index.js:73563-73567, 72893, and posts to its `api` endpoint, or dials its `p2p` endpoint, when it broadcasts [Keeta TS] index.js:73250-73252, 73609-73620. The handler makes no request of its own.

## Development networks

A node whose network is `local` keeps the ledger of network 0, which the client validates without a configuration of its own [Keeta TS] index.js:61346-61352. The client still takes a network alias for it, and the node gives it `test`.

The client's `UserClient.history()` computes the effects of each staple it lists with the initial trusted account of the alias's default configuration, here the testnet's [Keeta TS] index.js:60768. The effect computation lets that account sign the opening blocks of the network address and of the base token without the permissions they would otherwise need [Keeta TS] index.js:68650-68660. On a development network the trusted account is the one the node was configured with, so the genesis staple, whose blocks the configured account signed, is computed as if its signer had no such exemption. Only that entry is affected, since the exemption covers opening blocks only. The API's responses carry no effects.
