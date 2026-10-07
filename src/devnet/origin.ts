import { readdir, readFile, readlink } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { endianness } from 'node:os';

/** Every IPv4 TCP socket of the network namespace, one per line after a header (proc_net(5)). */
const TCP_TABLE = '/proc/net/tcp';

const LOCAL_ADDRESS_COLUMN = 1;
const REMOTE_ADDRESS_COLUMN = 2;
const INODE_COLUMN = 9;

type Endpoint = { readonly address: string; readonly port: number };

/** The kernel writes an address as the 32-bit number in host byte order, and the port in hexadecimal. */
function tableEndpoint(endpoint: Endpoint): string | undefined {
	const octets = endpoint.address.replace(/^::ffff:/, '').split('.');
	if (octets.length !== 4 || !octets.every(function(octet): boolean {
		return(/^\d{1,3}$/.test(octet));
	})) {
		return(undefined);
	}
	if (endianness() === 'LE') {
		octets.reverse();
	}
	const address = octets.map(function(octet): string {
		return(Number(octet).toString(16).padStart(2, '0'));
	}).join('');
	return(`${address}:${endpoint.port.toString(16).padStart(4, '0')}`.toUpperCase());
}

/** The inode of the socket bound to the local endpoint and connected to the remote one. */
async function socketInode(local: Endpoint, remote: Endpoint): Promise<string | undefined> {
	const localText = tableEndpoint(local);
	const remoteText = tableEndpoint(remote);
	if (localText === undefined || remoteText === undefined) {
		return(undefined);
	}
	const lines = (await readFile(TCP_TABLE, 'utf-8')).split('\n').slice(1);
	for (const line of lines) {
		const columns = line.trim().split(/\s+/);
		if (columns[LOCAL_ADDRESS_COLUMN] === localText && columns[REMOTE_ADDRESS_COLUMN] === remoteText) {
			return(columns[INODE_COLUMN]);
		}
	}
	return(undefined);
}

/** Whether the process holds the socket; a process that has exited, or is not ours to inspect, holds none. */
async function holdsSocket(processID: number, inode: string): Promise<boolean> {
	const directory = `/proc/${String(processID)}/fd`;
	let descriptors: string[];
	try {
		descriptors = await readdir(directory);
	} catch {
		return(false);
	}
	const target = `socket:[${inode}]`;
	for (const descriptor of descriptors) {
		try {
			if (await readlink(`${directory}/${descriptor}`) === target) {
				return(true);
			}
		} catch {
			// The descriptor was closed while the directory was read.
		}
	}
	return(false);
}

/**
 * The process, of the candidates, that holds the other end of an accepted
 * loopback connection. Every process of the devnet runs on this host, so the
 * kernel's socket table and the processes' descriptors tell which node
 * dialed; a connection already closed by its other end has no owner.
 */
export async function processOfConnection(socket: Socket, candidates: ReadonlySet<number>): Promise<number | undefined> {
	const { localAddress, localPort, remoteAddress, remotePort } = socket;
	if (localAddress === undefined || localPort === undefined || remoteAddress === undefined || remotePort === undefined) {
		return(undefined);
	}
	const inode = await socketInode({ address: remoteAddress, port: remotePort }, { address: localAddress, port: localPort });
	if (inode === undefined) {
		return(undefined);
	}
	for (const processID of candidates) {
		if (await holdsSocket(processID, inode)) {
			return(processID);
		}
	}
	return(undefined);
}
