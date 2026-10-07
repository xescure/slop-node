import { nodeRoutes } from './node.js';
import { routeTable } from './route.js';
import type { Route } from './route.js';

export { defineGET, definePOST, invokeRoute, routeTable } from './route.js';
export type { APIRequest, ParameterValues, Route, RouteMethod, RoutePath } from './route.js';

/** Every route the node serves below its API prefix, one group per module, in the order the router tries them. */
export const API_ROUTES: readonly Route[] = routeTable([nodeRoutes]);
