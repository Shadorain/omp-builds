import type { Fixer, Run, Step, StepState } from './types';

export const CARGO_AUTO = /(?:^|[\s;&|(])cargo\s+auto\s+(\S+)/;
const CARGO_AUTO_ALL = /(?:^|[\s;&|(])cargo\s+auto\s+(\S+)/g;

/** Step names in a shell command, in order: `cargo auto check && cargo auto test` → check, test. */
export const stepsOf = (command: string) => [...command.matchAll(CARGO_AUTO_ALL)].map(m => m[1]);

type Outcome = Omit<Step, 'stale'>;

/** Steps a run reached, with each one's outcome. A failed chain failed at the step that was live last. */
export function expand(run: Run): Outcome[] {
	// A job that vanished without a status, or a fixer aborted mid-build: no outcome to show.
	if (run.state === 'finished') return [];
	const live = run.live ? run.steps.indexOf(run.live) : -1;
	const at =
		run.state === 'running'
			? Math.max(live, 0)
			: run.state === 'failed'
				? live >= 0
					? live
					: run.steps.length - 1
				: run.steps.length;
	const out: Outcome[] = [];
	run.steps.forEach((name, i) => {
		let state: StepState | null = null;
		if (run.state === 'cancelled') state = 'cancelled';
		else if (run.state === 'completed' || i < at) state = 'passed';
		else if (i === at) state = run.state === 'running' ? 'running' : 'failed';
		if (state) out.push({ name, state, who: run.who, kind: run.kind, start: run.start, end: run.end });
	});
	return out;
}

export interface MergeOptions {
	/** Current working-tree stamp; results built from another tree are stale. */
	currentTree: string | null;
	/** Subagents working right now; one that started after a failure is fixing it. */
	fixers: Fixer[];
	maxSteps: number;
}

/** The latest outcome per step name, ordered by when each step first appeared. */
export function mergeSteps(runs: Run[], { currentTree, fixers, maxSteps }: MergeOptions): Step[] {
	const latest = new Map<string, Step>();
	const order: string[] = [];
	for (const run of [...runs].sort((a, b) => a.start - b.start)) {
		const stale = run.state !== 'running' && !!run.tree && !!currentTree && run.tree !== currentTree;
		for (const outcome of expand(run)) {
			if (!order.includes(outcome.name)) order.push(outcome.name);
			latest.set(outcome.name, { ...outcome, stale });
		}
	}
	return order.slice(-maxSteps).map(name => {
		const step = latest.get(name) as Step;
		if (step.state === 'running' && step.kind === 'sub') return { ...step, state: 'fixing' };
		if (step.state !== 'failed') return step;
		const fixer = fixers.find(f => f.start >= (step.end ?? 0) - 1_000);
		return fixer ? { ...step, state: 'fixing', who: fixer.who, kind: 'sub', start: fixer.start, stale: false } : step;
	});
}
