import { expect, test } from 'bun:test';
import { formatState, parseState } from '../src/state';
import { buildMatcher } from '../src/steps';
import { BuildTracker } from '../src/tracker';
import type { Run } from '../src/types';

const run = (over: Partial<Run>): Run => ({
	id: 'bg_1',
	command: 'cargo test',
	steps: ['test'],
	live: 'test',
	state: 'completed',
	who: 'main',
	kind: 'main',
	start: 100,
	end: 200,
	root: '/src/repo',
	tree: 'abc',
	...over,
});

test('a saved session comes back with its results, and a build cut off by the restart as stopped', () => {
	const text = formatState({
		runs: [
			run({}),
			run({ id: 'bg_2', start: 300, state: 'running', end: undefined }),
			run({ id: 'pid:9', kind: 'other', who: 'other pane' }),
		],
		summaries: [{ text: 'done', at: '2026-11-11T00:00:00.000Z' }],
	});
	const state = parseState(text, 5_000);
	expect(state?.runs.map(r => [r.id, r.state, r.end])).toEqual([
		['bg_2', 'cancelled', 5_000],
		['bg_1', 'completed', 200],
	]);
	expect(state?.summaries.map(s => s.text)).toEqual(['done']);
	expect(parseState('{"version":2}', 0)).toBeNull();
	expect(parseState('not json', 0)).toBeNull();
});

test('a new process reusing a saved job id does not hide the saved result', () => {
	const tracker = new BuildTracker(buildMatcher([{ command: 'cargo' }]));
	tracker.reset([run({ id: 'bg_1', start: 100 })]);
	const fresh = { id: 'bg_1', command: 'cargo check', status: 'running', startTime: 900 };
	const runs = tracker.runs({ running: [fresh], recent: [] });
	expect(runs.map(r => [r.id, r.start])).toEqual([
		['bg_1', 900],
		['bg_1', 100],
	]);
	tracker.clear();
	expect(tracker.runs({ running: [fresh], recent: [] }).map(r => r.start)).toEqual([900]);
});
