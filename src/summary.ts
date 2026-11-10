import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { wrapTextWithAnsi } from '@oh-my-pi/pi-tui';
import type { Summary } from './types';
import { openWindow } from './window';

export const SUMMARY_ENTRY = 'omp-builds.summary';

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

/** Show `summary` in the temporary window until Esc. */
export function openSummary(ctx: ExtensionContext, summary: Summary): void {
	openWindow(ctx, `Work summary · ${when(summary.at)}`, (_theme, width) =>
		summary.text.split('\n').flatMap(line => wrapTextWithAnsi(line.trimEnd(), width)),
	);
}

/** Pick one summary from a list, newest first, and open it. */
export async function pickSummary(ctx: ExtensionContext, summaries: Summary[]): Promise<void> {
	const newest = [...summaries].reverse();
	const labels = newest.map((s, i) => `${i + 1}. ${when(s.at)}  ${s.text.split('\n')[0]}`);
	const picked = await ctx.ui.select('Work summaries', labels);
	const index = picked === undefined ? -1 : labels.indexOf(picked);
	if (index >= 0) openSummary(ctx, newest[index]);
}
