import type { TestProject } from 'vitest/node';
import { connectionOf, createLedgerTemplate, startCluster, sweepAbandonedClusters } from './postgres.js';

/**
 * One cluster for the whole run, with one migrated template; each test makes
 * its own databases in it.
 */
export const setup = async function(project: TestProject): Promise<() => Promise<void>> {
	await sweepAbandonedClusters();
	const cluster = await startCluster();
	try {
		project.provide('postgresLedgerTemplate', await createLedgerTemplate(cluster));
	} catch (error: unknown) {
		await cluster.stop();
		throw(error);
	}
	project.provide('postgresCluster', connectionOf(cluster));
	return(cluster.stop);
};
