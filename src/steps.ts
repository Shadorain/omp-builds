import { basename, resolve } from 'node:path';
import { asList, type BuildConfig } from './config';
import type { Fixer, Run, Step, StepState } from './types';

/** One configured build, compiled: finds its steps in shell commands and process argv. */
interface Rule {
	/** Display form, e.g. `cargo auto`. */
	command: string;
	label: string | null;
	pattern: RegExp;
	/** argv word lists that run a step, e.g. `cargo-auto`, `auto`. */
	process: string[][];
	steps: Set<string> | null;
}

/** Every build tracked in a project. */
export interface BuildMatcher {
	rules: Rule[];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s: string) => s.trim().split(/\s+/);

function rule(build: BuildConfig): Rule {
	const commands = asList(build.command).map(words);
	// Longest first, so `pnpm run test` reads as `pnpm run` + `test`, not `pnpm` + `run`.
	const heads = [...commands]
		.sort((a, b) => b.length - a.length)
		.map(c => c.map(escapeRegex).join('\\s+'))
		.join('|');
	return {
		command: commands[0].join(' '),
		label: build.label ?? null,
		// A toolchain like `+nightly` may sit before the step; flags never count as one.
		pattern: new RegExp(`(?:^|[\\s;&|(])(?:${heads})\\s+(?:\\+\\S+\\s+)?([^\\s;&|()<>-][^\\s;&|()<>]*)`, 'g'),
		process: asList(build.process ?? build.command).map(words),
		steps: build.steps ? new Set(build.steps) : null,
	};
}

export const buildMatcher = (builds: BuildConfig[]): BuildMatcher => ({ rules: builds.map(rule) });

const allowed = (r: Rule, step: string) => !r.steps || r.steps.has(step);
const stepName = (r: Rule, step: string) => (r.label ? `${r.label} ${step}` : step);

interface Hit {
	index: number;
	end: number;
	step: string;
	rule: Rule;
}

/** Build commands in a shell command, in order. Where two builds match at one spot, the longer wins. */
function hits(m: BuildMatcher, command: string): Hit[] {
	const all = m.rules
		.flatMap(r =>
			[...command.matchAll(r.pattern)]
				.filter(x => allowed(r, x[1]))
				.map(x => ({ index: x.index, end: x.index + x[0].length, step: stepName(r, x[1]), rule: r })),
		)
		.sort((a, b) => a.index - b.index || b.end - a.end);
	const kept: Hit[] = [];
	for (const hit of all) if (hit.index >= (kept.at(-1)?.end ?? 0)) kept.push(hit);
	return kept;
}

/** Step names in a shell command, in order: `cargo check && pnpm test` → check, web test. */
export const stepsOf = (m: BuildMatcher, command: string) => hits(m, command).map(h => h.step);

export const isBuild = (m: BuildMatcher, command: string) => hits(m, command).length > 0;

/** The build command a shell command runs first, e.g. `cargo auto`. */
export const buildCommand = (m: BuildMatcher, command: string) => hits(m, command)[0]?.rule.command ?? null;

// Script runtimes show the script path in argv: `node …/pnpm.cjs test`.
const program = (arg: string) => basename(arg).replace(/\.[cm]?js$/, '');

/** The step a process runs, when its argv is a build's process (`cargo-auto auto test` → test). */
export function processStep(m: BuildMatcher, argv: string[]): string | null {
	for (const r of m.rules) {
		for (const [first, ...rest] of r.process) {
			for (let i = 0; i < argv.length; i++) {
				if (program(argv[i]) !== first || !rest.every((w, j) => argv[i + 1 + j] === w)) continue;
				const step = argv.slice(i + 1 + rest.length).find(a => !a.startsWith('+') && !a.startsWith('-'));
				if (step && allowed(r, step)) return stepName(r, step);
			}
		}
	}
	return null;
}

/**
 * Directory a bash call builds in: the tool's `cwd` argument, then a `cd <dir> &&` before the
 * first build command, both relative to the session directory.
 */
export function buildDir(m: BuildMatcher, command: string, sessionCwd: string, toolCwd?: string): string {
	const base = toolCwd ? resolve(sessionCwd, toolCwd) : sessionCwd;
	const first = hits(m, command)[0];
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
		// A chain's running step counts from when its own process started.
		const start = state === 'running' ? (run.timings?.[name]?.start ?? run.start) : run.start;
		if (state) out.push({ name, state, who: run.who, kind: run.kind, start, end: run.end });
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
	/** How long a step usually takes when it passes; null with no history. */
	usual(step: string): number | null;
}

/** The latest outcome per step and checkout, ordered by when each first appeared. */
export function mergeSteps(runs: Run[], { mainRoot, currentTree, fixers, maxSteps, usual }: MergeOptions): Step[] {
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
			latest.set(key, { ...outcome, where, root, stale, usual: usual(outcome.name) });
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
