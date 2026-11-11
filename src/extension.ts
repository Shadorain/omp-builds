import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { buildsFor, type Config, DEFAULT_CONFIG, loadConfig } from './config';
import { type ArgNode, completeArgs } from './completions';
import { CONFIG_ARGS, configCommand } from './config-command';
import { treeStamp } from './git';
import { scanBuilds } from './procs';
import { checkoutRoot, projectFor, projectKey } from './projects';
import { statusLine } from './status-line';
import { statusView } from './status-view';
import {
	type BuildMatcher,
	buildCommand,
	buildDir,
	buildMatcher,
	isBuild,
	mergeSteps,
	stepsOf,
	withPipefail,
} from './steps';
import { answeredUser, finalReply, openSummary, pickSummary } from './summary';
import { historyPath, StepHistory } from './history';
import { formatState, loadState, saveState } from './state';
import { BuildTracker, settleForeground, startForeground } from './tracker';
import type { Build, DevPin, Foreground, Project, Run, Step, Summary } from './types';
import { closeWindow, openWindow, windowOpen } from './window';

const WIDGET = 'omp-builds';
// Tools that change files: a turn that used one, here or in a subagent, ends with a summary window.
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };
const EDITS_KEY = Symbol.for('omp-builds.edits');
// Subagents run their own instance of this extension in this process; their edits count too.
const edits = ((globalThis as Record<symbol, unknown>)[EDITS_KEY] ??= new Map()) as Map<string, number>;
const FRAME_MS = 1_000;
const SCAN_BUSY_MS = 3_000;
const SCAN_IDLE_MS = 5_000;
const SLOW_BUSY_MS = 5_000;
const SLOW_IDLE_MS = 30_000;
const MAX_STEPS = 6;
const MAX_STAMPED_ROOTS = 6;
// Edits issued in the same turn as a build run alongside its tool_call hook; stamping a beat
// later records the tree the build actually reads.
const STAMP_DELAY_MS = 750;

const USAGE = 'Usage: /builds status | /builds summary [last] | /builds clear | /builds config';
const NOT_HERE = 'omp-builds is not enabled in this repository. /builds config add turns it on here.';

const BUILDS_ARGS: ArgNode[] = [
	{ word: 'status', description: 'Every tracked build, with who, where and how long' },
	{
		word: 'summary',
		description: 'Pick a work summary to show',
		next: [{ word: 'last', description: 'Show the latest work summary' }],
	},
	{ word: 'clear', description: 'Clear finished builds' },
	CONFIG_ARGS,
];

// Compiled once per config and project; a changed file is a new config object.
const matchers = new WeakMap<Config, Map<string | null, BuildMatcher>>();
function matcherFor(config: Config, projectName: string | null): BuildMatcher {
	let byProject = matchers.get(config);
	if (!byProject) matchers.set(config, (byProject = new Map()));
	let m = byProject.get(projectName);
	if (!m) byProject.set(projectName, (m = buildMatcher(buildsFor(config, projectName))));
	return m;
}

// Fixers, mission workers and other SDK sessions keep foreground builds and show nothing.
const isMain = (ctx: ExtensionContext) => ctx.hasUI === true && ctx.mode === 'tui' && ctx.agent?.kind !== 'sub';

