import { describe, expect, test } from 'bun:test';
import { mergeSteps, stepsOf } from '../src/steps';
import type { Run } from '../src/types';

const run = (over: Partial<Run>): Run => ({
	steps: ['check'],
	live: null,
	state: 'completed',
	who: 'main',
	kind: 'main',
	start: 0,
	end: 10,
	tree: 'aaa',
	...over,
});

const merge = (runs: Run[], over: Partial<Parameters<typeof mergeSteps>[1]> = {}) =>
	mergeSteps(runs, { currentTree: 'aaa', fixers: [], maxSteps: 5, ...over }).map(s => [s.name, s.state, s.stale]);

describe('stepsOf', () => {
	test('reads every step of a chained command', () => {
		expect(stepsOf('cd x && cargo auto check && cargo auto test -p api; echo done')).toEqual(['check', 'test']);
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
		expect(merge([failed], { fixers: [{ who: 'Dash', start: 1_000 }] })).toEqual([['test', 'failed', false]]);
		expect(merge([failed], { fixers: [{ who: 'Dash', start: 6_000 }] })).toEqual([['test', 'fixing', false]]);
	});

	test("a subagent's own running build shows as fixing", () => {
		const fixerRun = run({ steps: ['test'], state: 'running', kind: 'sub', who: 'Dash', end: undefined });
		expect(merge([fixerRun])).toEqual([['test', 'fixing', false]]);
	});

	test('a run that vanished without a status shows nothing', () => {
		expect(merge([run({ state: 'finished' })])).toEqual([]);
	});
});
