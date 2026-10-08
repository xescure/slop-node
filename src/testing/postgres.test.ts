import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, onTestFinished, test } from 'vitest';
import pg from 'pg';
import { createDatabase, currentBootID, startCluster, sweepAbandonedClusters } from './postgres.js';
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

/** A process that stays up until the case ends, standing for an unrelated process that reused a PID. */
const bystander = function(): number {
	const child = spawn(process.execPath, ['--eval', 'setInterval(function() {}, 1 << 30);']);
	onTestFinished(function() {
		child.kill('SIGKILL');
	});
	if (child.pid === undefined) {
		throw(new Error('the bystander did not start'));
	}
	return(child.pid);
};

const isAlive = function(processID: number): boolean {
	try {
		process.kill(processID, 0);
	} catch {
		return(false);
	}
	return(true);
};

/** A cluster directory as a dead run would leave it, whose server PID file names the given process. */
const leftCluster = async function(parent: string, name: string, owner: { readonly pid: number; readonly boot: string }, serverPID: number): Promise<string> {
	const directory = join(parent, name);
	await mkdir(join(directory, 'data'), { recursive: true });
	await writeFile(join(directory, 'owner.pid'), `${String(owner.pid)}\n`);
	await writeFile(join(directory, 'owner.boot'), `${owner.boot}\n`);
	await writeFile(join(directory, 'data', 'PG_VERSION'), '18\n');
	await writeFile(join(directory, 'data', 'postmaster.pid'), `${String(serverPID)}\n${join(directory, 'data')}\n`);
	return(directory);
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
		expect(await readFile(join(cluster.socketDirectory, 'owner.boot'), 'utf-8')).toBe(`${String(await currentBootID())}\n`);
		expect(await connects(cluster)).toBe(true);
	});

	test('a cluster\'s server stops cleanly and starts again on its data', async function() {
		const parent = await temporaryParent();
		const cluster = await startCluster(parent);
		onTestFinished(function() {
			return(cluster.stop());
		});
		const client = new pg.Client({ host: cluster.socketDirectory, port: cluster.port, user: cluster.user, database: 'postgres' });
		await client.connect();
		await client.query('CREATE TABLE kept (value integer)');
		await client.query('INSERT INTO kept VALUES (7)');
		await client.end();

		await cluster.stopServer();
		expect(await connects(cluster)).toBe(false);
		await cluster.startServer();

		const again = new pg.Client({ host: cluster.socketDirectory, port: cluster.port, user: cluster.user, database: 'postgres' });
		await again.connect();
		try {
			expect((await again.query<{ value: number }>('SELECT value FROM kept')).rows).toEqual([{ value: 7 }]);
		} finally {
			await again.end();
		}
	});

	test('a cluster from an earlier boot is removed without signalling anything', async function() {
		const parent = await temporaryParent();
		const unrelated = bystander();
		const directory = await leftCluster(parent, 'slop-pg-earlier-boot', { pid: await deadProcessID(), boot: 'an-earlier-boot' }, unrelated);

		await sweepAbandonedClusters(parent);

		expect(existsSync(directory)).toBe(false);
		expect(isAlive(unrelated)).toBe(true);
	});

	test('a server PID that now names another process is never signalled', async function() {
		const parent = await temporaryParent();
		const unrelated = bystander();
		const boot = await currentBootID();
		if (boot === undefined) {
			throw(new Error('this host reports no boot ID'));
		}
		const directory = await leftCluster(parent, 'slop-pg-reused-pid', { pid: await deadProcessID(), boot }, unrelated);

		await sweepAbandonedClusters(parent);

		expect(existsSync(directory)).toBe(false);
		expect(isAlive(unrelated)).toBe(true);
	});
});
