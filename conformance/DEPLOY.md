# Deploying the node

This document states what an operator needs to run `slop-node` as a service: the image, its configuration, the database, the network in front of it, and the rules that keep a node off networks it must not vote on. `[Keeta TS] index.js:N` is line N of `client/index.js` in the published `@keetanetwork/keetanet-client` 0.18.7 package.

## 1. The image

`nix build .#image` writes a gzip-compressed docker-archive tarball (`result`) that `docker load` and `podman load` read. It is named `slop-node`, tagged with the hash of its Nix output, and built only from the flake's inputs, so the same commit gives the same image. `nix build .#default` builds the same node as a plain package, `bin/slop-node`, for hosts that run Nix.

| | |
|---|---|
| Entrypoint | `tini -- slop-node` |
| Command | `run`; replace it to run `genesis`, `clear-peers` or `help` |
| User | `slop-node`, UID 10001, GID 10001 |
| Working directory | `/var/lib/slop-node`, mode 0700, owned by that user |
| Port | `8080/tcp`: the API and the peer WebSocket |
| Environment | `KEETANET_LOCAL_NODE_LISTEN_IP=0.0.0.0`, `KEETANET_LOCAL_NODE_LISTEN_PORT=8080`, `SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt`, `TZ=UTC`, `TZDIR=/etc/zoneinfo` |
| Labels | `org.opencontainers.image.title`, `.version` (the version `GET /api/node/version` reports), `.source`, `.licenses`, `.description`, and `.revision` when built from a clean checkout |

The image holds the node with Node.js and what Node.js refers to, the CA bundle and the time zone database. It contains no keys and no other secret: every setting comes from the environment at run time. It is not shell-free: Node.js's closure carries bash, grep and some `-dev` outputs (about 17.5 MiB) through its build-configuration strings, none of them on `PATH`.

The node keeps nothing on disk. When `KEETANET_LOCAL_NODE_POSTGRES_URL` is set, the ledger, the statistics and the peer-to-peer state are in Postgres; otherwise they are in memory and lost when the node exits. The log goes to standard output and standard error. No volume needs mounting; the working directory is writable for the node's user only.

`tini` runs as PID 1 and passes every signal to the node. Linux delivers a signal to a PID 1 only if that process handles it. The node handles SIGTERM and SIGINT only from the start of `run` until the first one arrives, then removes its handlers, so that a second signal ends it at once if stopping hangs; as PID 1 it would ignore that second signal, and any signal sent while it starts.

## 2. Configuration

The node reads its settings from the environment only. `slop-node --help`, or `help` as the image's command, lists every variable with its default. A `KEETANET_LOCAL_NODE_` variable that the node does not read is refused as a likely misspelling, as is a `KEETANET_GENESIS_` one by the `genesis` command, and a variable the node reads may not be set to the empty string.

What a deployment usually sets:

| Variable | |
|---|---|
| `KEETANET_LOCAL_NODE_SEED` | The representative's seed. Secret. |
| `KEETANET_INITIAL_TRUSTED_ACCOUNT` | The network's trusted account, a public key. Required on `local`. |
| `KEETANET_LOCAL_NODE_NETWORK` | `local` (network 0, the default), `dev`, `staging`, `test`, `main`, or the numeric ID of one of them. |
| `KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE` | `read-write` (default), `no-voting`, `bootstrap-only` or `read-only`. |
| `KEETANET_LOCAL_NODE_POSTGRES_URL` | The node's database. Secret, since it may hold a password. Without it the ledger is in memory and lost on stop. |
| `KEETANET_LOCAL_NODE_ENDPOINT_API`, `KEETANET_LOCAL_NODE_ENDPOINT_P2P` | Where clients and peers reach the node (section 4). |
| `KEETANET_LOCAL_NODE_MANUAL_PEERS` | The peers the node dials, each as another node prints it on its `peer:` line. |
| `KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS` | API endpoints the node catches up from without dialing them. |
| `KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS` | The most sockets open on `/p2p` at once (512). |
| `KEETANET_LOCAL_NODE_MAX_POSTED_MESSAGES` | The most messages posted over HTTP that the node handles at once (256). |
| `KEETANET_LOCAL_NODE_LOG_LEVEL`, `KEETANET_LOCAL_NODE_LOG_FILTER` | What the log records (`INFO`). |