export default function ompBuilds(pi: ExtensionAPI): void {
	let loadedFor: Config | null = null;
	let warnedIssues = '';
	const tracker = new BuildTracker(buildMatcher(DEFAULT_CONFIG.builds));
	let ctxRef: ExtensionContext | null = null;
	let project: Project | null = null;
	let pin: DevPin | null = null;
	// Current working-tree stamp of each checkout runs built in, the session's own first.
	let trees = new Map<string, string | null>();
	let runs: Run[] = [];
	let steps: Step[] = [];
	// This session's summaries, saved with its builds, so a resumed session still has them.
	let summaries: Summary[] = [];
	// Session whose saved state is loaded; nothing is saved while another one is loading.
	let stateSession: string | null = null;
	let savedText = '';
	let saving: Promise<void> | null = null;
	// Pass times of this project's steps, for how long a running one usually takes.
	let history = new StepHistory(null);
	let savingHistory: Promise<void> | null = null;
	const usual = (step: string) => history.usual(step);
	let editsSeen = 0;
	let shownSummary: Summary | null = null;
	let frame = 0;
	let lastScan = 0;
	let lastSlow = 0;
	let scanning = false;
	let refreshing = false;
	let timer: unknown = null;
	let lineShown = false;
	let requestRender: (() => void) | null = null;

	/** The main session's context while it sits in a supported project. */
	const live = () => (ctxRef && project && isMain(ctxRef) ? ctxRef : null);
	const currentTree = (root: string) => trees.get(root) ?? null;

	function render(): void {
		const ctx = live();
		if (!ctx) return;
		const snapshot = ctx.getAsyncJobSnapshot?.();
		runs = tracker.runs(snapshot);
		for (const run of runs) history.record(run);
		steps = mergeSteps(runs, {
			mainRoot: project?.root ?? null,
			currentTree,
			fixers: tracker.fixers(snapshot),
			maxSteps: MAX_STEPS,
			usual,
		});
		const want = steps.length > 0;
		if (want !== lineShown) {
			lineShown = want;
			requestRender = null;
			ctx.ui.setWidget(
				WIDGET,
				want
					? (tui, theme) => {
							requestRender = () => tui.requestRender();
							return {
								render: (width: number) => statusLine(theme, width, steps, pin, project?.root ?? null, frame),
								invalidate() {},
							};
						}
					: undefined,
				{ placement: 'belowEditor' },
			);
		}
		requestRender?.();
		persist(ctx);
	}

	/** Saves this session's state and new step times when they changed; a change during a write is saved on a later frame. */
	function persist(ctx: ExtensionContext): void {
		if (history.dirty && !savingHistory) {
			savingHistory = history
				.save()
				.catch(() => {})
				.finally(() => {
					savingHistory = null;
				});
		}
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== stateSession) return;
		const text = formatState({ runs, summaries });
		if (text === savedText || saving) return;
		savedText = text;
		saving = saveState(sessionId, text)
			.catch(() => {
				savedText = '';
			})
			.finally(() => {
				saving = null;
			});
	}

	/** Builds in this project's checkouts (any worktree), each with its checkout root. */
	async function inProject(found: Build[]): Promise<Build[]> {
		const resolved = await Promise.all(
			found.map(async b => {
				if (!b.cwd) return null;
				const mine = b.owner === process.pid;
				if (!mine && (await projectKey(b.cwd)) !== project?.key) return null;
				return { ...b, root: await checkoutRoot(b.cwd) };
			}),
		);
		return resolved.filter(b => b !== null);
	}

	async function refreshSlow(ctx: ExtensionContext): Promise<void> {
		// A config saved by another session applies here too.
		if ((await loadConfig()).config !== loadedFor) return restore(ctx);
		const roots = [project?.root, ...runs.map(r => r.root)].filter((r): r is string => !!r);
		const unique = [...new Set(roots)].slice(0, MAX_STAMPED_ROOTS);
		const [stamps, devPin] = await Promise.all([
			Promise.all(unique.map(async root => [root, await treeStamp(root)] as const)),
			project?.devPin() ?? null,
		]);
		if (ctx !== ctxRef) return;
		trees = new Map(stamps);
		pin = devPin;
		// Other sessions' passes of the same steps count too.
		await history.load();
	}

	function tick(): void {
		const ctx = live();
		if (!ctx) return;
		frame++;
		const busy = tracker.builds.length > 0 || steps.some(s => s.state === 'running' || s.state === 'fixing');
		const now = Date.now();
		if (!scanning && now - lastScan >= (busy ? SCAN_BUSY_MS : SCAN_IDLE_MS)) {
			scanning = true;
			lastScan = now;
			void scanBuilds(tracker.matcher)
				.then(inProject)
				.then(found => tracker.setBuilds(found))
				.finally(() => {
					scanning = false;
					render();
				});
		}
		if (!refreshing && now - lastSlow >= (busy ? SLOW_BUSY_MS : SLOW_IDLE_MS)) {
			refreshing = true;
			lastSlow = now;
			void refreshSlow(ctx).finally(() => {
				refreshing = false;
				render();
			});
		}
		render();
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		ctxRef = ctx;
		const loaded = await loadConfig();
		loadedFor = loaded.config;
		const issues = loaded.issues.join('\n');
		if (issues && issues !== warnedIssues && ctx.hasUI) {
			ctx.ui.notify(`omp-builds config not loaded; run /builds config edit.\n${issues}`, 'error');
		}
		warnedIssues = issues;
		project = await projectFor(ctx.cwd);
		tracker.matcher = matcherFor(loaded.config, project?.name ?? null);
		const path = project ? historyPath(project.name) : null;
		if (path !== history.path) {
			void history.save().catch(() => {});
			history = new StepHistory(path);
			await history.load();
			if (ctx !== ctxRef) return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== stateSession) {
			stateSession = null;
			const saved = live() ? await loadState(sessionId) : null;
			if (ctx !== ctxRef) return;
			stateSession = sessionId;
			summaries = saved?.summaries ?? [];
			shownSummary = null;
			tracker.reset(saved?.runs ?? []);
			savedText = saved ? formatState(saved) : formatState({ runs: [], summaries: [] });
		} else {
			// Same session, rebuilt (a branch or a changed config): finished results stay.
			tracker.reset(runs.filter(r => r.kind !== 'other' && r.state !== 'running'));
		}
		editsSeen = project ? (edits.get(project.key) ?? 0) : 0;
		closeWindow();
		if (lineShown) ctx.ui.setWidget(WIDGET, undefined);
		lineShown = false;
		pin = null;
		trees = new Map();
		if (!live()) return;
		timer ??= ctx.setInterval(tick, FRAME_MS);
		lastScan = 0;
		lastSlow = 0;
		tick();
	}

	pi.on('session_start', async (_event, ctx) => restore(ctx));
	pi.on('session_switch', async (_event, ctx) => restore(ctx));
	pi.on('session_branch', async (_event, ctx) => restore(ctx));
	pi.on('session_tree', async (_event, ctx) => restore(ctx));

	pi.on('tool_call', async (event, ctx) => {
		if (EDIT_TOOLS[event.toolName]) {
			const touched = await projectFor(ctx.cwd);
			if (touched) edits.set(touched.key, (edits.get(touched.key) ?? 0) + 1);
			return;
		}
		if (event.toolName !== 'bash') return;
		const input = event.input ?? {};
		const command = typeof input.command === 'string' ? input.command : '';
		const here = await projectFor(ctx.cwd);
		if (!here) return;
		const matcher = matcherFor((await loadConfig()).config, here.name);
		if (!isBuild(matcher, command)) return;
		const sub = ctx.agent?.kind === 'sub';
		if (!sub && !isMain(ctx)) return;
		const toolCwd = typeof input.cwd === 'string' ? input.cwd : undefined;
		const stampRoot = await checkoutRoot(buildDir(matcher, command, ctx.cwd, toolCwd));
		const tree = Bun.sleep(STAMP_DELAY_MS).then(() => (stampRoot ? treeStamp(stampRoot) : null));
		const piped = { ...input, command: withPipefail(command) };
		if (sub || input.async === false) {
			const run: Foreground = {
				id: event.toolCallId,
				command,
				steps: stepsOf(matcher, command),
				live: null,
				state: 'running',
				who: sub ? (ctx.agent?.id ?? ctx.agent?.name ?? 'fixer') : 'main',
				kind: sub ? 'sub' : 'main',
				start: Date.now(),
				root: stampRoot,
				tree: null,
				stampRoot,
				missing: 0,
			};
			startForeground(run);
			void tree.then(t => {
				// A process seen in another checkout restamps the run; keep that stamp.
				if (run.stampRoot === stampRoot) run.tree = t;
			});
			return piped.command === command ? undefined : { input: piped };
		}
		tracker.expect(command, stampRoot, tree);
		lastScan = 0;
		const nudge = [
			`omp-builds: this ${buildCommand(matcher, command)} runs in the background; the user's status line shows its progress and result.`,
			"Do not wait or poll. Continue with the user's request or end your turn; the result arrives on its own.",
			'If it fails, spawn one task subagent as the fixer in this checkout with the failing command; do not read the full log here.',
			'Do not wait on the fixer: end your turn so the user can keep talking; its yield arrives on its own. Report its short yield then.',
		].join(' ');
		return { input: { ...piped, async: true, timeout: 0 }, additionalContext: nudge };
	});

	pi.on('tool_result', async event => {
		const code = (event.details as { exitCode?: unknown } | undefined)?.exitCode;
		settleForeground(event.toolCallId, event.isError || (typeof code === 'number' && code !== 0));
	});

	// Shows a summary and remembers it, so the status window can hand the screen back to it.
	function showSummary(ctx: ExtensionContext, summary: Summary): void {
		shownSummary = summary;
		openSummary(ctx, summary);
	}

	// The agent's own final reply, after a turn that changed code. It opens as a window only when
	// background jobs are still running: their results will push the reply off screen. With nothing
	// pending the reply stays where it is, so it is only saved for /builds summary. While a summary
	// is still up, a turn the agent ran on its own (a finished build or fixer reporting in) replaces
	// it, or closes it when nothing follows, so the window never goes stale; a turn the user started
	// without edits leaves it alone. Pops up once the agent stops, so it never lands mid-reply.
	pi.on('agent_end', async (event, eventCtx) => {
		const ctx = live();
		if (!ctx || !project) return;
		const count = edits.get(project.key) ?? 0;
		if (count === editsSeen && (answeredUser(event.messages) || !windowOpen('summary'))) return;
		const text = finalReply(event.messages);
		if (!text) return;
		editsSeen = count;
		const summary: Summary = { text, at: new Date().toISOString() };
		summaries.push(summary);
		const pending = (eventCtx.getAsyncJobSnapshot?.()?.running.length ?? 0) > 0;
		if (pending) return showSummary(ctx, summary);
		shownSummary = null;
		if (windowOpen('summary')) closeWindow();
	});

	pi.registerCommand('builds', {
		description: 'Builds for this project: status | summary [last] | clear | config',
		getArgumentCompletions: prefix => completeArgs(BUILDS_ARGS, prefix),
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const [verb, arg] = words;
			if (verb === 'config') {
				const here = (await projectFor(ctx.cwd))?.name ?? null;
				return configCommand(ctx, words.slice(1), here, () => restore(ctx));
			}
			if (!(await projectFor(ctx.cwd))) return ctx.ui.notify(NOT_HERE, 'info');
			if (verb === 'clear' && !arg) {
				tracker.clear();
				return render();
			}
			if (verb === 'status' && !arg) {
				const mainRoot = project?.root ?? null;
				// The summary is sticky: Esc on the status window brings it back.
				const under = windowOpen('summary') ? shownSummary : null;
				return openWindow(
					ctx,
					'status',
					`Builds · ${project?.name ?? ''}`,
					(theme, width) => statusView(theme, width, runs, { mainRoot, currentTree, pin, frame, usual }),
					under ? () => showSummary(ctx, under) : undefined,
				);
			}
			if (verb !== 'summary' || (arg && arg !== 'last')) return ctx.ui.notify(USAGE, 'info');
			if (!summaries.length) return ctx.ui.notify('No work summaries in this session yet.', 'info');
			const summary = arg === 'last' ? (summaries.at(-1) as Summary) : await pickSummary(ctx, summaries);
			if (summary) showSummary(ctx, summary);
		},
	});
}
