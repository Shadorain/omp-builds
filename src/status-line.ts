import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { truncateToWidth } from '@oh-my-pi/pi-tui';
import type { DevPin, DevState, Step, StepState } from './types';

export type Theme = ExtensionContext['ui']['theme'];

const SPINNER = ['◐', '◓', '◑', '◒'];

export function clock(start: number, end?: number): string {
	const s = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

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
	return `${icon(theme, step.state, frame)} ${name}${busy ? theme.fg('muted', ` ${clock(step.start)}${who}`) : ''}`;
}

const DEV_TONE = {
	live: 'success',
	'edits not live': 'warning',
	rebuilding: 'warning',
	behind: 'warning',
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

/** One line: step chips, then the dev server and any server running from this checkout. */
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
	const parts = steps.length ? [steps.map(s => chip(theme, s, frame)).join(dot)] : [];
	if (pin) {
		const own = ownServers(pin, root).map(s => `${theme.fg('muted', `:${s.port}`)} ${theme.fg('success', '●')}`);
		parts.push([devChip(theme, pin), ...own].join(dot));
	}
	return [truncateToWidth(` ${parts.join(bar)}`, width)];
}
