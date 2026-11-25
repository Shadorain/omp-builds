import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { truncate, visibleWidth } from '@oh-my-pi/pi-tui/text/width';
import type { DevPin, DevState, Step, StepState } from './types';

export type Theme = ExtensionContext['ui']['theme'];

const SPINNER = ['◐', '◓', '◑', '◒'];

export const span = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const clock = (start: number, end?: number) => span((end ?? Date.now()) - start);

/** `1:10/~3:00`: time so far, over how long the step usually takes. */
export const progress = (start: number, usual: number | null) =>
	usual === null ? clock(start) : `${clock(start)}/~${span(usual)}`;

function icon(theme: Theme, state: StepState, frame: number): string {
	switch (state) {
		case 'running':
			return theme.fg('accent', SPINNER[frame % SPINNER.length]);
		case 'fixing':
			return theme.fg('warning', '⚒');
		case 'passed':
			return theme.fg('success', '✓');
		case 'failed':
			return theme.fg('error', '✗');
		case 'cancelled':
			return theme.fg('muted', '■');
	}
}

function chip(theme: Theme, step: Step, frame: number): string {
	const busy = step.state === 'running' || step.state === 'fixing';
	const label = step.where ? `${step.name}@${step.where}` : step.name;
	const name = step.stale ? theme.fg('muted', label) : label;
	const who = step.kind === 'main' ? '' : ` ${step.who}`;
	const time = step.state === 'running' ? progress(step.start, step.usual) : clock(step.start);
	return `${icon(theme, step.state, frame)} ${name}${busy ? theme.fg('muted', ` ${time}${who}`) : ''}`;
}

const DEV_TONE = {
	live: 'success',
	'edits not live': 'warning',
	rebuilding: 'warning',
	behind: 'warning',
	up: 'success',
	'not deployed': 'muted',
	unknown: 'muted',
} as const satisfies Record<DevState, string>;

/** `dev ● <state>`: the dot is green while the server runs; a down server shows red `down`. */
export function devChip(theme: Theme, pin: DevPin): string {
	const light = theme.fg(pin.up ? 'success' : 'error', '●');
	const clockText = pin.here === 'rebuilding' && pin.since ? ` ${clock(pin.since)}` : '';
	const here = pin.up ? theme.fg(DEV_TONE[pin.here], `${pin.here}${clockText}`) : theme.fg('error', 'down');
	return `${theme.fg('muted', 'dev')} ${light} ${here}`;
}

/** Servers started from this checkout, e.g. a preview: `:3001 ●`. */
export const ownServers = (pin: DevPin, root: string | null) =>
	pin.extras.filter(s => s.root !== null && s.root === root);

/**
 * One line: step chips, newest first, then the dev server and any server running from this checkout.
 * The servers always show; chips that do not fit are dropped from the end and counted as `+N`.
 */
export function statusLine(
	theme: Theme,
	width: number,
	steps: Step[],
	pin: DevPin | null,
	root: string | null,
	frame: number,
): string[] {
	const dot = theme.fg('muted', ' • ');
	const bar = theme.fg('muted', '  │  ');
	const servers = pin
		? [
				devChip(theme, pin),
				...ownServers(pin, root).map(s => `${theme.fg('muted', `:${s.port}`)} ${theme.fg('success', '●')}`),
			].join(dot)
		: '';
	const tail = servers ? `${bar}${servers}` : '';
	const room = width - 1 - visibleWidth(tail);
	const chips = steps.map(s => chip(theme, s, frame));
	let shown = chips.length;
	const fits = (n: number) => {
		const more = n < chips.length ? `${dot}${theme.fg('muted', `+${chips.length - n}`)}` : '';
		const line = n ? `${chips.slice(0, n).join(dot)}${more}` : more ? theme.fg('muted', `+${chips.length}`) : '';
		return visibleWidth(line) <= room ? line : null;
	};
	let line = fits(shown);
	while (line === null && shown > 0) line = fits(--shown);
	const head = line ?? '';
	return [truncate(` ${head}${head ? tail : servers}`, width)];
}
