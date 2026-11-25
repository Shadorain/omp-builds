import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type ExtensionContext, z } from '@oh-my-pi/pi-coding-agent';
import { truncate } from '@oh-my-pi/pi-tui/text/width';
import {
	asList,
	type BuildConfig,
	CARGO_BUILD,
	type Config,
	configPath,
	formatConfig,
	type LoadedConfig,
	loadConfig,
	parseConfig,
	projectFromOrigin,
	writeConfig,
} from './config';
import { git } from './git';
import { checkoutRoot, matchProject } from './projects';
import { services } from './servers';
import type { Theme } from './status-line';
import { openWindow } from './window';
import type { ArgNode } from './completions';

export const CONFIG_USAGE =
	'Usage: /builds config [add | remove [name] | build add [command] | build remove | estimates [on | off] | edit]';

export const CONFIG_ARGS: ArgNode = {
	word: 'config',
	description: 'Show or change the configuration: builds and auto-loaded projects',
	next: [
		{ word: 'add', description: 'Auto-load omp-builds in this repository' },
		{ word: 'remove', description: 'Stop auto-loading a project' },
		{
			word: 'build',
			description: 'Track or stop tracking build commands',
			next: [
				{ word: 'add', description: 'Track another build command, e.g. pnpm' },
				{ word: 'remove', description: 'Stop tracking a build command' },
			],
		},
		{
			word: 'estimates',
			description: 'Toggle how long running steps usually take',
			next: [
				{ word: 'on', description: 'Time passing steps and show the usual time' },
				{ word: 'off', description: 'Stop timing steps and hide the usual time' },
			],
		},
		{ word: 'edit', description: 'Edit the whole JSON file' },
	],
};

function buildRow(theme: Theme, b: BuildConfig): string {
	const muted = (s: string) => theme.fg('muted', s);
	const process = b.process ? muted(`  process ${asList(b.process).join(' | ')}`) : '';
	const label = b.label ? `${theme.fg('accent', b.label)}  ` : '';
	return `    ${label}${asList(b.command).join(' | ')} ${muted('<step>')}  ${muted(b.steps?.join(', ') ?? 'any step')}${process}`;
}

function configView(theme: Theme, width: number, loaded: LoadedConfig, here: string | null): string[] {
	const { config, issues } = loaded;
	const muted = (s: string) => theme.fg('muted', s);
	const lines = [muted(configPath())];
	if (issues.length) {
		lines.push('', theme.fg('error', 'Not loaded; fix it with /builds config edit:'), ...issues.map(i => `  ${i}`));
	}
	const estimates = config.estimates ? theme.fg('success', 'on') : muted('off');
	lines.push('', `${muted('Usual step times')}  ${estimates}`);
	lines.push('', muted('Every project'), ...config.builds.map(b => buildRow(theme, b)), '');
	if (!config.projects.length) lines.push(muted('No projects yet. /builds config add enables this repository.'));
	for (const p of config.projects) {
		const mark = p.name === here ? theme.fg('success', '●') : muted('○');
		const dev = p.devServer ? `dev ${p.devServer.unit}` : 'no dev server';
		lines.push(
			`${mark} ${p.name}  ${muted(p.origin)}  ${muted(dev)}`,
			...(p.builds ?? []).map(b => buildRow(theme, b)),
		);
	}
	lines.push('', muted(CONFIG_USAGE.replace('Usage: ', '')));
	return lines.map(l => truncate(l, width));
}

async function save(ctx: ExtensionContext, config: Config, done: string, onChange: () => Promise<void>) {
	await writeConfig(config);
	ctx.ui.notify(done, 'info');
	await onChange();
}

/** Running user services that listen on a port: the candidates for a project's dev server. */
async function listeningUnits(): Promise<string[]> {
	return (await services('')).filter(s => s.port !== null).map(s => `${s.unit}  :${s.port}`);
}

