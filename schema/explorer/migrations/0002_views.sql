-- Explorer schema version 2: the views the reader queries, with addresses as
-- keeta_ text, hashes as upper-case hex and amounts as exact numerics.
--
-- The views run with the writer's rights, so they reach public.* where the
-- reader cannot. A filter on an address column finds the account by
-- public.accounts.public_key and then its rows by id, in no particular order.
-- Each view also carries the interned ids and raw hashes: a filter on
-- account_id = explorer.id_of('keeta_...'), or on a *_bytes column, is an
-- index key, and the index then also gives the rows in its order, so a "top
-- n" or "latest n" query reads only n rows.

-- Metadata is untrusted publisher text: anything but base64 of a JSON object
-- with an integer decimalPlaces gives NULL, and no input raises an error
-- inside a query.
CREATE FUNCTION explorer.decimals_of(metadata text) RETURNS integer
	LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
	SET search_path = pg_catalog
AS $$
DECLARE
	parsed jsonb;
	places numeric;
BEGIN
	parsed := convert_from(decode(metadata, 'base64'), 'UTF8')::jsonb;
	IF jsonb_typeof(parsed) <> 'object' OR jsonb_typeof(parsed -> 'decimalPlaces') IS DISTINCT FROM 'number' THEN
		RETURN NULL;
	END IF;
	places := (parsed ->> 'decimalPlaces')::numeric;
	IF places <> trunc(places) OR places < 0 OR places > 255 THEN
		RETURN NULL;
	END IF;
	RETURN places::integer;
EXCEPTION WHEN OTHERS THEN
	RETURN NULL;
END
$$;

-- The reader cannot read public.accounts, so it learns an address's id here.
-- A stable call with a constant argument is computed once, before the scan,
-- and so serves as an index key.
CREATE FUNCTION explorer.id_of(address text) RETURNS bigint
	LANGUAGE sql STABLE STRICT SECURITY DEFINER PARALLEL SAFE
	SET search_path = pg_catalog, public
	RETURN (SELECT id FROM public.accounts WHERE public_key = address);

-- [Keeta TS] index.js:62538-62544
CREATE VIEW explorer.accounts AS
SELECT
	account.public_key AS account,
	CASE account.key_type
		WHEN 0 THEN 'ECDSA_SECP256K1'
		WHEN 1 THEN 'ED25519'
		WHEN 2 THEN 'NETWORK'
		WHEN 3 THEN 'TOKEN'
		WHEN 4 THEN 'STORAGE'
		WHEN 6 THEN 'ECDSA_SECP256R1'
		WHEN 7 THEN 'MULTISIG'
		ELSE account.key_type::text
	END AS kind,
	upper(encode(head.block_hash, 'hex')) AS head,
	head.height,
	rep.public_key AS rep,
	info.name,
	info.description,
	info.metadata,
	info.default_base_permission AS default_base,
	info.default_external_permission AS default_external,
	info.multisig_quorum,
	account.id
FROM public.accounts account
LEFT JOIN public.heads head ON head.account_id = account.id
LEFT JOIN public.delegations delegation ON delegation.account_id = account.id
LEFT JOIN public.accounts rep ON rep.id = delegation.representative_id
LEFT JOIN public.account_info info ON info.account_id = account.id;

COMMENT ON VIEW explorer.accounts IS 'One row per account. name, description and metadata are untrusted publisher text.';

CREATE VIEW explorer.tokens AS
SELECT
	token.public_key AS token,
	info.name,
	explorer.decimals_of(info.metadata) AS decimals,
	supply.supply,
	token.id AS token_id
FROM public.accounts token
LEFT JOIN public.account_info info ON info.account_id = token.id
LEFT JOIN public.supplies supply ON supply.token_id = token.id
WHERE token.key_type = 3;

CREATE VIEW explorer.token_summary AS
SELECT
	token.public_key AS token,
	info.name,
	explorer.decimals_of(info.metadata) AS decimals,
	supply.supply,
	(SELECT count(*) FROM explorer.holdings holding WHERE holding.token_id = token.id) AS holders_count,
	token.id AS token_id
