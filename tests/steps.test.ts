import { describe, expect, test } from 'bun:test';
import { buildDir, mergeSteps, stepsOf, withPipefail } from '../src/steps';
import type { Run } from '../src/types';

const MAIN = '/src/repo';

const run = (over: Partial<Run>): Run => ({
	id: 'r',
	command: 'cargo auto check',
	steps: ['check'],
	live: null,
	state: 'completed',
	who: 'main',
	kind: 'main',
	start: 0,
	end: 10,
	root: null,
	tree: 'aaa',
	...over,
});

const merge = (runs: Run[], over: Partial<Parameters<typeof mergeSteps>[1]> = {}) =>
	mergeSteps(runs, { mainRoot: MAIN, currentTree: () => 'aaa', fixers: [], maxSteps: 6, ...over }).map(s => [
		s.where ? `${s.name}@${s.where}` : s.name,
		s.state,
		s.stale,
	]);

describe('stepsOf', () => {
	test('reads every step of a chained command', () => {
		expect(stepsOf('cd x && cargo auto check && cargo auto test -p api; echo done')).toEqual(['check', 'test']);
	});
});

describe('buildDir', () => {
	test('the tool cwd wins over the session directory, and a leading cd applies on top', () => {
		expect(buildDir('cargo auto test', '/src/repo')).toBe('/src/repo');
		expect(buildDir('cargo auto test', '/src/repo', '../wt-api')).toBe('/src/wt-api');
		expect(buildDir('cd /src/wt-ui && cargo auto test', '/src/repo')).toBe('/src/wt-ui');
		expect(buildDir('cd "crates/api" && cargo auto test', '/src/repo', '/src/wt-api')).toBe('/src/wt-api/crates/api');
	});

	test('a cd after the build does not move it', () => {
		expect(buildDir('cargo auto test && cd /tmp && ls', '/src/repo')).toBe('/src/repo');
	});
});

describe('withPipefail', () => {
	test('only pipelines change, once', () => {
		expect(withPipefail('cargo auto test')).toBe('cargo auto test');
		expect(withPipefail('cargo auto test 2>&1 | tail')).toBe('set -o pipefail; cargo auto test 2>&1 | tail');
		expect(withPipefail('set -o pipefail; cargo auto test | tail')).toBe('set -o pipefail; cargo auto test | tail');
	});
});

describe('mergeSteps', () => {
	test('a failed chain fails at the step that was live, earlier steps pass, later ones never ran', () => {
		const chain = run({ steps: ['check', 'test', 'clippy'], live: 'test', state: 'failed' });
		expect(merge([chain])).toEqual([
			['check', 'passed', false],
			['test', 'failed', false],
		]);
	});

	test('a running chain shows its live step running and the ones before it passed', () => {
		const chain = run({ steps: ['check', 'test'], live: 'test', state: 'running', end: undefined });
		expect(merge([chain])).toEqual([
			['check', 'passed', false],
			['test', 'running', false],
		]);
	});

	test('the latest run of a step wins', () => {
		const failed = run({ steps: ['test'], state: 'failed', start: 0, end: 10 });
		const passed = run({ steps: ['test'], state: 'completed', start: 20, end: 30 });
		expect(merge([passed, failed])).toEqual([['test', 'passed', false]]);
	});

	test('a result built from another tree is stale; a running one is not', () => {
		expect(merge([run({ tree: 'old' })])).toEqual([['check', 'passed', true]]);
		expect(merge([run({ tree: 'old', state: 'running', end: undefined })])).toEqual([['check', 'running', false]]);
	});

	test('a failure is being fixed only by a subagent that started after it', () => {
		const failed = run({ steps: ['test'], state: 'failed', end: 5_000 });
		expect(merge([failed], { fixers: [{ who: 'Dash', start: 1_000, root: null }] })).toEqual([
			['test', 'failed', false],
		]);
		expect(merge([failed], { fixers: [{ who: 'Dash', start: 6_000, root: null }] })).toEqual([
			['test', 'fixing', false],
		]);
	});

	test('each worktree keeps its own step, freshness and fixer', () => {
		const trees: Record<string, string> = { [MAIN]: 'aaa', '/src/wt-api': 'bbb', '/src/wt-ui': 'ccc' };
		const runs = [
			run({ steps: ['test'], state: 'completed', root: null, tree: 'aaa', start: 1, end: 9 }),
			run({ steps: ['test'], state: 'failed', root: '/src/wt-api', tree: 'bbb', start: 2, end: 5_000 }),
			run({ steps: ['test'], state: 'completed', root: '/src/wt-ui', tree: 'old', start: 3, end: 9 }),
		];
		const fixers = [{ who: 'Dash', start: 6_000, root: '/src/wt-ui' }];
		expect(merge(runs, { currentTree: root => trees[root], fixers })).toEqual([
			['test', 'passed', false],
			['test@wt-api', 'failed', false],
			['test@wt-ui', 'passed', true],
		]);
		const apiFixer = [{ who: 'Fives', start: 6_000, root: '/src/wt-api' }];
		expect(merge(runs, { currentTree: root => trees[root], fixers: apiFixer })[1]).toEqual([
			'test@wt-api',
			'fixing',
			false,
		]);
	});

	test("a subagent's running build is a fix only after that step failed in the same checkout", () => {
		const sub: Partial<Run> = {
			steps: ['test'],
			state: 'running',
			kind: 'sub',
			who: 'Dash',
			start: 20,
			end: undefined,
		};
		const failed = run({ steps: ['test'], state: 'failed', start: 0, end: 10 });
		expect(merge([run(sub)])).toEqual([['test', 'running', false]]);
		expect(merge([failed, run(sub)])).toEqual([['test', 'fixing', false]]);
		expect(merge([failed, run({ ...sub, root: '/src/wt-api' })])).toEqual([
			['test', 'failed', false],
			['test@wt-api', 'running', false],
		]);
	});

	test('a run that vanished without a status shows nothing', () => {
		expect(merge([run({ state: 'finished' })])).toEqual([]);
	});
});
