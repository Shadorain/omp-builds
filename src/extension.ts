import { type ExtensionAPI, type ExtensionContext, z } from '@oh-my-pi/pi-coding-agent';
import { treeStamp } from './git';
import { scanBuilds } from './procs';
import { projectFor, projectKey } from './projects';
import { statusLine } from './status-line';
import { CARGO_AUTO, stepsOf } from './steps';
import { openSummary, pickSummary, readSummaries, SUMMARY_ENTRY } from './summary';
import { BuildTracker, settleForeground, startForeground } from './tracker';
import type { Build, DevPin, Project, Step, Summary } from './types';

const WIDGET = 'omp-builds';
const TOOL = 'work_summary';
const FRAME_MS = 1_000;
const SCAN_BUSY_MS = 3_000;
const SCAN_IDLE_MS = 5_000;
const SLOW_BUSY_MS = 5_000;
const SLOW_IDLE_MS = 30_000;
const SUMMARY_POPUP_MS = 60_000;
// Edits issued in the same turn as a build run alongside its tool_call hook; stamping a beat
// later records the tree cargo-auto actually syncs.
const STAMP_DELAY_MS = 750;

const USAGE = 'Usage: /builds summary [last] | /builds clear';

// Fixers, mission workers and other SDK sessions keep foreground builds and show nothing.
const isMain = (ctx: ExtensionContext) => ctx.hasUI === true && ctx.mode === 'tui' && ctx.agent?.kind !== 'sub';

