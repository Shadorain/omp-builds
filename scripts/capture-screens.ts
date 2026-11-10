/**
 * Recapture the README screenshots from the real TUI.
 *
 *   bun run screens            # rewrite docs/screens/*.webp
 *   bun run screens --text     # print the captured screens as plain text instead
 *
 * Builds a throwaway Git repository (with a worktree) whose `cargo` is a stub that sleeps and fails
 * while `add()` subtracts, and runs a real `omp` on it inside a pseudo-terminal with this checkout's
 * extension, an isolated PI_CODING_AGENT_DIR and an empty HOME. The model is a scripted local
 * OpenAI-compatible server, so no credentials are used and every run plays the same conversation.
 * Two transient systemd user units stand in for a dev server and a PR preview; a stub `tailscale`
 * names the host `devbox.tailnet.ts.net`. The screens are read back through a headless xterm, cut
 * into panels, laid out as HTML in the colours the TUI emitted, and shot at 2x with headless Chromium.
 *
 * Needs `omp`, `git`, `python3`, systemd user units, the JetBrainsMono Nerd Font and Chromium or
 * Chrome (set CHROME to choose the binary).
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type IBufferCell, Terminal } from '@xterm/headless';
import puppeteer from 'puppeteer-core';

const REPO = resolve(import.meta.dir, '..');
const COLS = 110;
const ROWS = 40;
const KEY = { enter: '\r', escape: '\x1b' };
const UNITS = ['demo-dev', 'demo-preview-5174'];

// ---------------------------------------------------------------- fixture

const LIB_BUGGY = `pub fn greeting() -> &'static str {
    "hi"
}

pub fn add(a: i32, b: i32) -> i32 {
    a - b
}

#[cfg(test)]
mod tests {
    #[test]
    fn add_works() {
        assert_eq!(super::add(1, 2), 3);
    }
}
`;
const LIB_GREETING = LIB_BUGGY.replace('"hi"', '"hello, world"');
const LIB_FIXED = LIB_GREETING.replace('a - b', 'a + b');

// Sleeps like a real build so the status line has something to show; `test` fails while add() subtracts.
const CARGO = `#!/usr/bin/env bash
case "$1" in
  check) echo "    Checking demo v0.1.0"; sleep 3; echo "    Finished dev profile" ;;
  test)  echo "   Compiling demo v0.1.0"; sleep 7
         if grep -q 'a - b' src/lib.rs; then
           echo "test tests::add_works ... FAILED"; echo "test result: FAILED. 0 passed; 1 failed"; exit 101
         fi
         echo "test tests::add_works ... ok"; echo "test result: ok. 1 passed; 0 failed" ;;
  *)     echo "cargo $1" ;;
esac
`;

const TAILSCALE = `#!/usr/bin/env bash
if [ "$1" = status ]; then echo '{"Self":{"DNSName":"devbox.tailnet.ts.net."}}'; else echo '{}'; fi
`;

async function sh(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
	const proc = Bun.spawn(args, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`${args.join(' ')} failed (${code}): ${err || out}`);
	return out.trim();
}

async function script(path: string, body: string) {
	await writeFile(path, body);
	await chmod(path, 0o755);
}

async function fixture(root: string, port: number) {
	const repo = join(root, 'demo');
	const agent = join(root, 'agent');
	const bin = join(root, 'bin');
	await Promise.all([
		mkdir(join(repo, 'src'), { recursive: true }),
		mkdir(agent),
		mkdir(bin),
		mkdir(join(root, 'home')),
	]);
	await writeFile(join(repo, 'src/lib.rs'), LIB_BUGGY);
	await writeFile(join(repo, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n');
	const git = (...args: string[]) =>
		sh(repo, ['git', '-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...args]);
	await git('init', '-q', '-b', 'main');
	await git('remote', 'add', 'origin', 'git@github.com:acme/demo.git');
	await git('add', '-A');
	await git('commit', '-qm', 'init');
	await git('worktree', 'add', '-q', '-b', 'api', join(root, 'demo-api'));
	await script(join(bin, 'cargo'), CARGO);
	await script(join(bin, 'tailscale'), TAILSCALE);
	await writeFile(join(root, 'served'), repo);
	await writeFile(
		join(agent, 'config.yml'),
		'symbolPreset: nerd\ntheme:\n  dark: dark-cosmos\nstartup:\n  checkUpdate: false\n  setupWizard: false\nmodelRoles:\n  default: mock/mock-1\n',
	);
	await writeFile(
		join(agent, 'models.yml'),
		[
			'providers:',
			'  mock:',
			`    baseUrl: http://127.0.0.1:${port}/v1`,
			'    auth: none',
			'    api: openai-completions',
			'    models:',
			'      - id: mock-1',
			'        name: Demo model',
			'        contextWindow: 128000',
			'        maxTokens: 8000',
			'',
		].join('\n'),
	);
	await writeFile(
		join(agent, 'omp-builds.json'),
		JSON.stringify({
			projects: [
				{
					name: 'demo',
					origin: 'acme/demo',
					devServer: { unit: 'demo-dev', servedCheckoutFile: join(root, 'served') },
				},
			],
		}),
	);
	// The shared dev server runs from the main checkout, a preview from the worktree.
	const serve = (unit: string, dir: string, port: number) =>
		sh(dir, [
			'systemd-run',
			'--user',
			'--quiet',
			`--unit=${unit}`,
			`--working-directory=${dir}`,
			'python3',
			'-m',
			'http.server',
			String(port),
		]);
	await serve(UNITS[0], repo, 18731);
	await serve(UNITS[1], join(root, 'demo-api'), 18732);
	return { repo, agent, bin, home: join(root, 'home') };
}

// ---------------------------------------------------------------- scripted model

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

const write = (content: string): Reply => ({ tool: 'write', args: { path: 'src/lib.rs', content } });
const bash = (command: string): Reply => ({ tool: 'bash', args: { command } });

const SUMMARY_1 = [
	'`greeting()` in `src/lib.rs` now returns `"hello, world"`.',
	'',
	'- Started `cargo check && cargo test` in the background; the status line shows it.',
	'- `add()` still subtracts, so `add_works` will fail until that is fixed.',
].join('\n');
const FAILED = 'As expected, `add_works` failed: `add()` returns `a - b`. Ask and I will fix it.';
const SUMMARY_2 = [
	'Fixed `add()` in `src/lib.rs`: it returned `a - b`, now `a + b`.',
	'',
	'- Rerunning `cargo test` here and `cargo check` in the `demo-api` worktree, both in the background.',
	'- The preview on `:18732` serves `demo-api`; the dev server serves this checkout.',
].join('\n');
const CHECKED = '`cargo check` is clean in `demo-api`; `cargo test` is still running here.';
const PASSED = '**All green.** `cargo test` passes: 1 passed, 0 failed.';

type Msg = { role: string; content?: unknown };
const textOf = (m: Msg | undefined) =>
	typeof m?.content === 'string'
		? m.content
		: Array.isArray(m?.content)
			? m.content.map(c => (c as { text?: string }).text ?? '').join('')
			: '';

/** The next turn of the conversation, from the latest message that starts a scripted exchange. */
function reply(messages: Msg[], hasTools: boolean): Reply {
	if (!hasTools) return { text: 'Greeting and add() fixes' };
	const keys = ['hello, world', 'Fix add()', 'FAILED', 'test result: ok', 'Finished dev profile'];
	const last = messages.findLastIndex(m => m.role === 'user' && keys.some(k => textOf(m).includes(k)));
	const prompt = textOf(messages[last]);
	const step = messages.slice(last + 1).filter(m => m.role === 'assistant').length;
	const plan: Reply[] = prompt.includes('hello, world')
		? [write(LIB_GREETING), bash('cargo check && cargo test'), { text: SUMMARY_1 }]
		: prompt.includes('Fix add()')
			? [write(LIB_FIXED), bash('cargo test'), bash('cd ../demo-api && cargo check'), { text: SUMMARY_2 }]
			: prompt.includes('FAILED')
				? [{ text: FAILED }]
				: prompt.includes('test result: ok')
					? [{ text: PASSED }]
					: [{ text: CHECKED }];
	return plan[Math.min(step, plan.length - 1)];
}

