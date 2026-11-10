import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@oh-my-pi/pi-tui';
import type { Theme } from './status-line';
import type { Summary } from './types';

export const SUMMARY_ENTRY = 'omp-builds.summary';
const WINDOW = 'omp-builds-summary';
const MAX_WIDTH = 100;

/** Work summaries saved on this branch, oldest first. */
export function readSummaries(branch: unknown[]): Summary[] {
	const out: Summary[] = [];
	for (const entry of branch) {
		if (!entry || typeof entry !== 'object' || !('customType' in entry) || entry.customType !== SUMMARY_ENTRY) continue;
		const data = 'data' in entry ? entry.data : null;
		if (data && typeof data === 'object' && 'text' in data && 'at' in data) {
			if (typeof data.text === 'string' && typeof data.at === 'string') out.push({ text: data.text, at: data.at });
		}
	}
	return out;
}

const when = (at: string) =>
	new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** A window over the transcript, like `/btw`'s. Esc closes it; typing keeps going to the prompt. */
class SummaryWindow {
	constructor(
		private readonly theme: Theme,
		private readonly summary: Summary,
	) {}

	render(width: number): string[] {
		const { theme } = this;
		const w = Math.min(width, MAX_WIDTH);
		if (w < 20) return [];
		const inner = w - 4;
		const border = (s: string) => theme.fg('borderAccent', s);
		const title = ` ${theme.bold('Work summary')} `;
		const stamp = ` ${theme.fg('muted', when(this.summary.at))} `;
		const top = `${border('╭─')}${title}${border('─'.repeat(Math.max(1, w - 4 - visibleWidth(title) - visibleWidth(stamp))))}${stamp}${border('─╮')}`;
		const row = (text: string) => `${border('│')} ${truncateToWidth(text, inner, undefined, true)} ${border('│')}`;
		const body = this.summary.text.split('\n').flatMap(line => wrapTextWithAnsi(line.trimEnd(), inner));
		return [
			top,
			...body.map(row),
			row(''),
			row(theme.fg('muted', 'esc close · /builds summary to browse')),
			border(`╰${'─'.repeat(w - 2)}╯`),
		];
	}

	invalidate(): void {}
}

// One window at a time: opening another closes the current one.
let closeOpen: (() => void) | null = null;

/**
 * Show `summary` above the editor, where `/btw` draws its panel, until Esc or `autoCloseMs`.
 * It sits in the layout instead of an overlay so it never covers the editor, and it takes no
 * focus, so typing keeps going to the prompt; Esc is caught from raw terminal input.
 */
export function openSummary(ctx: ExtensionContext, summary: Summary, autoCloseMs?: number): void {
	closeOpen?.();
	const stopListening = ctx.ui.onTerminalInput(data => {
		if (!matchesKey(data, 'escape')) return undefined;
		close();
		return { consume: true };
	});
	const timer = autoCloseMs ? setTimeout(() => close(), autoCloseMs) : undefined;
	const close = () => {
		clearTimeout(timer);
		stopListening();
		if (closeOpen === close) closeOpen = null;
		ctx.ui.setWidget(WINDOW, undefined);
	};
	closeOpen = close;
	ctx.ui.setWidget(WINDOW, (_tui, theme) => new SummaryWindow(theme, summary), { placement: 'aboveEditor' });
}

/** Pick one summary from a list, newest first, and open it. */
export async function pickSummary(ctx: ExtensionContext, summaries: Summary[]): Promise<void> {
	const newest = [...summaries].reverse();
	const labels = newest.map((s, i) => `${i + 1}. ${when(s.at)}  ${s.text.split('\n')[0]}`);
	const picked = await ctx.ui.select('Work summaries', labels);
	const index = picked === undefined ? -1 : labels.indexOf(picked);
	if (index >= 0) openSummary(ctx, newest[index]);
}
