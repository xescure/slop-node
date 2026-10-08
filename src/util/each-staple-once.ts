/**
 * Each staple once, where it is first listed. A node's catch-up lists a
 * staple again for each read of votes that holds one of its votes
 * (schema/CONTRACT.md, D8), which a caller after the staples themselves
 * leaves out.
 */
export function eachStapleOnce<Staple extends { readonly blocksHash: { toString(): string } }>(staples: readonly Staple[]): Staple[] {
	const seen = new Set<string>();
	return(staples.filter(function(staple): boolean {
		const key = staple.blocksHash.toString();
		if (seen.has(key)) {
			return(false);
		}
		seen.add(key);
		return(true);
	}));
}
