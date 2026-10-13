# Canonical state dump

A state dump writes the confirmed state that a Keeta ledger holds for a set of accounts as text with one fixed byte form, so that two ledgers in the same state produce the same bytes whatever their storage and whatever language they are written in. `conformance/mainnet/head.state.jsonl` is the dump of the state that `lib.Ledger` from `@keetanetwork/keetanet-client` 0.18.7 reaches after replaying the mainnet head (`MAINNET.md`). A node implementation conforms when its replay of the same staples dumps the same bytes.

This document defines the format, `slop-node/state-dump@1`, and how a dump is produced from the storage interface alone.

## Conventions

- `[Keeta TS] index.js:N` is line N of `client/index.js` in the published `@keetanetwork/keetanet-client` 0.18.7 package.
- "Must" states a requirement on a producer of a dump.
- The storage interface is upstream's `LedgerStorageAPI`. `schema/CONTRACT.md` specifies each of its members.

## 1. Files

| File | What it holds |
|---|---|
| `conformance/mainnet/head.state.jsonl` | the dump after the head replay (section 7) |
| `conformance/state-dump.schema.json` | the JSON Schema (draft 2020-12) of one line of a dump |

The schema states the structure of each line. The rules it cannot state are given here: which accounts have the optional fields of an `account` record (section 3.1), which records exist (section 3), the order of the records and the uniqueness of their keys (section 4).

## 2. Encodings

| Value | Encoding |
|---|---|
| Account | its public key string, `keeta_...`, in the canonical form Keeta prints |
| Amount, supply, weight, height, quorum | a decimal string of a non-negative integer, without leading zeros |
| Idempotent key | base64 (RFC 4648, with padding) of the bytes a block carries as its idempotent value, the form a block's JSON gives it [Keeta TS] index.js:64918 |
| Block hash, certificate hash | 64 uppercase hex digits, as Keeta prints a hash |
| Ledger checksum | 64 uppercase hex digits: the 256-bit value, zero-padded on the left |
| Certificate | base64 (RFC 4648, with padding) of its DER bytes |
| Permission set | `{"base": D, "external": D}`: the base flags and the external offsets, each as the decimal of the integer whose bits they are, `Permissions.base.bigint` and `Permissions.external.bigint` [Keeta TS] index.js:75382-75387 |
| Text | a JSON string (section 2.1) |

A field that this document says may be `null` is written as `null` when the value is absent. No other field is ever `null`, and no field appears that this document does not define.

### 2.1 Lines

A dump is a sequence of lines, each a JSON object followed by a line feed (0x0A), the last line included. There is no byte order mark, no carriage return and no blank line. A line has no whitespace outside its strings, and its fields are in the order that section 3 lists them.

Every byte of a dump is printable ASCII or a line feed. A string is written as ECMAScript's `JSON.stringify` writes it, and then every UTF-16 code unit from U+007F up is replaced by `\u` and four lowercase hex digits. In full, a string is `"`, then each UTF-16 code unit of the text, then `"`, where a code unit is written as:

