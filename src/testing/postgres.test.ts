import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, onTestFinished, test } from 'vitest';
import pg from 'pg';
import { createDatabase, startCluster, sweepAbandonedClusters } from './postgres.js';
import type { ClusterConnection } from './postgres.js';

/** A process ID that no running process holds: that of a child which has already exited. */
const deadProcessID = function(): Promise<number> {
	return(new Promise(function(resolve, reject) {
		const child = spawn(process.execPath, ['--eval', '']);
		child.once('error', reject);
		child.once('exit', function() {
			if (child.pid === undefined) {
				reject(new Error('the child process has no ID'));
				return;
			}
			resolve(child.pid);
		});
	}));
};

const temporaryParent = async function(): Promise<string> {
	const parent = await mkdtemp(join(tmpdir(), 'slop-sweep-'));
	onTestFinished(function() {
		return(rm(parent, { recursive: true, force: true }));
	});
	return(parent);
};

const connects = async function(cluster: ClusterConnection): Promise<boolean> {
	const client = new pg.Client({ host: cluster.socketDirectory, port: cluster.port, user: cluster.user, database: 'postgres' });
	try {
		await client.connect();
	} catch {
		return(false);
	}
	await client.end();
	return(true);
};

describe('the test cluster', function() {
	test('the server runs in UTC whatever the host\'s zone', async function() {
		const database = await createDatabase(inject('postgresCluster'));
		onTestFinished(function() {
			return(database.drop());
		});

		const result = await database.pool().query<{ TimeZone: string }>('SHOW timezone');

		expect(result.rows[0]?.TimeZone).toBe('UTC');
	});

	test('a cluster whose owner died is stopped and removed, and no other is touched', async function() {
		const parent = await temporaryParent();
		const abandoned = await startCluster(parent);
		onTestFinished(async function() {
			if (existsSync(abandoned.socketDirectory)) {
				await abandoned.stop();
			}
		});
		await writeFile(join(abandoned.socketDirectory, 'owner.pid'), `${String(await deadProcessID())}\n`);
		const live = join(parent, 'slop-pg-live');
		await mkdir(live);
		await writeFile(join(live, 'owner.pid'), `${String(process.pid)}\n`);
		const unowned = join(parent, 'slop-pg-unowned');
		await mkdir(unowned);

		await sweepAbandonedClusters(parent);

		expect(existsSync(abandoned.socketDirectory)).toBe(false);
		expect(await connects(abandoned)).toBe(false);
		expect(existsSync(live)).toBe(true);
		expect(existsSync(unowned)).toBe(true);
	});

	test('a cluster records the process that owns it', async function() {
		const parent = await temporaryParent();
		const cluster = await startCluster(parent);
		onTestFinished(function() {
			return(cluster.stop());
		});

		await sweepAbandonedClusters(parent);

		expect(await readFile(join(cluster.socketDirectory, 'owner.pid'), 'utf-8')).toBe(`${String(process.pid)}\n`);
		expect(await connects(cluster)).toBe(true);
	});
});
