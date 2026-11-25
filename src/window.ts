import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { Theme } from './status-line';

const WIDGET = 'omp-builds-window';

/** Draws the window's rows at a content width; called on every repaint, so it can show live data. */
export type WindowBody = (
	ui: { requestRender(): void; size(): { readonly columns: number; readonly rows: number } },
	theme: Theme,
	width: number,
) => readonly string[];

export type WindowKind = 'summary' | 'status' | 'config';

// One window at a time: opening another replaces the current one.
let closeOpen: (() => void) | null = null;
let openKind: WindowKind | null = null;

export const windowOpen = (kind: WindowKind) => openKind === kind;

/**
 * A temporary window above the editor, implemented as a host widget so it never covers the editor.
 * It takes no focus, so typing keeps going to the prompt.
 */
export function openWindow(
	ctx: ExtensionContext,
	kind: WindowKind,
	title: string,
	body: WindowBody,
	onEscape?: () => void,
): void {
	closeOpen?.();
	const stopListening = ctx.ui.onTerminalInput(data => {
		if (data !== '\u001b') return undefined;
		close();
		onEscape?.();
		return { consume: true };
	});
	const close = () => {
		stopListening();
		if (closeOpen === close) {
			closeOpen = null;
			openKind = null;
		}
		ctx.ui.setWidget(WIDGET, undefined);
	};
	closeOpen = close;
	openKind = kind;
	ctx.ui.setWidget(
		WIDGET,
		(ui, theme) => ({
			render: (width: number) => [
				theme.fg('accent', title),
				...body(ui, theme, width),
				'',
				theme.fg('muted', 'esc close'),
			],
		}),
		{ placement: 'aboveEditor' },
	);
}

export function closeWindow(): void {
	closeOpen?.();
}
