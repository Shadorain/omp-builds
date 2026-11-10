import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { truncateToWidth } from '@oh-my-pi/pi-tui';
import type { DevPin, Step, StepState } from './types';

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

/** One line: step chips, then the dev server. */
export function statusLine(theme: Theme, width: number, steps: Step[], pin: DevPin | null, frame: number): string[] {
	const dot = theme.fg('muted', ' • ');
	const bar = theme.fg('muted', '  │  ');
	const parts = [steps.map(s => chip(theme, s, frame)).join(dot)];
	if (pin) {
		const light = theme.fg(pin.up ? 'success' : 'error', '●');
		const here = pin.up ? theme.fg(pin.tone, pin.here) : theme.fg('error', 'down');
		parts.push(`${theme.fg('muted', 'dev')} ${light} ${here}`);
	}
	return [truncateToWidth(` ${parts.join(bar)}`, width)];
}