export default function ompBuilds(pi: ExtensionAPI): void {
	const tracker = new BuildTracker();
	let ctxRef: ExtensionContext | null = null;
	let project: Project | null = null;
	let pin: DevPin | null = null;
	let currentTree: string | null = null;
	let steps: Step[] = [];
	let summaries: Summary[] = [];
	let summaryUnseen = false;
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

	function render(): void {
		const ctx = live();
		if (!ctx) return;
		steps = tracker.steps(ctx.getAsyncJobSnapshot?.(), currentTree);
		const want = steps.length > 0;
		if (want !== lineShown) {
			lineShown = want;
			requestRender = null;
			ctx.ui.setWidget(
				WIDGET,
				want
					? (tui, theme) => {
							requestRender = () => tui.requestRender();
							return { render: (width: number) => statusLine(theme, width, steps, pin, frame), invalidate() {} };
						}
					: undefined,
				{ placement: 'belowEditor' },
			);
		}
		requestRender?.();
	}

	async function inProject(found: Build[]): Promise<Build[]> {
		const keep = await Promise.all(
			found.map(async b => b.owner === process.pid || (!!b.cwd && (await projectKey(b.cwd)) === project?.key)),
		);
		return found.filter((_, i) => keep[i]);
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
			void scanBuilds()
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
			void Promise.all([treeStamp(ctx.cwd), project?.devPin() ?? null])
				.then(([tree, devPin]) => {
					currentTree = tree;
					pin = devPin;
				})
				.finally(() => {
					refreshing = false;
					render();
				});
		}
		render();
	}

	// Only touch the tool set on a real change: rewriting it would invalidate the prompt cache.
	async function setToolActive(on: boolean): Promise<void> {
		const tools = pi.getActiveTools();
		if (tools.includes(TOOL) === on) return;
		await pi.setActiveTools(on ? [...tools, TOOL] : tools.filter(name => name !== TOOL));
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		ctxRef = ctx;
		project = await projectFor(ctx.cwd);
		summaries = readSummaries(ctx.sessionManager.getBranch() as unknown[]);
		summaryUnseen = false;
		tracker.reset();
		if (lineShown) ctx.ui.setWidget(WIDGET, undefined);
		lineShown = false;
		pin = null;
		currentTree = null;
		await setToolActive(project !== null && isMain(ctx));
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
		if (event.toolName !== 'bash') return;
		const input = event.input ?? {};
		const command = typeof input.command === 'string' ? input.command : '';
		if (!CARGO_AUTO.test(command) || !(await projectFor(ctx.cwd))) return;
		const sub = ctx.agent?.kind === 'sub';
		if (!sub && !isMain(ctx)) return;
		const tree = Bun.sleep(STAMP_DELAY_MS).then(() => treeStamp(ctx.cwd));
		if (sub || input.async === false) {
			const run = {
				steps: stepsOf(command),
				live: null,
				state: 'running' as const,
				who: sub ? (ctx.agent?.id ?? ctx.agent?.name ?? 'fixer') : 'main',
				kind: sub ? ('sub' as const) : ('main' as const),
				start: Date.now(),
				tree: null as string | null,
				missing: 0,
			};
			startForeground(event.toolCallId, run);
			void tree.then(t => {
				run.tree = t;
			});
			return;
		}
		tracker.expect(command, tree);
		lastScan = 0;
		const nudge = [
			"omp-builds: this cargo auto runs in the background; the user's status line shows its progress and result.",
			"Do not wait or poll. Continue with the user's request or end your turn; the result arrives on its own.",
			'If it fails, spawn one task subagent as the fixer in this checkout with the failing command; do not read the full log here. Report its short yield.',
			`When the code work is done, call ${TOOL} with what you changed and why (no build or test status); call it again if a fixer changes code.`,
		].join(' ');
		return { input: { ...input, async: true, timeout: 0 }, additionalContext: nudge };
	});

	pi.on('tool_result', async event => {
		const code = (event.details as { exitCode?: unknown } | undefined)?.exitCode;
		settleForeground(event.toolCallId, event.isError || (typeof code === 'number' && code !== 0));
	});

	// Pops up once the agent stops, so it never covers a reply still streaming in.
	pi.on('agent_end', async () => {
		const ctx = live();
		const last = summaries.at(-1);
		if (!ctx || !summaryUnseen || !last) return;
		summaryUnseen = false;
		openSummary(ctx, last, SUMMARY_POPUP_MS);
	});

	const summarySchema = z.object({
		summary: z.string().min(1).describe('1-4 lines, plain text, no build/test status'),
	});
	// Inactive until restore() finds a supported project, so other repos never see it.
	pi.registerTool({
		name: TOOL,
		defaultInactive: true,
		label: 'Work Summary',
		description:
			'Show the user a short summary of the code work you did: what changed and why, 1-4 plain lines. Leave out build and test status; the status line shows that. Call once when the code work is done, and again if a fixer changes code.',
		parameters: summarySchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx?.agent?.kind === 'sub') {
				return {
					content: [{ type: 'text', text: 'Only the main agent posts work summaries. Put this in your yield.' }],
				};
			}
			const { summary: text } = params as z.infer<typeof summarySchema>;
			const summary = { text: text.trim(), at: new Date().toISOString() };
			summaries.push(summary);
			summaryUnseen = true;
			pi.appendEntry(SUMMARY_ENTRY, summary);
			return {
				content: [
					{ type: 'text', text: 'Shown to the user when this turn ends; they reopen it with /builds summary last.' },
				],
			};
		},
	});

	pi.registerCommand('builds', {
		description: 'Build status for this project: summary [last] | clear',
		getArgumentCompletions: prefix => {
			const items = [
				{ value: 'summary ', label: 'summary', description: 'Pick a work summary to show' },
				{ value: 'summary last', label: 'summary last', description: 'Show the latest work summary' },
				{ value: 'clear', label: 'clear', description: 'Clear finished builds from the status line' },
			].filter(item => item.value.startsWith(prefix.trimStart()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [verb, arg] = args.trim().split(/\s+/);
			if (!(await projectFor(ctx.cwd))) return ctx.ui.notify('omp-builds only runs in webapp and studio.', 'info');
			if (verb === 'clear' && !arg) {
				tracker.clear();
				return render();
			}
			if (verb !== 'summary' || (arg && arg !== 'last')) return ctx.ui.notify(USAGE, 'info');
			if (!summaries.length) return ctx.ui.notify('No work summaries in this session yet.', 'info');
			summaryUnseen = false;
			if (arg === 'last') openSummary(ctx, summaries.at(-1) as Summary);
			else await pickSummary(ctx, summaries);
		},
	});
}
