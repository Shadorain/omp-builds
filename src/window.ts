import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { matchesKey } from '@oh-my-pi/pi-tui';
import { OverlayPanel } from '@oh-my-pi/pi-tui/chrome';
import type { Theme } from './status-line';

const WIDGET = 'omp-builds-window';

/** Draws the window's rows at a content width; called on every repaint, so it can show live data. */
export type WindowBody = (theme: Theme, width: number) => readonly string[];

export type WindowKind = 'summary' | 'status' | 'config';

// One window at a time: opening another replaces the current one.
let closeOpen: (() => void) | null = null;
let openKind: WindowKind | null = null;

export const windowOpen = (kind: WindowKind) => openKind === kind;

/**
 * A temporary window above the editor, built the way `/btw` builds its panel: an `OverlayPanel`
 * mounted in the layout instead of over it, so it never covers the editor. It takes no focus,
 * so typing keeps going to the prompt; Esc, caught from raw terminal input, closes it.
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
		if (!matchesKey(data, 'escape')) return undefined;
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
		(_tui, theme) => {
			const panel = new OverlayPanel(title, 'omp.overlay.omp-builds');
			panel.addChild({
				render: (width: number) => [...body(theme, width), '', theme.fg('muted', 'esc close')],
				invalidate() {},
			});
			return panel;
		},
		{ placement: 'aboveEditor' },
	);
}

export function closeWindow(): void {
	closeOpen?.();
}
