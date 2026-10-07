import type { TestProject } from 'vitest/node';
import { connectionOf, startCluster, sweepAbandonedClusters } from './postgres.js';

/** One cluster for the whole run; each test makes its own databases in it. */
export const setup = async function(project: TestProject): Promise<() => Promise<void>> {
	await sweepAbandonedClusters();
	const cluster = await startCluster();
	project.provide('postgresCluster', connectionOf(cluster));
	return(cluster.stop);
};
