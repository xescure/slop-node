-- Explorer schema version 2: the views the reader queries, with addresses as
-- keeta_ text, hashes as upper-case hex and amounts as exact numerics.
--
-- The views run with the writer's rights, so they reach public.* where the
-- reader cannot. Each address column is a public.accounts.public_key, so a
-- filter on it is an index lookup there and then on the explorer's own
-- indexes by account id.

-- The views of decoded blocks and operations take the tables' names.
ALTER TABLE explorer.blocks RENAME TO decoded_blocks;
ALTER TABLE explorer.operations RENAME TO decoded_operations;

-- Metadata is untrusted publisher text: anything but base64 of a JSON object
-- with an integer decimalPlaces gives NULL, and no input raises an error
-- inside a query.
CREATE FUNCTION explorer.decimals_of(metadata text) RETURNS integer
	LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
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

-- A filter on a block's hash text reaches its decoded_blocks row through this
-- index, and its decoded_operations rows through that row's hash.
CREATE INDEX blocks_hash_text ON explorer.decoded_blocks (upper(encode(hash, 'hex')));

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
	info.multisig_quorum
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
	supply.supply
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
	(SELECT count(*) FROM explorer.holdings holding WHERE holding.token_id = token.id) AS holders_count
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
	trim_scale(holding.balance * 10::numeric ^ (-token_decimals.decimals)) AS amount_units
FROM explorer.holdings holding
JOIN public.accounts holder ON holder.id = holding.account_id
JOIN public.accounts token ON token.id = holding.token_id
LEFT JOIN public.account_info info ON info.account_id = holding.token_id
CROSS JOIN LATERAL (SELECT explorer.decimals_of(info.metadata) AS decimals) token_decimals;

COMMENT ON VIEW explorer.balances IS 'Non-zero balances. amount is in base units; amount_units divides it by 10^decimals.';

CREATE VIEW explorer.holders AS
SELECT account, token, amount, decimals, amount_units FROM explorer.balances;

COMMENT ON VIEW explorer.holders IS 'The rows of balances, for listing a token''s holders: filter on token and order by amount DESC.';

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
	block.operation_count
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
	operation.details
FROM explorer.decoded_operations operation
LEFT JOIN explorer.decoded_blocks block ON block.hash = operation.block_hash
JOIN public.accounts account ON account.id = operation.account_id
LEFT JOIN public.accounts counterparty ON counterparty.id = operation.counterparty_id
LEFT JOIN public.accounts token ON token.id = operation.token_id;

COMMENT ON VIEW explorer.operations IS 'One row per operation. amount is in base units. details holds the fields particular to the type.';

CREATE VIEW explorer.account_history AS
SELECT
	account.public_key AS account,
	'out' AS direction,
	operation.staple_time,
	upper(encode(operation.block_hash, 'hex')) AS block_hash,
	operation.idx,
	operation.type,
	counterparty.public_key AS counterparty,
	token.public_key AS token,
	operation.amount
FROM explorer.decoded_operations operation
JOIN public.accounts account ON account.id = operation.account_id
LEFT JOIN public.accounts counterparty ON counterparty.id = operation.counterparty_id
LEFT JOIN public.accounts token ON token.id = operation.token_id
UNION ALL
SELECT
	recipient.public_key AS account,
	'in' AS direction,
	operation.staple_time,
	upper(encode(operation.block_hash, 'hex')) AS block_hash,
	operation.idx,
	operation.type,
	sender.public_key AS counterparty,
	token.public_key AS token,
	operation.amount
FROM explorer.decoded_operations operation
JOIN public.accounts recipient ON recipient.id = operation.counterparty_id
JOIN public.accounts sender ON sender.id = operation.account_id
LEFT JOIN public.accounts token ON token.id = operation.token_id
WHERE operation.type = 'SEND';

COMMENT ON VIEW explorer.account_history IS 'Each operation once for its block''s account (out) and each send once more for its recipient (in), whose counterparty is then the sender.';

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
	EXISTS (SELECT FROM explorer.indexed_staples indexed WHERE indexed.blocks_hash = staple.blocks_hash) AS indexed
FROM public.staples staple;

CREATE VIEW explorer.votes AS
SELECT
	upper(encode(vote.blocks_hash, 'hex')) AS staple,
	issuer.public_key AS issuer,
	vote.validity_from,
	vote.validity_to,
	vote.permanent
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
