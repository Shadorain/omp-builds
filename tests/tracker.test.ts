import { expect, test } from 'bun:test';
import { buildMatcher } from '../src/steps';
import { BuildTracker } from '../src/tracker';
import type { Job } from '../src/types';

const job = (id: string, command: string): Job => ({ id, command, status: 'running', startTime: 1 });

test('jobs started together keep their own checkout when one command contains the other', () => {
	const tracker = new BuildTracker(buildMatcher([{ command: 'cargo' }]));
	const tree = Promise.resolve(null);
	tracker.expect('cargo test', '/src/repo', tree);
	tracker.expect('cd ../repo-api && cargo test', '/src/repo-api', tree);
	// The worktree job is listed first, so a substring match would hand it the main checkout.
	const runs = tracker.runs({
		running: [job('bg_3', 'cd ../repo-api && cargo test'), job('bg_2', 'cargo test')],
		recent: [],
	});
	expect(Object.fromEntries(runs.map(r => [r.id, r.root]))).toEqual({ bg_2: '/src/repo', bg_3: '/src/repo-api' });
});
