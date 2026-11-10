/** One argument word and what may follow it. */
export interface ArgNode {
	word: string;
	description: string;
	next?: ArgNode[];
}

export interface Completion {
	value: string;
	label: string;
	description: string;
}

/**
 * Completions for the word being typed: only the level under the words already completed, so
 * `/builds ` lists `config` but not `config add` until `config ` is typed.
 */
export function completeArgs(tree: ArgNode[], prefix: string): Completion[] | null {
	const words = prefix.trimStart().split(/\s+/);
	const partial = words.pop() ?? '';
	let level = tree;
	for (const word of words) {
		const node = level.find(n => n.word === word);
		if (!node?.next) return null;
		level = node.next;
	}
	const head = words.length ? `${words.join(' ')} ` : '';
	const items = level
		.filter(n => n.word.startsWith(partial))
		.map(n => ({ value: `${head}${n.word}${n.next ? ' ' : ''}`, label: n.word, description: n.description }));
	return items.length ? items : null;
}
