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
	/** Checkout (worktree) root the build runs in. */
	root: string | null;
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
	id: string;
	command: string;
	steps: string[];
	/** The step whose process was last seen running. */
	live: string | null;
	state: RunState;
	who: string;
	kind: RunKind;
	start: number;
	end?: number;
	/** Checkout root the run built; null until its process is seen, meaning the session's own. */
	root: string | null;
	/** Working-tree stamp the run built. */
	tree: string | null;
}

/** The latest outcome of one step in one checkout, as the status line shows it. */
export interface Step {
	name: string;
	/** Worktree label when the step ran outside the session's own checkout. */
	where: string | null;
	root: string | null;
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
	/** Checkout `tree` was stamped from; restamped once the process shows it built elsewhere. */
	stampRoot: string | null;
	/** Scans in a row that found no process for this run. */
	missing: number;
}

/** Someone working on a failure: a subagent build or a running task job. */
export interface Fixer {
	who: string;
	start: number;
	/** Checkout it works in; null when unknown (a task job), which matches any failure. */
	root: string | null;
}

export interface Summary {
	text: string;
	at: string;
}
