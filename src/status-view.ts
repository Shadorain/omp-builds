import { basename } from 'node:path';
import { truncateToWidth } from '@oh-my-pi/pi-tui';
import { clock, devChip, span, type Theme } from './status-line';
import type { DevPin, DevServer, DevState, Run, RunState } from './types';

export interface StatusViewOptions {
	mainRoot: string | null;
	currentTree(root: string): string | null;
	pin: DevPin | null;
	frame: number;
	/** How long a step usually takes when it passes; null with no history. */
	usual(step: string): number | null;
}

const DEV_MEANING: Record<DevState, string> = {
	live: 'serving this checkout as it is now',
	'edits not live': 'serving your last commit; uncommitted edits are not on it',
	rebuilding: 'its redeploy is building your latest commit; it keeps serving the old build until then',
	behind: 'serving an older build of this checkout, and no redeploy is running',
	up: 'running; set deployedShaFile or servedCheckoutFile in /builds config to see what it serves',
	'not deployed': 'serving other code; this branch is not on it',
	unknown: 'cannot tell what it is serving',
};

function devRow(theme: Theme, pin: DevPin): string {
	const meaning = pin.up ? DEV_MEANING[pin.here] : 'server is not running';
	const url = pin.url ? `  ${theme.fg('accent', pin.url)}` : '';
	return `${devChip(theme, pin)}${url}  ${theme.fg('muted', meaning)}`;
}

function serverRow(theme: Theme, server: DevServer, mainRoot: string | null): string {
	const where = server.root === mainRoot ? 'this checkout' : server.root ? basename(server.root) : '?';
	const url = server.url ?? `port ${server.port}, not on the tailnet`;
	return `   ${theme.fg('success', '●')} ${server.unit}  ${theme.fg('accent', url)}  ${theme.fg('muted', `runs from ${where}`)}`;
}

/** The dev server, then every other server running from one of the project's checkouts, this one first. */
function devRows(theme: Theme, pin: DevPin, mainRoot: string | null): string[] {
	const extras = [...pin.extras].sort(
		(a, b) => Number(b.root === mainRoot) - Number(a.root === mainRoot) || a.port - b.port,
	);
	return ['', devRow(theme, pin), ...extras.map(s => serverRow(theme, s, mainRoot))];
}

const SPINNER = ['◐', '◓', '◑', '◒'];
const MAX_ROWS = 14;

function ago(ms: number): string {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	return `${Math.floor(s / 3600)}h ago`;
}

function badge(theme: Theme, state: RunState, frame: number): string {
	switch (state) {
		case 'running':
			return `${theme.fg('accent', SPINNER[frame % SPINNER.length])} running`;
		case 'completed':
			return `${theme.fg('success', '✓')} passed `;
		case 'failed':
			return `${theme.fg('error', '✗')} failed `;
		case 'cancelled':
			return `${theme.fg('muted', '■')} stopped`;
		case 'finished':
			return `${theme.fg('muted', '·')} ended  `;
	}
}

const cell = (text: string, width: number) => truncateToWidth(text, width, undefined, true);

/** A running run's time so far over its steps' usual total, once every step has passed before. */
function took(run: Run, usual: (step: string) => number | null): string {
	if (run.state !== 'running') return clock(run.start, run.end);
	const times = run.steps.map(usual);
	if (times.some(t => t === null)) return clock(run.start);
	return `${clock(run.start)}/~${span(times.reduce<number>((a, t) => a + (t ?? 0), 0))}`;
}

/** Every tracked run, running first, then newest first: one row each. The dev server sits at the bottom. */
export function statusView(theme: Theme, width: number, runs: Run[], options: StatusViewOptions): string[] {
	const { mainRoot, currentTree, pin, frame, usual } = options;
	const dev = pin ? devRows(theme, pin, mainRoot) : [];
	if (!runs.length) {
		return [theme.fg('muted', 'No builds tracked in this session yet.'), ...dev].map(l => truncateToWidth(l, width));
	}
	const running = runs.filter(r => r.state === 'running');
	const agents = new Set(running.map(r => `${r.kind}:${r.who}`)).size;
	const checkouts = new Set(runs.map(r => r.root ?? mainRoot)).size;
	const header = theme.fg(
		'muted',
		`${running.length} running · ${agents} agent${agents === 1 ? '' : 's'} building · ${checkouts} checkout${checkouts === 1 ? '' : 's'}`,
	);
	const columns = theme.fg(
		'muted',
		`${cell('state', 9)}  ${cell('steps', 22)}  ${cell('who', 10)}  ${cell('checkout', 16)}  ${cell('took', 10)}  ${cell('started', 8)}  code`,
	);
	const rank = (r: Run) => (r.state === 'running' ? 0 : 1);
	const sorted = [...runs].sort((a, b) => rank(a) - rank(b) || b.start - a.start).slice(0, MAX_ROWS);
	const rows = sorted.map(run => {
		const root = run.root ?? mainRoot;
		const steps =
			run.steps.length > 1 && run.live && run.state !== 'completed'
				? run.steps.map(s => (s === run.live ? `[${s}]` : s)).join(' → ')
				: run.steps.join(' → ');
		const current = root ? currentTree(root) : null;
		const code =
			run.kind === 'other' && !run.tree
				? theme.fg('muted', 'other pane')
				: !run.tree || !current
					? ''
					: run.tree === current
						? theme.fg('success', 'current')
						: theme.fg('warning', 'changed since');
		return [
			cell(badge(theme, run.state, frame), 9),
			cell(steps, 22),
			theme.fg(run.kind === 'sub' ? 'accent' : 'text', cell(run.who, 10)),
			theme.fg(root === mainRoot ? 'muted' : 'text', cell(root ? basename(root) : '?', 16)),
			cell(took(run, usual), 10),
			theme.fg('muted', cell(ago(run.start), 8)),
			code,
		].join('  ');
	});
	return [header, '', columns, ...rows, ...dev].map(line => truncateToWidth(line, width));
}
