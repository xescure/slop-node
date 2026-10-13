/**
 * The KeetaNet release whose protocol this node speaks: the release of the
 * client package it runs on, which pins the ledger and vote rules.
 */
export const KEETANET_CLIENT_VERSION = '0.18.8';

/**
 * What the node reports as its version: the release it speaks, with build
 * metadata naming this implementation, so that it is never mistaken for a
 * build of upstream's own node.
 */
export const NODE_VERSION: string = `${KEETANET_CLIENT_VERSION}+slop-node`;