function sse(r: Reply): string {
	const chunk = (delta: unknown, finish: string | null) =>
		`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const usage = `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } })}\n\n`;
	const body =
		'text' in r
			? chunk({ role: 'assistant', content: r.text }, null) + chunk({}, 'stop')
			: chunk(
					{
						role: 'assistant',
						tool_calls: [
							{
								index: 0,
								id: `call_${Math.random().toString(36).slice(2, 10)}`,
								type: 'function',
								function: { name: r.tool, arguments: JSON.stringify(r.args) },
							},
						],
					},
					null,
				) + chunk({}, 'tool_calls');
	return `${body}${usage}data: [DONE]\n\n`;
}

function mockModel() {
	return Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'mock-1', object: 'model' }] });
			const body = (await req.json()) as { messages: Msg[]; tools?: unknown[] };
			return new Response(sse(reply(body.messages, !!body.tools?.length)), {
				headers: { 'content-type': 'text/event-stream' },
			});
		},
	});
}

// ---------------------------------------------------------------- driving the real TUI

type Cell = { ch: string; fg?: string; bg?: string; bold: boolean; dim: boolean; italic: boolean };
type Screen = Cell[][];

const FG = '#d4d4d8';
const BG = '#0b0b12';
const ANSI16 = [
	'#1a1a22',
	'#e06c75',
	'#7ec699',
	'#e5c07b',
	'#7aa2f7',
	'#bb9af7',
	'#56b6c2',
	'#d4d4d8',
	'#6b6b7b',
	'#f07178',
	'#9ece6a',
	'#f5d08b',
	'#8db4ff',
	'#d2b0ff',
	'#7fd6e0',
	'#ffffff',
];

function paletteColor(index: number): string {
	if (index < 16) return ANSI16[index];
	const hex = (value: number) => value.toString(16).padStart(2, '0');
	if (index >= 232) return `#${hex(8 + (index - 232) * 10).repeat(3)}`;
	const cube = [0, 95, 135, 175, 215, 255];
	const n = index - 16;
	return `#${hex(cube[Math.floor(n / 36)])}${hex(cube[Math.floor(n / 6) % 6])}${hex(cube[n % 6])}`;
}