async function add(ctx: ExtensionContext, config: Config, onChange: () => Promise<void>): Promise<void> {
	const root = await checkoutRoot(ctx.cwd);
	const origin = root ? await git(root, 'remote', 'get-url', 'origin') : null;
	if (!root || !origin) return ctx.ui.notify('Run this in a Git checkout with an origin remote.', 'warning');
	const existing = matchProject(config, origin);
	if (existing) return ctx.ui.notify(`Already auto-loaded as "${existing.name}".`, 'info');
	const suggested = basename(root)
		.toLowerCase()
		.replace(/[^\w.-]/g, '-');
	const typed = (await ctx.ui.input(`Project name (Enter for ${suggested})`, suggested))?.trim();
	if (typed === undefined) return;
	const name = typed || suggested;
	if (config.projects.some(p => p.name === name)) return ctx.ui.notify(`"${name}" is taken.`, 'warning');
	const none = 'No dev server';
	const pick = await ctx.ui.select('Dev server (a running systemd user unit)', [none, ...(await listeningUnits())]);
	if (pick === undefined) return;
	const project = projectFromOrigin(name, origin);
	if (pick !== none) project.devServer = { unit: pick.split(/\s+/)[0] };
	const next = { ...config, projects: [...config.projects, project] };
	await save(ctx, next, `omp-builds now loads in ${name}.`, onChange);
}

async function remove(
	ctx: ExtensionContext,
	config: Config,
	name: string | undefined,
	onChange: () => Promise<void>,
): Promise<void> {
	if (!config.projects.length) return ctx.ui.notify('No projects configured.', 'info');
	const target =
		name ??
		(await ctx.ui.select(
			'Stop auto-loading',
			config.projects.map(p => p.name),
		));
	if (target === undefined) return;
	if (!config.projects.some(p => p.name === target)) return ctx.ui.notify(`No project "${target}".`, 'warning');
	const next = { ...config, projects: config.projects.filter(p => p.name !== target) };
	await save(ctx, next, `omp-builds no longer loads in ${target}.`, onChange);
}

async function edit(ctx: ExtensionContext, config: Config, onChange: () => Promise<void>): Promise<void> {
	let text = formatConfig(config);
	for (;;) {
		const edited = await ctx.ui.editor(`Edit ${configPath()}`, text);
		if (edited === undefined || edited === text) return;
		text = edited;
		let value: unknown;
		try {
			value = JSON.parse(edited);
		} catch (err) {
			ctx.ui.notify(`Not valid JSON: ${(err as Error).message}`, 'error');
			continue;
		}
		const parsed = parseConfig(value);
		if ('issues' in parsed) {
			ctx.ui.notify(`Not saved:\n${parsed.issues.join('\n')}`, 'error');
			continue;
		}
		return save(ctx, parsed.config, 'Configuration saved.', onChange);
	}
}

// Package runners run scripts as `pnpm test` and `pnpm run test`; both count.
const PACKAGE_RUNNERS: Record<string, true> = { npm: true, pnpm: true, yarn: true, bun: true };
// Scripts worth tracking when suggesting steps: the ones that build, check or test.
const CHECK_SCRIPT = /^(build|check|lint|test|e2e|typecheck|verify)/;
const PackageSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });

async function scriptSteps(cwd: string): Promise<string[]> {
	const root = await checkoutRoot(cwd);
	const raw = root ? await readFile(join(root, 'package.json'), 'utf8').catch(() => null) : null;
	if (!raw) return [];
	let parsed: ReturnType<typeof PackageSchema.safeParse>;
	try {
		parsed = PackageSchema.safeParse(JSON.parse(raw));
	} catch {
		return [];
	}
	return parsed.success ? Object.keys(parsed.data.scripts ?? {}).filter(s => CHECK_SCRIPT.test(s)) : [];
}

