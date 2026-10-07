/*
 * The handlers' results as upstream's typings declare them, per route group.
 * The route tree of api/index.d.ts names several result types that
 * api/node.d.ts does not export, which leaves them unchecked, so the groups'
 * own declarations are read instead.
 */

/** What a declared handler answers. */
export type DeclaredResult<Handler> = Handler extends (...parameters: never[]) => Promise<infer Result> ? Result : never;

export type DeclaredNodeGroup = typeof import('@keetanetwork/keetanet-client/api/node.js').default;

export type DeclaredVoteGroup = typeof import('@keetanetwork/keetanet-client/api/vote.js').default;

export type DeclaredP2PGroup = typeof import('@keetanetwork/keetanet-client/api/p2p.js').default;

export type DeclaredLedgerGroup = DeclaredNodeGroup['ledger'];

export type DeclaredAccountGroup = DeclaredLedgerGroup['account'][':account'];