FROM public.accounts token
LEFT JOIN public.account_info info ON info.account_id = token.id
LEFT JOIN public.supplies supply ON supply.token_id = token.id
WHERE token.key_type = 3;

-- Multiplying by a power of ten keeps every digit, where dividing rounds to
-- the scale numeric division chooses.
CREATE VIEW explorer.balances AS
SELECT
	holder.public_key AS account,
	token.public_key AS token,
	holding.balance AS amount,
	token_decimals.decimals,
	trim_scale(holding.balance * 10::numeric ^ (-token_decimals.decimals)) AS amount_units,
	holding.account_id,
	holding.token_id
FROM explorer.holdings holding
JOIN public.accounts holder ON holder.id = holding.account_id
JOIN public.accounts token ON token.id = holding.token_id
LEFT JOIN public.account_info info ON info.account_id = holding.token_id
CROSS JOIN LATERAL (SELECT explorer.decimals_of(info.metadata) AS decimals) token_decimals;

COMMENT ON VIEW explorer.balances IS 'Non-zero balances. amount is in base units; amount_units divides it by 10^decimals. For an account''s balances filter on account_id = explorer.id_of(address).';

CREATE VIEW explorer.holders AS
SELECT account, token, amount, decimals, amount_units, account_id, token_id FROM explorer.balances;

COMMENT ON VIEW explorer.holders IS 'The rows of balances, for listing a token''s holders: filter on token_id = explorer.id_of(token) and order by amount DESC.';

CREATE VIEW explorer.blocks AS
SELECT
	upper(encode(block.hash, 'hex')) AS hash,
	account.public_key AS account,
	block.height,
	block.date,
	block.version,
	block.purpose,
	signer.public_key AS signer,
	upper(encode(block.staple, 'hex')) AS staple,
	block.staple_time,
	block.position,
	block.operation_count,
	block.account_id,
	block.hash AS hash_bytes,
	block.staple AS staple_bytes
FROM explorer.decoded_blocks block
JOIN public.accounts account ON account.id = block.account_id
JOIN public.accounts signer ON signer.id = block.signer_id;

-- The block_hash text comes from the blocks row, whose hash text is indexed.
-- The join is to a primary key and outer, so a query that reads no block_hash
-- leaves it out of the plan.
CREATE VIEW explorer.operations AS
SELECT
	upper(encode(block.hash, 'hex')) AS block_hash,
	operation.idx,
	operation.type,
	account.public_key AS account,
	counterparty.public_key AS counterparty,
	token.public_key AS token,
	operation.amount,
	operation.staple_time,
	operation.details,
	operation.account_id,
	operation.counterparty_id,
	operation.token_id,
	operation.block_hash AS block_hash_bytes
FROM explorer.decoded_operations operation
LEFT JOIN explorer.decoded_blocks block ON block.hash = operation.block_hash
JOIN public.accounts account ON account.id = operation.account_id
LEFT JOIN public.accounts counterparty ON counterparty.id = operation.counterparty_id
LEFT JOIN public.accounts token ON token.id = operation.token_id;

COMMENT ON VIEW explorer.operations IS 'One row per operation. amount is in base units. details holds the fields particular to the type. For an account''s latest operations filter on account_id = explorer.id_of(address) and order by staple_time DESC.';

-- The two sides are a union of bare scans of one table, with the accounts
-- joined above it and the filter of sends outside it. Only an arm with no join
-- and no WHERE of its own becomes a member of the scan the outer query orders;
-- any other is planned apart, without that order, and then the two index
-- orders are not merged. The outer filter is folded into each arm: true for
-- out, type = 'SEND' for in.
CREATE VIEW explorer.account_history AS
SELECT
	account.public_key AS account,
	side.direction,
	side.staple_time,
	upper(encode(side.block_hash, 'hex')) AS block_hash,
	side.idx,
	side.type,
	counterparty.public_key AS counterparty,
	token.public_key AS token,
	side.amount,
	side.account_id,
	side.counterparty_id,
	side.token_id