The fee variables and `KEETANET_LOCAL_NODE_PREFER_UPDATES` are described by `--help`. The `KEETANET_GENESIS_` variables are read by the `genesis` command only, so the trusted account's seed never needs to be in a running node's environment.

The values of `KEETANET_LOCAL_NODE_SEED`, `KEETANET_LOCAL_NODE_FEE_SEED`, `KEETANET_LOCAL_NODE_POSTGRES_URL` and `KEETANET_GENESIS_TRUSTED_SEED` are never repeated in an error or on the startup summary.

**Peer limits.** Each socket on `/p2p` is an open file. The default of 512 stays below the 1024 open files a process may have by default on Linux. Raising `KEETANET_LOCAL_NODE_MAX_PEER_SOCKETS` needs a matching open-files limit (`ulimit -n`, `--ulimit nofile=`, `LimitNOFILE=`), with room for API requests, database connections and the node's own dials. Both limits accept a whole number from 1 to 1048576.

## 3. Postgres

- **Version.** PostgreSQL 15 or later: the schema uses `UNIQUE NULLS NOT DISTINCT`, which 15 introduced. The node's tests run against PostgreSQL 18.
- **One database per logical node.** The database holds one representative's ledger, its vote serials and its peers. The processes that serve one representative may share its database. Two representatives never share one, even on the same network.
- **Migrations.** The node creates and upgrades its schema when it opens the database, so its role must be able to create tables there. Every process that migrates takes the advisory lock `pg_advisory_lock(7738703085231170663)` first, so processes starting together apply each migration exactly once. A database that a newer build has migrated is refused, so a node cannot be rolled back past a schema change.
- **Clock.** No statement reads the database's clock; every stored moment comes from the node's.
- **URL.** `postgresql://user:password@host:5432/database`, or with a Unix socket directory as the host, written with `%2F` for each `/`: `postgresql://user@%2Frun%2Fpostgresql/database`.

## 4. Addresses and the proxy

- **Listening.** The image listens on `0.0.0.0:8080`. A node that listens on every interface (`0.0.0.0` or `::`) cannot tell which address peers reach it at, so it refuses to start unless both `KEETANET_LOCAL_NODE_ENDPOINT_API` and `KEETANET_LOCAL_NODE_ENDPOINT_P2P` are set.
- **One port.** The node serves its API below the path of its API endpoint (`/api` for `https://node.example/api`), and peers on `/p2p` of the same server. The P2P endpoint must be a `ws://` or `wss://` URL whose path is `/p2p`; a P2P endpoint on another path or port is not served.
- **A proxy in front** must:
  - pass the API endpoint's path through unchanged;
  - forward WebSocket upgrades on `/p2p`, and frames of up to 16 MiB, the largest a peer sends [Keeta TS] index.js:71812;
  - accept `POST <api>/p2p/message` bodies of at least 32 MiB, the largest the node accepts.
- **Stable addresses.** A node's `peer:` line carries its signature over its key, its endpoints and how it prefers updates, and peers keep that record. Give each node endpoints that do not change, such as DNS names. A node whose endpoints change must have its new `peer:` line given to every node that names it.
- **Firewall.** `/p2p` and `POST <api>/p2p/message` take any representative's greeting without authentication, and a greeting makes the sender a peer that the node sends staples to and remembers. Allow them only from the hosts of the node's own network.

## 5. Safety rules

The node enforces these at start, before it serves anything:

