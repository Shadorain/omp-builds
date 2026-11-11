import { treeStamp } from './git';
import { type BuildMatcher, isBuild, stepsOf } from './steps';
import type { Build, Fixer, Foreground, Job, Run, RunState, StepTiming } from './types';

const MAX_OWN_JOBS = 8;
const MAX_FOREGROUND = 12;
const MAX_OTHERS = 8;
const MAX_PENDING = 20;
const RUN_STATES: RunState[] = ['running', 'completed', 'failed', 'cancelled', 'finished'];
const FOREGROUND_KEY = Symbol.for('omp-builds.foreground');

// Every extension instance in this process (the main session and each subagent) shares this
// map, so the main status line sees fixers' foreground builds with their real exit status.
const foreground = ((globalThis as Record<symbol, unknown>)[FOREGROUND_KEY] ??= new Map()) as Map<string, Foreground>;

export function startForeground(run: Foreground): void {
	foreground.set(run.id, run);
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
	root: string | null;
	tree: Promise<string | null>;
}

interface JobMeta {
	stampRoot: string | null;
	tree: string | null;
	root: string | null;
	live: string | null;
	timings: Record<string, StepTiming>;
}

type Snapshot = { running: Job[]; recent: Job[] } | null | undefined;

/** Turns the session's job snapshot, the shared foreground map and the process scan into runs. */
export class BuildTracker {
	/** The configured build command; the extension swaps it when the config changes. */
	constructor(public matcher: BuildMatcher) {}

	/** This project's running build processes, from the last scan. */
	builds: Build[] = [];
	#scannedAt = 0;
	#clearedAt = 0;
	#pending: PendingStamp[] = [];
	#meta = new Map<string, JobMeta>();
	// Delivered jobs leave the snapshot; keep their last state so the line still shows the result.
	#seen = new Map<string, Job>();
	// Other sessions' builds, kept after their process exits so /builds status can list them.
	#others = new Map<number, Run>();
	// Results saved before this process opened the session; none of them is running.
	#saved: Run[] = [];

	reset(saved: Run[] = []): void {
		this.#seen.clear();
		this.#meta.clear();
		this.#others.clear();
		this.#saved = saved;
	}

