import { expect, test } from 'bun:test';
import { type ArgNode, completeArgs } from '../src/completions';

const TREE: ArgNode[] = [
	{ word: 'status', description: '' },
	{ word: 'summary', description: '', next: [{ word: 'last', description: '' }] },
	{
		word: 'config',
		description: '',
		next: [
			{ word: 'add', description: '' },
			{ word: 'build', description: '', next: [{ word: 'add', description: '' }] },
		],
	},
];
const values = (prefix: string) => completeArgs(TREE, prefix)?.map(c => c.value) ?? null;

test('only the level under the typed words is offered, as full argument text', () => {
	expect(values('')).toEqual(['status', 'summary ', 'config ']);
	expect(values('s')).toEqual(['status', 'summary ']);
	expect(values('config ')).toEqual(['config add', 'config build ']);
	expect(values('config build a')).toEqual(['config build add']);
});

test('nothing past a leaf or an unknown word', () => {
	expect(values('status ')).toBeNull();
	expect(values('nope ')).toBeNull();
	expect(values('config x')).toBeNull();
});