const cellColor = (rgb: boolean, palette: boolean, value: number) =>
	rgb ? `#${value.toString(16).padStart(6, '0')}` : palette ? paletteColor(value) : undefined;

function snapshot(term: Terminal): Screen {
	const buffer = term.buffer.active;
	const scratch = buffer.getNullCell();
	const rows: Screen = [];
	for (let y = 0; y < term.rows; y++) {
		const line = buffer.getLine(buffer.viewportY + y);
		const row: Cell[] = [];
		for (let x = 0; line && x < term.cols; x++) {
			const cell: IBufferCell | undefined = line.getCell(x, scratch);
			// The right half of a wide character is an empty cell.
			if (!cell || cell.getWidth() === 0) continue;
			let fg = cellColor(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor());
			let bg = cellColor(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor());
			if (cell.isInverse()) [fg, bg] = [bg ?? BG, fg ?? FG];
			row.push({
				ch: cell.getChars() || ' ',
				fg,
				bg,
				bold: !!cell.isBold(),
				dim: !!cell.isDim(),
				italic: !!cell.isItalic(),
			});
		}
		rows.push(row);
	}
	return rows;
}

const text = (row: Cell[]) =>
	row
		.map(cell => cell.ch)
		.join('')
		.trimEnd();

/** Type `keys`, wait until `until` is on screen (pressing Enter again once if a completion swallowed it), then keep it as `snap`. */
type Step = { keys: string; until?: string; snap?: string; timeout?: number };

const PROMPT_1 = 'Make greeting() return "hello, world" and run the tests.';
const PROMPT_2 = 'Fix add() and rerun the tests; check the demo-api worktree too.';

