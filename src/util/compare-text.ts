/** Orders strings by their characters' codes, as strings compare. */
export function compareText(left: string, right: string): number {
	if (left < right) {
		return(-1);
	}
	if (left > right) {
		return(1);
	}
	return(0);
}
