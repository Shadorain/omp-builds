import { basename, resolve } from 'node:path';
import type { BuildConfig } from './config';
import type { Fixer, Run, Step, StepState } from './types';

/** The configured build command, compiled once: finds its steps in shell commands and process argv. */
export interface BuildMatcher {
	/** Display form, e.g. `cargo auto`. */
	command: string;
	pattern: RegExp;
	/** argv words that run a step, e.g. `cargo-auto`, `auto`. */
	process: string[];
	steps: Set<string> | null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s: string) => s.trim().split(/\s+/);

export function buildMatcher(build: BuildConfig): BuildMatcher {
	const head = words(build.command).map(escapeRegex).join('\\s+');
	return {
		command: words(build.command).join(' '),
		// A toolchain like `+nightly` may sit before the step; flags never count as one.
		pattern: new RegExp(`(?:^|[\\s;&|(])${head}\\s+(?:\\+\\S+\\s+)?([^\\s;&|()<>-][^\\s;&|()<>]*)`, 'g'),
		process: words(build.process ?? build.command),
		steps: build.steps ? new Set(build.steps) : null,
	};
}

const allowed = (m: BuildMatcher, step: string) => !m.steps || m.steps.has(step);

/** Step names in a shell command, in order: `cargo auto check && cargo auto test` → check, test. */
export const stepsOf = (m: BuildMatcher, command: string) =>
	[...command.matchAll(m.pattern)].map(x => x[1]).filter(step => allowed(m, step));

export const isBuild = (m: BuildMatcher, command: string) => stepsOf(m, command).length > 0;

/** The step a process runs, when its argv is the build's process (`cargo-auto auto test` → test). */
export function processStep(m: BuildMatcher, argv: string[]): string | null {
	const [first, ...rest] = m.process;
	for (let i = 0; i < argv.length; i++) {
		if (basename(argv[i]) !== first || !rest.every((w, j) => argv[i + 1 + j] === w)) continue;
		const step = argv.slice(i + 1 + rest.length).find(a => !a.startsWith('+') && !a.startsWith('-'));
		return step && allowed(m, step) ? step : null;
	}
	return null;
}

/**
 * Directory a bash call builds in: the tool's `cwd` argument, then a `cd <dir> &&` before the
 * first build command, both relative to the session directory.
 */
export function buildDir(m: BuildMatcher, command: string, sessionCwd: string, toolCwd?: string): string {
	const base = toolCwd ? resolve(sessionCwd, toolCwd) : sessionCwd;
	const first = [...command.matchAll(m.pattern)].find(x => allowed(m, x[1]));
	const head = command.slice(0, (first?.index ?? command.length) + 1);
	const cds = [...head.matchAll(/(?:^|[;&|(]\s*)cd\s+(["']?)([^\s"';&|]+)\1\s*&&/g)];
	const dir = cds.at(-1)?.[2];
	return dir ? resolve(base, dir) : base;
}

/** Make a pipeline fail when the build fails, so `cargo auto test | tail` still reports it. */
export const withPipefail = (command: string) =>
	/\bpipefail\b/.test(command) || !command.includes('|') ? command : `set -o pipefail; ${command}`;

type Outcome = Pick<Step, 'name' | 'state' | 'who' | 'kind' | 'start' | 'end'>;

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
	/** The session's own checkout; runs elsewhere are labelled with their worktree. */
	mainRoot: string | null;
	/** Current working-tree stamp of a checkout; results built from another tree are stale. */
	currentTree(root: string): string | null;
	/** Subagents working right now; one that started after a failure in its checkout is fixing it. */
	fixers: Fixer[];
	maxSteps: number;
}

/** The latest outcome per step and checkout, ordered by when each first appeared. */
export function mergeSteps(runs: Run[], { mainRoot, currentTree, fixers, maxSteps }: MergeOptions): Step[] {
	const latest = new Map<string, Step>();
	// Keys whose step failed in that checkout before the run now shown: a subagent rebuilding it is fixing it.
	const failedBefore = new Set<string>();
	const order: string[] = [];
	for (const run of [...runs].sort((a, b) => a.start - b.start)) {
		const root = run.root ?? mainRoot;
		const where = root && root !== mainRoot ? basename(root) : null;
		const current = root ? currentTree(root) : null;
		const stale = run.state !== 'running' && !!run.tree && !!current && run.tree !== current;
		for (const outcome of expand(run)) {
			const key = where ? `${outcome.name}@${where}` : outcome.name;
			if (!order.includes(key)) order.push(key);
			const prev = latest.get(key);
			if (prev) failedBefore[prev.state === 'failed' ? 'add' : 'delete'](key);
			latest.set(key, { ...outcome, where, root, stale });
		}
	}
	return order.slice(-maxSteps).map(key => {
		const step = latest.get(key) as Step;
		if (step.state === 'running' && step.kind === 'sub' && failedBefore.has(key)) return { ...step, state: 'fixing' };
		if (step.state !== 'failed') return step;
		const fixer = fixers.find(
			f => (f.root === null || (f.root ?? mainRoot) === step.root) && f.start >= (step.end ?? 0) - 1_000,
		);
		return fixer ? { ...step, state: 'fixing', who: fixer.who, kind: 'sub', start: fixer.start, stale: false } : step;
	});
}
