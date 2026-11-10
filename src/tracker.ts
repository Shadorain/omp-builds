import { CARGO_AUTO, mergeSteps, stepsOf } from './steps';
import type { Build, Fixer, Foreground, Job, Run, RunState, Step } from './types';

const MAX_OWN_JOBS = 8;
const MAX_FOREGROUND = 8;
const MAX_PENDING = 20;
const MAX_STEPS = 5;
const RUN_STATES: RunState[] = ['running', 'completed', 'failed', 'cancelled', 'finished'];
const FOREGROUND_KEY = Symbol.for('omp-builds.foreground');

// Every extension instance in this process (the main session and each subagent) shares this
// map, so the main status line sees fixers' foreground builds with their real exit status.
const foreground = ((globalThis as Record<symbol, unknown>)[FOREGROUND_KEY] ??= new Map()) as Map<string, Foreground>;

export function startForeground(toolCallId: string, run: Foreground): void {
	foreground.set(toolCallId, run);
	const done = [...foreground]
		.filter(([, f]) => f.state !== 'running')
		.sort(([, a], [, b]) => (a.end ?? 0) - (b.end ?? 0));
	for (const [id] of done.slice(0, Math.max(0, foreground.size - MAX_FOREGROUND))) foreground.delete(id);
}

export function settleForeground(toolCallId: string, failed: boolean): void {
	const run = foreground.get(toolCallId);
	if (!run || run.state !== 'running') return;
	run.state = failed ? 'failed' : 'completed';
	run.end = Date.now();
}

const jobCommand = (job: Job) => job.command ?? job.label ?? '';

interface PendingStamp {
	command: string;
	tree: Promise<string | null>;
}

type Snapshot = { running: Job[]; recent: Job[] } | null | undefined;

/** Turns the session's job snapshot, the shared foreground map and the process scan into steps. */
export class BuildTracker {
	/** This project's running `cargo auto` processes, from the last scan. */
	builds: Build[] = [];
	#clearedAt = 0;
	#pending: PendingStamp[] = [];
	#trees = new Map<string, string | null>();
	#live = new Map<string, string>();
	// Delivered jobs leave the snapshot; keep their last state so the line still shows the result.
	#seen = new Map<string, Job>();

	reset(): void {
		this.#seen.clear();
		this.#trees.clear();
		this.#live.clear();
	}

	/** Drop finished results from the line; running builds stay. */
	clear(): void {
		this.#clearedAt = Date.now();
		for (const [id, job] of this.#seen) if (job.status !== 'running') this.#seen.delete(id);
	}

	/** A backgrounded command is about to start; its tree stamp lands on the job once it shows up. */
	expect(command: string, tree: Promise<string | null>): void {
		this.#pending.push({ command, tree });
		if (this.#pending.length > MAX_PENDING) this.#pending.shift();
	}

	setBuilds(builds: Build[]): void {
		this.builds = builds;
		// A subagent aborted mid-build never reports a result; once its process is gone, stop the spinner.
		const live = new Set(builds.filter(b => b.owner === process.pid).map(b => b.step));
		for (const run of foreground.values()) {
			if (run.state !== 'running' || Date.now() - run.start < 10_000) continue;
			run.missing = run.steps.some(s => live.has(s)) ? 0 : run.missing + 1;
			if (run.missing >= 3) Object.assign(run, { state: 'finished', end: Date.now() });
		}
	}

	steps(snapshot: Snapshot, currentTree: string | null): Step[] {
		const claimed = new Set<number>();
		// Which step of a running command is live, from the cargo-auto process it spawned.
		const liveStep = (steps: string[], start: number) => {
			const proc = this.builds.find(
				b => b.owner === process.pid && !claimed.has(b.pid) && steps.includes(b.step) && b.start >= start - 2_000,
			);
			if (proc) claimed.add(proc.pid);
			return proc?.step ?? null;
		};

		const runs: Run[] = [];
		for (const job of this.#ownJobs(snapshot)) {
			const steps = stepsOf(jobCommand(job));
			const live = job.status === 'running' ? liveStep(steps, job.startTime ?? 0) : null;
			if (live) this.#live.set(job.id, live);
			runs.push({
				steps,
				live: this.#live.get(job.id) ?? null,
				state: RUN_STATES.find(s => s === job.status) ?? 'failed',
				who: 'main',
				kind: 'main',
				start: job.startTime ?? Date.now(),
				end: job.status === 'running' ? undefined : job.endTime,
				tree: this.#trees.get(job.id) ?? null,
			});
		}
		for (const run of foreground.values()) {
			if (run.state !== 'running' && (run.end ?? 0) <= this.#clearedAt) continue;
			if (run.state === 'running') run.live = liveStep(run.steps, run.start) ?? run.live;
			runs.push(run);
		}
		for (const b of this.builds) {
			if (b.owner === process.pid) continue;
			runs.push({
				steps: [b.step],
				live: b.step,
				state: 'running',
				who: 'other pane',
				kind: 'other',
				start: b.start,
				tree: null,
			});
		}

		const fixers: Fixer[] = [
			...[...foreground.values()]
				.filter(f => f.kind === 'sub' && f.state === 'running')
				.map(f => ({ who: f.who, start: f.start })),
			...(snapshot?.running ?? [])
				.filter(j => j.type === 'task')
				.map(j => ({ who: j.label ?? 'fixer', start: j.startTime ?? Date.now() })),
		];
		return mergeSteps(runs, { currentTree, fixers, maxSteps: MAX_STEPS });
	}

	#ownJobs(snapshot: Snapshot): Job[] {
		if (!snapshot) return [];
		const live = [...snapshot.running, ...snapshot.recent].filter(
			j => CARGO_AUTO.test(jobCommand(j)) && (j.status === 'running' || (j.endTime ?? Infinity) > this.#clearedAt),
		);
		const liveIds = new Set(live.map(j => j.id));
		for (const job of this.#seen.values()) {
			if (!liveIds.has(job.id) && job.status === 'running')
				this.#seen.set(job.id, { ...job, status: 'finished', endTime: Date.now() });
		}
		for (const job of live) {
			this.#seen.set(job.id, job);
			if (this.#trees.has(job.id)) continue;
			const i = this.#pending.findIndex(p => p.command === jobCommand(job) || jobCommand(job).includes(p.command));
			if (i < 0) continue;
			this.#trees.set(job.id, null);
			this.#pending.splice(i, 1)[0].tree.then(tree => this.#trees.has(job.id) && this.#trees.set(job.id, tree));
		}
		const jobs = [...this.#seen.values()].sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
		for (const old of jobs.slice(MAX_OWN_JOBS)) {
			this.#seen.delete(old.id);
			this.#trees.delete(old.id);
			this.#live.delete(old.id);
		}
		return jobs.slice(0, MAX_OWN_JOBS);
	}
}
