/** Works through the items with at most that many at once, each started as another finishes, and answers in their order. */
export async function eachAtMost<Item, Result>(items: readonly Item[], concurrency: number, work: (item: Item) => Promise<Result>): Promise<Result[]> {
	const results: Result[] = [];
	let next = 0;
	async function worker(): Promise<void> {
		for (let index = next++; index < items.length; index = next++) {
			const item = items[index];
			if (item !== undefined) {
				results[index] = await work(item);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return(results);
}