async function addBuild(
	ctx: ExtensionContext,
	config: Config,
	here: string | null,
	typed: string,
	onChange: () => Promise<void>,
): Promise<void> {
	const command =
		typed.trim() || (await ctx.ui.input('Build command, e.g. pnpm; the word after it is the step', 'pnpm'))?.trim();
	if (!command) return;
	const runner = PACKAGE_RUNNERS[command] === true;
	const suggested = runner
		? (await scriptSteps(ctx.cwd)).join(', ')
		: command === CARGO_BUILD.command
			? (CARGO_BUILD.steps ?? []).join(', ')
			: '';
	const stepsText = await ctx.ui.input(
		`Steps to track, comma-separated; * for any (Enter for ${suggested || '*'})`,
		suggested || '*',
	);
	if (stepsText === undefined) return;
	const stepList = stepsText.trim() || suggested || '*';
	const steps = stepList === '*' ? undefined : stepList.split(/[,\s]+/).filter(Boolean);
	const label = await ctx.ui.input('Label before each step, e.g. web (empty for none)', '');
	if (label === undefined) return;
	const build: BuildConfig = { command: runner ? [command, `${command} run`] : command, steps };
	if (label.trim()) build.label = label.trim();
	let scope = 'Every project';
	if (here) {
		const pick = await ctx.ui.select('Track it in', [`${here} only`, scope]);
		if (pick === undefined) return;
		scope = pick;
	}
	const next =
		scope === 'Every project'
			? { ...config, builds: [...config.builds, build] }
			: {
					...config,
					projects: config.projects.map(p => (p.name === here ? { ...p, builds: [...(p.builds ?? []), build] } : p)),
				};
	const checked = parseConfig(next);
	if ('issues' in checked) return ctx.ui.notify(`Not saved:\n${checked.issues.join('\n')}`, 'error');
	const where = scope === 'Every project' ? 'every project' : here;
	await save(ctx, checked.config, `Tracking ${asList(build.command).join(' | ')} <step> in ${where}.`, onChange);
}

async function removeBuild(ctx: ExtensionContext, config: Config, onChange: () => Promise<void>): Promise<void> {
	const describe = (b: BuildConfig) => `${b.label ? `${b.label}: ` : ''}${asList(b.command).join(' | ')}`;
	const entries = [
		...config.builds.map((b, i) => ({ title: `every project  ${describe(b)}`, project: null, i })),
		...config.projects.flatMap(p =>
			(p.builds ?? []).map((b, i) => ({ title: `${p.name}  ${describe(b)}`, project: p.name, i })),
		),
	];
	if (!entries.length) return ctx.ui.notify('No builds configured.', 'info');
	const pick = await ctx.ui.select(
		'Stop tracking',
		entries.map(e => e.title),
	);
	const entry = entries.find(e => e.title === pick);
	if (!entry) return;
	const next =
		entry.project === null
			? { ...config, builds: config.builds.filter((_, i) => i !== entry.i) }
			: {
					...config,
					projects: config.projects.map(p =>
						p.name === entry.project ? { ...p, builds: (p.builds ?? []).filter((_, i) => i !== entry.i) } : p,
					),
				};
	await save(ctx, next, `Stopped tracking ${entry.title.replace(/\s+/, ': ')}.`, onChange);
}

/** `/builds config …`: works in any directory, so a repository can be enabled from inside it. */
export async function configCommand(
	ctx: ExtensionContext,
	args: string[],
	here: string | null,
	onChange: () => Promise<void>,
): Promise<void> {
	const loaded = await loadConfig();
	const [verb, ...rest] = args;
	if (!verb) {
		return openWindow(ctx, 'config', 'omp-builds config', (_ui, theme, width) => configView(theme, width, loaded, here));
	}
	// A broken file can only be repaired as a whole; quick edits would overwrite it with defaults.
	const config = loaded.issues.length ? null : loaded.config;
	if (verb === 'edit' && !rest.length) return edit(ctx, config ?? loaded.config, onChange);
	if (!config)
		return ctx.ui.notify(`The config has errors; run /builds config edit.\n${loaded.issues.join('\n')}`, 'error');
	if (verb === 'add' && !rest.length) return add(ctx, config, onChange);
	if (verb === 'remove' && rest.length <= 1) return remove(ctx, config, rest[0], onChange);
	if (verb === 'build' && rest[0] === 'add') return addBuild(ctx, config, here, rest.slice(1).join(' '), onChange);
	if (verb === 'build' && rest[0] === 'remove' && rest.length === 1) return removeBuild(ctx, config, onChange);
	if (verb === 'estimates' && rest.length <= 1 && (!rest[0] || rest[0] === 'on' || rest[0] === 'off')) {
		const estimates = rest[0] ? rest[0] === 'on' : !config.estimates;
		const done = estimates ? 'Running steps now show how long they usually take.' : 'Usual step times are off.';
		return save(ctx, { ...config, estimates }, done, onChange);
	}
	ctx.ui.notify(CONFIG_USAGE, 'info');
}
