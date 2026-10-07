import { accountRoutes } from './account.js';
import { ledgerRoutes } from './ledger.js';
import { nodeRoutes } from './node.js';
import { p2pRoutes } from './p2p.js';
import { routeTable } from './route.js';
import type { Route } from './route.js';
import { voteRoutes } from './vote.js';

export { defineGET, definePOST, invokeRoute, routeTable } from './route.js';
export type { APIRequest, ParameterValues, Route, RouteMethod, RoutePath, RouteSync } from './route.js';
export { settleDeliveries } from './p2p.js';

/** Every route the node serves below its API prefix, one group per module, in the order the router tries them. */
export const API_ROUTES: readonly Route[] = routeTable([voteRoutes, nodeRoutes, ledgerRoutes, accountRoutes, p2pRoutes]);