const STEPS: Step[] = [
	{ keys: PROMPT_1 },
	{ keys: KEY.enter, until: 'Work summary' },
	{ keys: '', until: 'Ask and I will fix it', timeout: 60_000 },
	{ keys: PROMPT_2 },
	{ keys: KEY.enter, until: 'check@demo-api 0:0', snap: 'running' },
	{ keys: '', until: 'All green', timeout: 60_000 },
	{ keys: '/builds status' },
	{ keys: KEY.enter, until: 'Builds · demo', snap: 'status' },
	{ keys: KEY.escape, until: 'All green' },
	{ keys: '/builds config' },
	{ keys: KEY.enter, until: 'omp-builds config', snap: 'config' },
	{ keys: KEY.escape },
];

async function drive(): Promise<Record<string, Screen>> {
	const root = await mkdtemp(join(tmpdir(), 'omp-builds-shots-'));
	const model = mockModel();
	const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 });
	const pty = new Bun.Terminal({ cols: COLS, rows: ROWS, data: (_pty, data) => term.write(data) });
	// Answer the TUI's terminal queries (device attributes, cursor position) like a real emulator.
	term.onData(reply => pty.write(reply));
	let proc: Bun.Subprocess | undefined;
	const screen = async () => {
		const parsed = Promise.withResolvers<void>();
		term.write('', parsed.resolve);
		await parsed.promise;
		return snapshot(term);
	};
	const visible = async (needle: string) => (await screen()).some(row => text(row).includes(needle));
	const waitFor = async (needle: string, timeout = 30_000) => {
		const deadline = Date.now() + timeout;
		let nudged = false;
		while (Date.now() < deadline) {
			if (await visible(needle)) {
				// Let the frame that drew it finish.
				await Bun.sleep(400);
				return;
			}
			if (!nudged && Date.now() > deadline - timeout + 2_000 && needle.includes('·')) {
				pty.write(KEY.enter);
				nudged = true;
			}
			await Bun.sleep(100);
		}
		const dump = (await screen()).map(text).join('\n');
		throw new Error(`"${needle}" never appeared. Screen:\n${dump}`);
	};
	try {
		if (!model.port) throw new Error('mock model server has no port');
		const paths = await fixture(root, model.port);
		const env = {
			// `bun run` puts node_modules/.bin first, whose `omp` is the pinned dev dependency, not the installed one.
			PATH: [
				paths.bin,
				...(process.env.PATH ?? '/usr/bin:/bin').split(':').filter(p => !p.endsWith('node_modules/.bin')),
			].join(':'),
			HOME: paths.home,
			LANG: 'C.UTF-8',
			PI_CODING_AGENT_DIR: paths.agent,
			TERM: 'xterm-256color',
			COLORTERM: 'truecolor',
			// systemctl --user needs the real user manager.
			XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
			DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
		};
		proc = Bun.spawn(
			['omp', '--no-extensions', '-e', join(REPO, 'index.ts'), '--no-lsp', '--no-skills', '--model', 'mock/mock-1'],
			{ cwd: paths.repo, env, terminal: pty },
		);
		await waitFor('Demo model');
		const snaps: Record<string, Screen> = {};
		for (const step of STEPS) {
			if (step.keys) pty.write(step.keys);
			if (step.until) await waitFor(step.until, step.timeout);
			else await Bun.sleep(400);
			if (step.snap) snaps[step.snap] = await screen();
		}
		return snaps;
	} finally {
		proc?.kill('SIGKILL');
		await proc?.exited;
		pty.close();
		model.stop(true);
		await Bun.spawn(['systemctl', '--user', 'stop', ...UNITS.map(u => `${u}.service`)]).exited;
		await rm(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- panels and images

/** omp's powerline bar shows temp paths and model details, and the empty editor is a bare corner; panels leave both out. */
const isChrome = (row: Cell[]) => text(row).startsWith('\ue0b6') || text(row).trim() === '╰─';

/** From the first row containing `top` to the last drawn line, without omp's own chrome. */
function from(top: string) {
	return (screen: Screen): Screen => {
		const start = screen.findIndex(row => text(row).includes(top));
		const end = screen.findLastIndex(row => text(row).trim() !== '');
		if (start < 0) throw new Error(`"${top}" not found`);
		return screen.slice(start, end + 1).filter(row => !isChrome(row));
	};
}

type Panel = { caption?: string; screen: string; crop: (screen: Screen) => Screen };

const IMAGES: Record<string, Panel[]> = {
	running: [{ screen: 'running', crop: from('Work summary') }],
	status: [{ screen: 'status', crop: from('Builds · demo') }],
	config: [{ screen: 'config', crop: from('omp-builds config') }],
};

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function rowHtml(row: Cell[]): string {
	let html = '';
	let style = '';
	let run = '';
	const flush = () => {
		if (run) html += style ? `<span style="${style}">${escapeHtml(run)}</span>` : escapeHtml(run);
		run = '';
	};
	for (const cell of row) {
		const next = [
			cell.fg ? `color:${cell.fg}` : '',
			cell.bg ? `background:${cell.bg}` : '',
			cell.bold ? 'font-weight:700' : '',
			cell.italic ? 'font-style:italic' : '',
			cell.dim ? 'opacity:.6' : '',
		]
			.filter(Boolean)
			.join(';');
		if (next !== style) {
			flush();
			style = next;
		}
		run += cell.ch;
	}
	flush();
	return html;
}

function pageHtml(panels: Array<{ caption?: string; rows: Screen }>): string {
	const body = panels
		.map(
			({ caption, rows }) =>
				`${caption ? `<div class="caption">${escapeHtml(caption)}</div>` : ''}<pre>${rows.map(rowHtml).join('\n')}</pre>`,
		)
		.join('');
	return `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; }
.frame { display: inline-block; margin: 0; padding: 0 0 6px; background: ${BG}; border: 1px solid #23232f;
  border-radius: 10px; overflow: hidden; }
.bar { display: flex; gap: 7px; padding: 11px 14px 4px; }
.bar i { width: 11px; height: 11px; border-radius: 50%; background: #2a2a38; }
.caption { font: 11px/1 "JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", monospace; letter-spacing: .12em;
  text-transform: uppercase; color: #7c7c8f; padding: 14px 18px 0; }
pre { margin: 0; padding: 8px 18px 10px; font: 14px/19px "JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM",
  monospace; color: ${FG}; white-space: pre; width: ${COLS}ch; }
</style><div class="frame"><div class="bar"><i></i><i></i><i></i></div>${body}</div>`;
}

async function screenshot(pages: Record<string, string>): Promise<void> {
	const executablePath =
		process.env.CHROME ??
		['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
			.map(name => Bun.which(name))
			.find(Boolean);
	if (!executablePath) throw new Error('Chromium not found; set CHROME to a Chromium or Chrome binary');
	const browser = await puppeteer.launch({ executablePath, headless: true });
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
		for (const [name, html] of Object.entries(pages)) {
			await page.setContent(html, { waitUntil: 'load' });
			await page.evaluate(() => document.fonts.ready);
			const frame = await page.$('.frame');
			if (!frame) throw new Error(`${name}: frame missing`);
			const out = join(OUT, `${name}.webp`);
			// Transparent outside the rounded frame, so it sits on GitHub's light and dark themes alike.
			await frame.screenshot({ path: out as `${string}.webp`, type: 'webp', quality: 92, omitBackground: true });
			console.log(`${out}  ${Math.round(Bun.file(out).size / 1024)} KB`);
		}
	} finally {
		await browser.close();
	}
}

// ---------------------------------------------------------------- main

const OUT = join(REPO, 'docs', 'screens');
const screens = await drive();

if (process.argv.includes('--text')) {
	for (const [name, rows] of Object.entries(screens)) {
		console.log(`===== ${name}`);
		for (const row of rows) if (text(row)) console.log(text(row));
	}
} else {
	await mkdir(OUT, { recursive: true });
	const pages = Object.fromEntries(
		Object.entries(IMAGES).map(([name, panels]) => [
			name,
			pageHtml(panels.map(({ caption, screen, crop }) => ({ caption, rows: crop(screens[screen]) }))),
		]),
	);
	await screenshot(pages);
}