FROM (
	SELECT 'out'::text AS direction, account_id, counterparty_id, token_id, staple_time, block_hash, idx, type, amount
	FROM explorer.decoded_operations
	UNION ALL
	SELECT 'in'::text AS direction, counterparty_id, account_id, token_id, staple_time, block_hash, idx, type, amount
	FROM explorer.decoded_operations
) side
JOIN public.accounts account ON account.id = side.account_id
LEFT JOIN public.accounts counterparty ON counterparty.id = side.counterparty_id
LEFT JOIN public.accounts token ON token.id = side.token_id
WHERE side.direction = 'out' OR side.type = 'SEND';

COMMENT ON VIEW explorer.account_history IS 'Each operation once for its block''s account (out) and each send once more for its recipient (in), whose counterparty is then the sender. For an account''s latest history filter on account_id = explorer.id_of(address) and order by staple_time DESC.';

CREATE VIEW explorer.rep_weights AS
SELECT rep.public_key AS rep, weight.weight
FROM public.weights weight
JOIN public.accounts rep ON rep.id = weight.representative_id;

CREATE VIEW explorer.delegations AS
SELECT account.public_key AS account, rep.public_key AS rep
FROM public.delegations delegation
JOIN public.accounts account ON account.id = delegation.account_id
JOIN public.accounts rep ON rep.id = delegation.representative_id;

CREATE VIEW explorer.acl AS
SELECT
	principal.public_key AS principal,
	upper(encode(acl.certificate, 'hex')) AS certificate_hash,
	entity.public_key AS entity,
	target.public_key AS target,
	acl.base_permissions AS base_flags,
	acl.external_permissions AS external_flags
FROM public.acls acl
JOIN public.accounts principal ON principal.id = acl.principal_id
JOIN public.accounts entity ON entity.id = acl.entity_id
JOIN public.accounts target ON target.id = acl.target_id;

CREATE VIEW explorer.certificates AS
SELECT
	account.public_key AS account,
	upper(encode(certificate.hash, 'hex')) AS hash,
	translate(encode(certificate.certificate, 'base64'), E'\n', '') AS certificate,
	translate(encode(certificate.intermediates, 'base64'), E'\n', '') AS intermediates
FROM public.certificates certificate
JOIN public.accounts account ON account.id = certificate.account_id;

COMMENT ON VIEW explorer.certificates IS 'certificate and intermediates are base64 of their DER bytes.';

CREATE VIEW explorer.staples AS
SELECT
	upper(encode(staple.blocks_hash, 'hex')) AS blocks_hash,
	staple.staple_time,
	staple.sequence,
	EXISTS (SELECT FROM explorer.indexed_staples indexed WHERE indexed.blocks_hash = staple.blocks_hash) AS indexed,
	staple.blocks_hash AS blocks_hash_bytes
FROM public.staples staple;

CREATE VIEW explorer.votes AS
SELECT
	upper(encode(vote.blocks_hash, 'hex')) AS staple,
	issuer.public_key AS issuer,
	vote.validity_from,
	vote.validity_to,
	vote.permanent,
	vote.blocks_hash AS staple_bytes
FROM public.votes vote
JOIN public.accounts issuer ON issuer.id = vote.issuer_id
WHERE vote.ledger = 'main';

-- The facts freshness() reads, for the reader.
CREATE VIEW explorer.status AS
SELECT
	indexed.sequence AS newest_indexed_sequence,
	indexed.staple_time AS newest_indexed_staple_time,
	node.sequence AS newest_node_sequence,
	node.staple_time AS newest_node_staple_time,
	(
		SELECT count(*) FROM public.staples staple
		WHERE staple.sequence > progress.watermark
			AND NOT EXISTS (SELECT FROM explorer.indexed_staples indexed WHERE indexed.blocks_hash = staple.blocks_hash)
	) AS behind,
	progress.paused_reason
FROM explorer.progress progress
LEFT JOIN LATERAL (SELECT sequence, staple_time FROM explorer.indexed_staples ORDER BY sequence DESC LIMIT 1) indexed ON true
LEFT JOIN LATERAL (SELECT sequence, staple_time FROM public.staples ORDER BY sequence DESC LIMIT 1) node ON true;
