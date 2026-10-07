/** How much the node takes from peers at once. */
export type PeerLimits = {
	/** The most sockets open on "/p2p"; an upgrade beyond them is refused until one closes. */
	readonly sockets: number;
	/** The most messages posted over HTTP that the switch handles; a post beyond them is refused unread. */
	readonly postedMessages: number;
};

/**
 * Representatives keep a socket to each peer they dial, and every client
 * listening for its account's staples keeps one [Keeta TS] index.js:61072-61085,
 * so a representative serves many; 512 stays below the 1024 open files a
 * process may have by default on Linux, leaving the rest to API requests, the
 * database and the node's own dials, and bounds the frames of up to 16 MiB that
 * open sockets can make the node hold.
 *
 * A representative posts each staple it adds, or passes on, to each peer once
 * [Keeta TS] index.js:71451-71464, 72195-72218, so a node that keeps up handles
 * a few at a time, and handling a greeting posts every peer the node knows to
 * the sender [Keeta TS] index.js:73466-73479. Beyond 256 a post would only
 * queue more work; its sender ignores the answer, and a staple refused still
 * reaches the node by bootstrap.
 */
export const DEFAULT_PEER_LIMITS: PeerLimits = { sockets: 512, postedMessages: 256 };

/**
 * Larger limits are refused as mistakes: no process holds more sockets than
 * the files Linux lets it open (fs.nr_open, 1048576 by default), and as many
 * posted messages of up to 32 MiB each would be terabytes held at once.
 */
export const MAX_PEER_LIMIT = 1_048_576;
