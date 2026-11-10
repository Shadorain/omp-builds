import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { Markdown } from '@oh-my-pi/pi-tui';
import { getMarkdownTheme } from '@oh-my-pi/pi-tui/theme';
import type { Summary } from './types';
import { openWindow } from './window';

export const SUMMARY_ENTRY = 'omp-builds.summary';

// Leaves room for the editor and status lines below the window.
const RESERVED_ROWS = 14;
const MIN_ROWS = 6;

/** Work summaries among `entries`, in file order (oldest first). */
export function readSummaries(entries: unknown[]): Summary[] {
	const out: Summary[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object' || !('customType' in entry) || entry.customType !== SUMMARY_ENTRY) continue;
		const data = 'data' in entry ? entry.data : null;
		if (data && typeof data === 'object' && 'text' in data && 'at' in data) {
			if (typeof data.text === 'string' && typeof data.at === 'string') out.push({ text: data.text, at: data.at });
		}
	}
	return out;
}

/** Text of the last assistant message in `messages` that has any, or null. */
export function finalReply(messages: readonly unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown };
		if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
		const text = m.content
			.filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
			.map(c => c.text)
			.join('\n')
			.trim();
		if (text) return text;
	}
	return null;
}

/** Whether the newest input the agent answered was the user's, not a job result or other injected message. */
export function answeredUser(messages: readonly unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const role = m && typeof m === 'object' && 'role' in m ? m.role : null;
		if (role === 'assistant' || role === 'toolResult') continue;
		return role === 'user';
	}
	return false;
}

const when = (at: string) =>
	new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Show `summary` as markdown in the temporary window until Esc. */
export function openSummary(ctx: ExtensionContext, summary: Summary): void {
	const body = new Markdown(summary.text, 0, 0, getMarkdownTheme());
	openWindow(ctx, 'summary', `Work summary · ${when(summary.at)}`, (theme, width) => {
		const lines = body.render(width);
		const max = Math.max(MIN_ROWS, (process.stdout.rows ?? 40) - RESERVED_ROWS);
		if (lines.length <= max) return lines;
		const more = lines.length - max + 1;
		return [...lines.slice(0, max - 1), theme.fg('muted', `… ${more} more lines in the reply above`)];
	});
}

/** Pick one summary from a list, newest first. */
export async function pickSummary(ctx: ExtensionContext, summaries: Summary[]): Promise<Summary | null> {
	const newest = [...summaries].reverse();
	const labels = newest.map((s, i) => `${i + 1}. ${when(s.at)}  ${s.text.split('\n')[0]}`);
	const picked = await ctx.ui.select('Work summaries', labels);
	const index = picked === undefined ? -1 : labels.indexOf(picked);
	return index >= 0 ? newest[index] : null;
}
