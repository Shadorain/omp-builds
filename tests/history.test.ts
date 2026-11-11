import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passedDurations, StepHistory } from '../src/history';
import type { Run } from '../src/types';

const run = (over: Partial<Run>): Run => ({
	id: 'bg_1',
	command: 'cargo test',
	steps: ['test'],
	live: 'test',
	state: 'completed',
	who: 'main',
	kind: 'main',
	start: 0,
	end: 60_000,
	root: null,
	tree: null,
	...over,
});

const dir = await mkdtemp(join(tmpdir(), 'omp-builds-history-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

test('only steps that passed count: a lone step by its run, a chain step by its process', () => {
	expect(passedDurations(run({}))).toEqual({ test: 60_000 });
	const chain = {
		steps: ['check', 'test'],
		timings: { check: { start: 0, end: 20_000 }, test: { start: 20_000, end: 50_000 } },
	};
	// Failed at test: check passed, test's time is a failure's and does not count.
	expect(passedDurations(run({ ...chain, state: 'failed' }))).toEqual({ check: 20_000 });
	expect(passedDurations(run({ ...chain }))).toEqual({ check: 20_000, test: 30_000 });
	expect(passedDurations(run({ state: 'running', end: undefined }))).toEqual({});
	expect(passedDurations(run({ state: 'cancelled' }))).toEqual({});
});

test('the usual time is the median of recent passes, each run counted once, shared through the file', async () => {
	const path = join(dir, 'demo.json');
	const a = new StepHistory(path);
	expect(a.usual('test')).toBeNull();
	for (const [i, ms] of [10_000, 90_000, 30_000].entries()) {
		const r = run({ id: `bg_${i}`, start: i * 100_000, end: i * 100_000 + ms });
		a.record(r);
		a.record(r);
	}
	expect(a.usual('test')).toBe(30_000);
	await a.save();
	const b = new StepHistory(path);
	await b.load();
	expect(b.usual('test')).toBe(30_000);
	b.record(run({ id: 'bg_9', start: 900_000, end: 940_000 }));
	await b.save();
	await a.load();
	expect(a.usual('test')).toBe(35_000);
});
