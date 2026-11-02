import type { JSONSerializableObject } from '@keetanetwork/keetanet-client/lib/utils/conversion.js';

export type Advertisement = {
	readonly kind: number;
	readonly key: string;
	readonly endpoints: { readonly api: string; readonly p2p: string };
	readonly preferUpdates: string;
	readonly signature: string;
} & JSONSerializableObject;

function mainRepresentative(index: number, key: string, signature: string): Advertisement {
	return({
		kind: 1,
		key,
		endpoints: { api: `https://rep${String(index)}.main.network.api.keeta.com/api`, p2p: `wss://rep${String(index)}.main.network.api.keeta.com/p2p` },
		preferUpdates: 'http',
		signature
	});
}

/** The main network's representatives' advertisements, signed as they greet peers. */
export const MAIN_REP1: Advertisement = mainRepresentative(1, 'keeta_aabwip6zeo2fnzfxp5hssrrqtascs2277w2zk7vqd6d3k3m4dkt2flcbca2mqki', 'MEUCAQAEQJgPSXpJ+hfIF/sBPo7m2mab9Lbke6aOyaLWseuBZPE/PnpghbdrWQxzZfr/hN7mRyy82ximwrrzWp1XoAxazOg=');
export const MAIN_REP2: Advertisement = mainRepresentative(2, 'keeta_aabvmwxttv4q56gbfveighwfwp3yvitlrdfsacic3ckqc7lqelsspvmhc7oldmq', 'MEUCAQAEQJploQp0Tzx8drrYLdYg9QzQZz0qjlGqtUPVDhr/iw/TIxUNuWn5jyDGZXdUrfhXFxpGqMIC09FnBM720R5/01U=');
export const MAIN_REP3: Advertisement = mainRepresentative(3, 'keeta_aabwqf5fnta4t2v2atieis545b3rqoq6z7x5w3geugiilqlz5jdsb5og2rmxvdq', 'MEUCAQAEQGxNihC39SnAki8mRNvpQNM9GzO8v2aJToJGoXoOLe4XX8LOx6KMYiy7osWk49JY34v+uaEDQEReHFhD6peXHhU=');
export const MAIN_REP4: Advertisement = mainRepresentative(4, 'keeta_aablpogflko72eusdhuuqgsto2rwcvy2m5mo5snmvrmbacz3qczwjtwpmzf5ufq', 'MEUCAQAEQHAncB4AasFKPJy1fWxf8MTzLeQAdlW3237CE6vcb+MbEzTOZ842u8BlU5at6i31vOPpS9ghN93ueN2P3a4gI9E=');
