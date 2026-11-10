/** An async job as `ctx.getAsyncJobSnapshot()` reports it. */
export interface Job {
	id: string;
	type?: string;
	status: string;
	command?: string;
	label?: string;
	startTime?: number;
	endTime?: number;
}

/** A running `cargo-auto auto <step>` process found on this host. */
export interface Build {
	pid: number;
	step: string;
	start: number;
	/** Pid of the nearest `omp` ancestor: the session that started the build. */
	owner: number | null;
	cwd: string | null;
}

export interface DevPin {
	up: boolean;
	here: string;
	tone: 'success' | 'warning' | 'muted';
}

/** A supported project, resolved for one checkout. */
export interface Project {
	name: string;
	root: string;
	/** Absolute git common dir: shared by every worktree of the repo. */
	key: string;
	devPin(): Promise<DevPin | null>;
}

export type RunState = 'running' | 'completed' | 'failed' | 'cancelled' | 'finished';
export type StepState = 'running' | 'fixing' | 'passed' | 'failed' | 'cancelled';
export type RunKind = 'main' | 'sub' | 'other';

/** One `cargo auto` command; a chain (`check && test`) covers several steps. */
export interface Run {
	steps: string[];
	/** The step whose process was last seen running. */
	live: string | null;
	state: RunState;
	who: string;
	kind: RunKind;
	start: number;
	end?: number;
	/** Working-tree stamp the run built. */
	tree: string | null;
}

/** The latest outcome of one step name, as the status line shows it. */
export interface Step {
	name: string;
	state: StepState;
	who: string;
	kind: RunKind;
	start: number;
	end?: number;
	/** The code changed after this result was built. */
	stale: boolean;
}

/** A build that ran in the foreground: a subagent's, or the main agent's `async: false` escape hatch. */
export interface Foreground extends Run {
	kind: 'main' | 'sub';
	/** Scans in a row that found no process for this run. */
	missing: number;
}

/** Someone working on a failure: a subagent build or a running task job. */
export interface Fixer {
	who: string;
	start: number;
}

export interface Summary {
	text: string;
	at: string;
}