| Code unit | Written as |
|---|---|
| `"` | `\"` |
| `\` | `\\` |
| U+0008, U+0009, U+000A, U+000C, U+000D | `\b`, `\t`, `\n`, `\f`, `\r` |
| any other below U+0020 | `\u` and four lowercase hex digits |
| U+0020 to U+007E | itself |
| U+007F and above | `\u` and four lowercase hex digits |

A code point above U+FFFF is two code units, a surrogate pair, and is therefore written as two escapes. `/` is not escaped.

## 3. Records

The first line of every dump is the format line:

```json
{"format":"slop-node/state-dump@1"}
```

Every later line is one record. Its first field, `kind`, names one of these kinds:

| Kind | Records in `head.state.jsonl` | Key fields | What it holds |
|---|---|---|---|
| `account` | 4,117 | `account` | an account's info and representative |
| `acl` | 215 | `principalType`, `principal`, `certificate`, `entity`, `target` | one permission row |
| `balance` | 4,851 | `account`, `token` | a non-zero balance |
| `certificate` | 0 | `account`, `hash` | a certificate an account holds |
| `checksum` | 1 | none | the ledger checksum |
| `head` | 371 | `account` | the head of an account's chain |
| `idempotent` | 0 | `account`, `key` | the block that holds an idempotent key |
| `supply` | 203 | `token` | a token's supply |
| `weight` | 4 | `representative` | the weight delegated to a representative |

The key fields of a record identify it: no two records of a dump have the same kind and the same key. The `certificate` key field appears only in `acl` records whose principal is a certificate.

### 3.1 `account`

```json
{"kind":"account","account":A,"name":S,"description":S,"metadata":S,"representative":A,"defaultPermission":P,"multisigQuorum":D}
```

One record for each account of the dumped set (section 5), from `getAccountInfo` and `getAccountRep`.

- `name`, `description`, `metadata`: the account info as stored. An account that was never described has empty strings.
- `representative`: the account it delegates its weight to, or `null` when it has none. An account whose key type cannot delegate, an identifier other than a storage account, always has `null`: the ledger answers for it without asking storage [Keeta TS] index.js:70524-70532, 68208-68219.
- `defaultPermission`: present exactly when the account is an identifier, that is when its key type is network, token, storage or multisig. It holds the identifier's default permissions, or `null` when its info has none.
- `multisigQuorum`: present exactly when the account is a multisig. It holds the number of signers the multisig requires, or `null` when its info has none.

The key type is the one the account's public key string encodes, `Account.keyType`.

### 3.2 `acl`

```json
{"kind":"acl","principalType":"ACCOUNT","principal":A,"entity":A,"target":A,"base":D,"external":D}
{"kind":"acl","principalType":"CERTIFICATE","principal":A,"certificate":H,"entity":A,"target":A,"base":D,"external":D}
```

One permission row of the main ledger: the principal may do what `base` and `external` grant on the entity, scoped to the target. A row of principal type `CERTIFICATE` grants to the holders of a certificate: `principal` is the account that holds it and `certificate` its hash.

A row without permissions has a record, with `base` and `external` both `"0"`. Such a row is not the same state as no row: for its exact target it stops a row of the same principal for the whole entity from applying [Keeta TS] index.js:68145-68168. Only a row that was deleted has no record.

The rows are those that `listACLsByEntity` and `listACLsByPrincipal` return for each account of the dumped set, without filters, with each row written once. Listing from both sides finds a row whose entity lies outside the set through its principal.

### 3.3 `balance`

```json
{"kind":"balance","account":A,"token":A,"amount":D}
```

One record for each token of which an account of the dumped set holds a non-zero balance, as `getAllBalances` returns them. A balance of zero has no record, whether or not storage returns it: it is the same state as a token the account never held, so every amount is positive.

### 3.4 `certificate`

```json
{"kind":"certificate","account":A,"hash":H,"certificate":B,"intermediates":[B,...]}
```

One record for each certificate that `getAccountCertificates` returns for an account of the dumped set. `hash` is the certificate's hash, `Certificate.hash()`. `intermediates` lists the DER of each intermediate certificate stored with it, in the bundle's order, or is `null` when the certificate was added without any.

### 3.5 `checksum`

```json
{"kind":"checksum","ledgerChecksum":H}
```

Exactly one record: the node's ledger checksum, the XOR of the hash of every block of every staple the ledger applied. `Ledger.add` folds in the staples it applies [Keeta TS] index.js:70449-70453, and a driver folds in the staples that gc applies (`CONTRACT.md` section 2.6). It is not read from storage: a node's statistics hold it, and the producer writes the value it was given.

A representative serves the checksum of its own ledger at `GET /node/ledger/checksum`, as the `checksum` field (`api/node.d.ts` lines 49-53 of the package). That value equals this record only for a ledger that applied exactly the staples the dump was produced from. Its JSON encoding of a `bigint` is `"0x"` followed by uppercase hex without leading zeros [Keeta TS] index.js:79559-79582, 79628, so even equal values are spelled differently. They are compared as numbers: `BigInt(served) === BigInt('0x' + ledgerChecksum)`.

### 3.6 `head`

```json
{"kind":"head","account":A,"height":D,"block":H}
```

One record for each account of the dumped set that has a chain on the main ledger: its head block and that block's zero-based height, the opening block being at height 0. They are what `getAccountsBlockHeightInfo` returns for the account without a block hash. An account without a chain has no record.

### 3.7 `idempotent`

```json
{"kind":"idempotent","account":A,"key":K,"block":H}
```

One record for each block of the applied staples (section 5) that carries an idempotent value: `account` is the block's account, `key` its idempotent value, and `block` the block that `getIdempotentBlockHash` names on the main ledger for that account and value, or `null` when it names none. The ledger looks a key up under the account of the block that carries it [Keeta TS] index.js:69957-69967, 70747-70752. On a ledger that applied every staple, `block` is the hash of the block that carries the key.

Storage resolves a key it is given but cannot list keys, so the blocks of the applied staples are where the keys come from.

### 3.8 `supply`

```json
{"kind":"supply","token":A,"amount":D}
```

One record for each token account of the dumped set: the `supply` of its account info.

### 3.9 `weight`

```json
{"kind":"weight","representative":A,"weight":D}
```

One record for each distinct account that some account of the dumped set delegates to, that is each non-null `representative` of section 3.1, whether or not it belongs to the set itself. `weight` is its voting power, which is the weight storage holds as delegated to it, `delegatedWeight` [Keeta TS] index.js:70493-70498.

## 4. Order

The format line comes first. The records follow in ascending order of kind, then of their key fields in the order section 3 lists them, each compared by code points. An absent key field compares as the empty string.

The order is also the ascending byte order of the lines, and a producer may sort the record lines as bytes. Records of one kind write the same field names up to their first differing key value. Key values are written without escapes, and none contains a character below `"`, U+0022, which ends each value, so the first byte at which two lines differ decides as their keys do.

