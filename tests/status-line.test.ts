import { expect, test } from 'bun:test';
import { type Theme, statusLine } from '../src/status-line';
import type { DevPin, Step } from '../src/types';

const plain = { fg: (_color: string, text: string) => text } as unknown as Theme;

const step = (name: string): Step => ({
	name,
	state: 'passed',
	who: 'main',
	kind: 'main',
	start: 0,
	end: 10,
	where: null,
	root: null,
	stale: false,
	usual: null,
});

const pin: DevPin = { up: true, here: 'live', since: null, url: null, extras: [] };
const line = (width: number, steps: Step[]) => statusLine(plain, width, steps, pin, null, 0)[0];

test('the dev server always shows; chips that do not fit drop from the end as +N', () => {
	const steps = ['check', 'test', 'clippy', 'doc'].map(step);
	expect(line(120, steps)).toBe(' ✓ check • ✓ test • ✓ clippy • ✓ doc  │  dev ● live');
	expect(line(40, steps)).toBe(' ✓ check • ✓ test • +2  │  dev ● live');
	expect(line(18, steps)).toBe(' +4  │  dev ● live');
	expect(line(12, steps)).toBe(' dev ● live');
});
