# The node HTTP API

`api/openapi.json` describes the HTTP API a KeetaNet node serves, as an OpenAPI 3.1 document. It is the contract the node's server follows, and the reference that live representatives are compared against.

## Sources

The document describes version 0.18.7 of `@keetanetwork/keetanet-client`:

- **Routes** come from the package's API typings. `api/index.d.ts` declares the route tree `rootTree`: each key is a path segment, `_root` stands for the subtree's own path, a `:name` key is a path parameter, and the methods are the leaves. Every route is served below `/api` [Keeta TS] index.js:61390. `api/node.d.ts`, `api/vote.d.ts` and `api/p2p.d.ts` type the handlers' arguments and results.
- **Shapes** come from the package's bundle, `client/index.js`. A response body is the handler's result passed through the package's JSON conversion: integers become `0x` and uppercase hexadecimal [Keeta TS] index.js:78420-78433, dates ISO 8601 strings [Keeta TS] index.js:78436-78437, bytes uppercase hexadecimal [Keeta TS] index.js:78439-78443, and library values their own `toJSON` [Keeta TS] index.js:78450-78453. Blocks, votes, quotes and staples at the top of a response also carry their binary encoding in `$binary`, which the client decodes [Keeta TS] index.js:58891, 58977, 59808, 59814, 59923. The document cites the bundle by line wherever it states behavior, and the typings by file where a shape is known only from them.
- **Request parameters** come from the client's own calls: the query parameters it sends, and how it encodes path parameters and bodies.

`src/api/routes.test.ts: "the document covers exactly the routes of the typings"` reads the route tree from the typings with the TypeScript compiler API and requires the document's operations to be exactly those routes.

## Differences

Places where the document deliberately differs from what a live representative returns, and places where the typings and live responses disagree, are listed here.