- On `main` and `test`, the public networks, the node may only follow the ledger: `KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE` must be `read-only` or `bootstrap-only`.
- On any network of Keeta's (`dev` and `staging` as well), a node in a voting mode (`read-write` or `no-voting`) may have no peers: it refuses `KEETANET_LOCAL_NODE_MANUAL_PEERS`, `KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS`, and peers its database remembers. It then serves nothing on `/p2p` and refuses every posted message.
- Voting with peers is therefore possible on network 0 only, the operator's own network.
- `genesis` is refused on `main` and `test`, and in memory.

## 6. Running

- **Stopping.** On SIGTERM or SIGINT the node stops bootstrapping, closes the peer sockets, waits for the requests in flight, waits up to 5 s for the messages peers delivered, closes its database connections and exits with status 0. Give it a stop timeout of at least 20 s before the runtime kills it: `docker stop -t 20` or `--stop-timeout 20`, `stop_grace_period: 20s` in Compose, `TimeoutStopSec=20` in systemd. Kubernetes' default grace period, 30 s, is enough.
- **Clocks.** Keep every host's clock synchronized with NTP. A vote may be stamped at most 60 s ahead of the clock that reads it [Keeta TS] index.js:80373-80375, and the node's catch-up from its peers allows their clocks to differ from its own by up to 5 minutes.
- **`clear-peers`.** The peers a node remembers belong to the network and mode it ran in. After changing `KEETANET_LOCAL_NODE_NETWORK` or `KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE`, stop the node and run `clear-peers` once with its new environment, for example `docker run --rm --env-file node.env slop-node:<tag> clear-peers`. It forgets every remembered peer and keeps the ledger and the statistics. A node in a voting mode on one of Keeta's networks refuses to start while its database remembers peers, and its error names this command.
- **Startup.** Once it serves, the node prints a summary: its version, its representative, network, write mode and storage, and the lines `api:` and `peer:`. `GET <api>/node/version` answers once it serves.
- **Exit status.** 0 after a signal, 1 when the node refuses its configuration or fails, 2 for a command line it does not understand.

## 7. A devnet on network 0

An outline for a network of several representatives that only the operator runs.

1. **Keys.** Choose a seed for the trusted account and one seed per representative, 64 hexadecimal digits each. The trusted seed is needed only for genesis. Every node is given the trusted account's public key as `KEETANET_INITIAL_TRUSTED_ACCOUNT`.
2. **Databases.** Create one empty database per node.
3. **Genesis, once.** Run `genesis` against the first node's database, with that node's environment and `KEETANET_GENESIS_TRUSTED_SEED`, `KEETANET_GENESIS_SUPPLY` and optionally `KEETANET_GENESIS_DELEGATE_TO`, which is the first node's representative unless set. The supply's voting weight is delegated to that one representative. The command prints the genesis staple's hash and the network address.
4. **Start every node** with `KEETANET_LOCAL_NODE_NETWORK=local`, `KEETANET_LOCAL_NODE_LEDGER_WRITE_MODE=read-write`, its own seed, database and stable endpoints, behind a firewall that admits only the other nodes to the P2P surface. Collect each node's `peer:` line. `KEETANET_LOCAL_NODE_BOOTSTRAP_PEERS` is not needed: the manual peers of the next step are always sources a node catches up from, so a node without genesis fetches it from them once restarted. Only a representative that the node merely heard of through its peers must hold a hundredth of the voting weight on the node's own ledger to be one, and a node without genesis knows no weight.
5. **Peers.** Set `KEETANET_LOCAL_NODE_MANUAL_PEERS` on every node to the other nodes' `peer:` lines, and restart them.
6. **Genesis first.** Before publishing anything, wait until every node holds genesis: `GET <api>/node/ledger/account/<network address>/head` answers a `block` other than `null` on every node. Do the same after each staple that changes voting weight, such as a delegation, checking `GET <api>/node/ledger/block/<hash>` on every node, before publishing the next transaction.
7. **Publish** to any node's `POST <api>/node/publish`.