## 5. Producing a dump

A producer is given the staples the ledger applied and the ledger checksum. The dumped set is the accounts those staples touch: the union of the `touched` sets that upstream's `computeEffectOfBlocks` returns for the blocks of each staple the ledger applied [Keeta TS] index.js:69710-69848, together with the network's base token and network address, which `Account.generateBaseAddresses` derives from the network id [Keeta TS] index.js:63625-63629. A producer must not add accounts it found by other means: the set is fixed by the staples, so that every implementation dumps the same accounts.

Every record except `checksum` is read through the storage interface, from the main ledger:

| Kind | Reads for each account of the set |
|---|---|
| `account`, `supply` | `getAccountInfo`, `getAccountRep` |
| `acl` | `listACLsByEntity`, `listACLsByPrincipal` |
| `balance` | `getAllBalances` |
| `certificate` | `getAccountCertificates` |
| `head` | `getAccountsBlockHeightInfo`, which reads through `getHeadBlock` and `getBlockHeight` |
| `weight` | `delegatedWeight` of each representative found |
| `idempotent` | `getIdempotentBlockHash` of each idempotent value of an applied block, from `'main'` |

A producer must read all of them in one read-only transaction, so that the records describe one state; `Ledger.runReadOnly` provides it [Keeta TS] index.js:71426-71428. Nothing is read from a driver's own tables, so any implementation of the storage interface, in any language, produces the same dump from the same state.

A dump holds no wall-clock value, and nothing of the side ledger, the votes, the staples, the deferred staples, the serial numbers or the statistics other than the checksum. No block of the head file carries an idempotent value, so the committed dump has no `idempotent` record; the tests exercise the kind on a ledger of their own.

## 6. Version

The format line names the version. A change to any record, field, encoding or rule of this document is a new version, `slop-node/state-dump@2`, and never a change to version 1.

## 7. The committed dump

`conformance/mainnet/head.state.jsonl` is the dump after replaying `conformance/mainnet/head.jsonl.gz` as `MAINNET.md` section 5 describes: every staple in order through `Ledger.add` on a representative ledger of a node with the mainnet network settings, the clock at each staple's timestamp, and then gc until nothing remains to retry. All 2,037 staples apply. The dumped set has 4,117 accounts, the file 9,763 lines and 1,865,089 bytes, and its checksum record is `C4896D171CB02D3C9CD929DE064DE0DF788D100C20CB8260CC0072017C130A3A`.

The file is generated, never edited. `make conformance` writes it from the replay on this repository's reference driver, `MemoryLedgerStorage`, which implements `CONTRACT.md`. `make test` replays the head once on every storage driver of this repository and checks:

- every staple applies and none stays deferred
- the ledger checksum is the value above
- each driver's dump equals the committed file, so the drivers' dumps are byte-identical
- a second replay on the reference driver dumps the same bytes
- each line of the file is valid under the schema, the records are in the order of section 4, and no two share a key
- the record counts of section 3 are those of the file

The file pins 0.18.7, the version in `package.json`. When the dependency changes, `make test` fails if the state it reaches changes, until `make conformance` regenerates the file and the difference shows up as a reviewable diff.