	/** Drop finished results; running builds stay. */
	clear(): void {
		this.#clearedAt = Date.now();
		for (const [id, job] of this.#seen) if (job.status !== 'running') this.#seen.delete(id);
		for (const [pid, run] of this.#others) if (run.state !== 'running') this.#others.delete(pid);
		this.#saved = [];
	}

	/** A backgrounded command is about to start; its tree stamp lands on the job once it shows up. */
	expect(command: string, root: string | null, tree: Promise<string | null>): void {
		this.#pending.push({ command, root, tree });
		if (this.#pending.length > MAX_PENDING) this.#pending.shift();
	}

	setBuilds(builds: Build[]): void {
		this.builds = builds;
		this.#scannedAt = Date.now();
		const mine = new Set(builds.filter(b => b.owner === process.pid).map(b => b.step));
		// A subagent aborted mid-build never reports a result; once its process is gone, stop the spinner.
		for (const run of foreground.values()) {
			if (run.state !== 'running' || Date.now() - run.start < 10_000) continue;
			run.missing = run.steps.some(s => mine.has(s)) ? 0 : run.missing + 1;
			if (run.missing >= 3) Object.assign(run, { state: 'finished', end: Date.now() });
		}
		const alive = new Set<number>();
		for (const b of builds) {
			if (b.owner === process.pid) continue;
			alive.add(b.pid);
			if (this.#others.has(b.pid)) continue;
			this.#others.set(b.pid, {
				id: `pid:${b.pid}`,
				command: b.step,
				steps: [b.step],
				live: b.step,
				state: 'running',
				// A build under a systemd unit and no session (a dev server redeploy) is named by its unit.
				who: b.unit ?? 'other pane',
				kind: 'other',
				start: b.start,
				root: b.root,
				tree: null,
			});
		}
		// Their exit status is not visible from here.
		for (const [pid, run] of this.#others) {
			if (run.state === 'running' && !alive.has(pid)) Object.assign(run, { state: 'finished', end: Date.now() });
		}
		const old = [...this.#others]
			.filter(([, r]) => r.state !== 'running')
			.sort(([, a], [, b]) => (a.end ?? 0) - (b.end ?? 0));
		for (const [pid] of old.slice(0, Math.max(0, this.#others.size - MAX_OTHERS))) this.#others.delete(pid);
	}

	/** Every tracked run of this session, its subagents and the project's other sessions. */
	runs(snapshot: Snapshot): Run[] {
		const claimed = new Set<number>();
		// The cargo-auto process a running command spawned: which step is live and where it builds.
		// A run whose checkout is known only takes a process in that checkout, so parallel builds of
		// the same step in different worktrees never swap places.
		const claim = (steps: string[], start: number, root: string | null) => {
			const proc = this.builds.find(
				b =>
					b.owner === process.pid &&
					!claimed.has(b.pid) &&
					steps.includes(b.step) &&
					b.start >= start - 2_000 &&
					(root === null || b.root === root),
			);
			if (proc) claimed.add(proc.pid);
			return proc;
		};
		// A process stays in the scan until the next one, so its end is when it was last seen.
		const time = (timings: Record<string, StepTiming>, proc: Build) => {
			timings[proc.step] = { start: proc.start, end: Math.max(proc.start, this.#scannedAt) };
		};
		const restamp = (meta: { stampRoot: string | null; tree: string | null }, root: string | null) => {
			if (!root || root === meta.stampRoot) return;
			meta.stampRoot = root;
			void treeStamp(root).then(tree => {
				meta.tree = tree;
			});
		};

		const runs: Run[] = [];
		for (const job of this.#ownJobs(snapshot)) {
			const steps = stepsOf(this.matcher, jobCommand(job));
			const meta = this.#meta.get(job.id) ?? { stampRoot: null, tree: null, root: null, live: null, timings: {} };
			this.#meta.set(job.id, meta);
			const proc = job.status === 'running' ? claim(steps, job.startTime ?? 0, meta.root) : undefined;
			if (proc) {
				meta.live = proc.step;
				meta.root = proc.root ?? meta.root;
				restamp(meta, proc.root);
				time(meta.timings, proc);
			}
			runs.push({
				id: job.id,
				command: jobCommand(job),
				steps,
				live: meta.live,
				state: RUN_STATES.find(s => s === job.status) ?? 'failed',
				who: 'main',
				kind: 'main',
				start: job.startTime ?? Date.now(),
				end: job.status === 'running' ? undefined : job.endTime,
				root: meta.root,
				tree: meta.tree,
				timings: meta.timings,
			});
		}
		for (const run of foreground.values()) {
			if (run.state !== 'running' && (run.end ?? 0) <= this.#clearedAt) continue;
			const proc = run.state === 'running' ? claim(run.steps, run.start, run.root) : undefined;
			if (proc) {
				run.live = proc.step;
				run.root = proc.root ?? run.root;
				restamp(run, proc.root);
				time((run.timings ??= {}), proc);
			}
			runs.push(run);
		}
		for (const run of this.#others.values()) {
			if (run.state === 'running' || (run.end ?? 0) > this.#clearedAt) runs.push(run);
		}
		// Job ids restart at bg_1 in a new process; a saved run is the same job only if it also started together.
		const same = (a: Run, b: Run) => a.id === b.id && a.start === b.start;
		for (const run of this.#saved) if (!runs.some(r => same(r, run))) runs.push(run);
		return runs;
	}

	/** Subagents working right now: their builds, and running task jobs. */
	fixers(snapshot: Snapshot): Fixer[] {
		return [
			...[...foreground.values()]
				.filter(f => f.kind === 'sub' && f.state === 'running')
				.map(f => ({ who: f.who, start: f.start, root: f.root })),
			...(snapshot?.running ?? [])
				.filter(j => j.type === 'task')
				.map(j => ({ who: j.label ?? 'fixer', start: j.startTime ?? Date.now(), root: null })),
		];
	}

	#ownJobs(snapshot: Snapshot): Job[] {
		if (!snapshot) return [];
		const live = [...snapshot.running, ...snapshot.recent].filter(
			j =>
				isBuild(this.matcher, jobCommand(j)) && (j.status === 'running' || (j.endTime ?? Infinity) > this.#clearedAt),
		);
		const liveIds = new Set(live.map(j => j.id));
		for (const job of this.#seen.values()) {
			if (!liveIds.has(job.id) && job.status === 'running')
				this.#seen.set(job.id, { ...job, status: 'finished', endTime: Date.now() });
		}
		for (const job of live) {
			this.#seen.set(job.id, job);
			if (this.#meta.has(job.id)) continue;
			// Exact first: `cargo test` is a substring of `cd ../wt && cargo test` started alongside it.
			const command = jobCommand(job);
			const exact = this.#pending.findIndex(p => p.command === command);
			const i = exact >= 0 ? exact : this.#pending.findIndex(p => command.includes(p.command));
			if (i < 0) continue;
			const [stamp] = this.#pending.splice(i, 1);
			const meta: JobMeta = { stampRoot: stamp.root, tree: null, root: stamp.root, live: null, timings: {} };
			this.#meta.set(job.id, meta);
			void stamp.tree.then(tree => {
				if (meta.stampRoot === stamp.root) meta.tree = tree;
			});
		}
		const jobs = [...this.#seen.values()].sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
		for (const old of jobs.slice(MAX_OWN_JOBS)) {
			this.#seen.delete(old.id);
			this.#meta.delete(old.id);
		}
		return jobs.slice(0, MAX_OWN_JOBS);
	}
}
