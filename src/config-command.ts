import { basename } from 'node:path';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { truncateToWidth } from '@oh-my-pi/pi-tui';
import {
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

export const CONFIG_USAGE = 'Usage: /builds config [add | remove [name] | build <command> | edit]';

export const CONFIG_COMPLETIONS = [
	{ value: 'config', label: 'config', description: 'Show the configuration: build command and auto-loaded projects' },
	{ value: 'config add', label: 'config add', description: 'Auto-load omp-builds in this repository' },
	{ value: 'config remove', label: 'config remove', description: 'Stop auto-loading a project' },
	{ value: 'config build ', label: 'config build', description: 'Set the build command, e.g. cargo auto' },
	{ value: 'config edit', label: 'config edit', description: 'Edit the whole JSON file' },
];

function configView(theme: Theme, width: number, loaded: LoadedConfig, here: string | null): string[] {
	const { config, issues } = loaded;
	const muted = (s: string) => theme.fg('muted', s);
	const lines = [muted(configPath())];
	if (issues.length) {
		lines.push('', theme.fg('error', 'Not loaded; fix it with /builds config edit:'), ...issues.map(i => `  ${i}`));
	}
	const { build } = config;
	lines.push(
		'',
		`${muted('build    ')}${build.command} ${muted('<step>')}`,
		`${muted('process  ')}${build.process ?? build.command}`,
		`${muted('steps    ')}${build.steps?.join(', ') ?? 'any'}`,
		'',
	);
	if (!config.projects.length) lines.push(muted('No projects yet. /builds config add enables this repository.'));
	for (const p of config.projects) {
		const mark = p.name === here ? theme.fg('success', '●') : muted('○');
		const dev = p.devServer ? `dev ${p.devServer.unit}` : 'no dev server';
		lines.push(`${mark} ${p.name}  ${muted(p.origin)}  ${muted(dev)}`);
	}
	lines.push('', muted(CONFIG_USAGE.replace('Usage: ', '')));
	return lines.map(l => truncateToWidth(l, width));
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
	const typed = (await ctx.ui.input('Project name', suggested))?.trim();
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
		return openWindow(ctx, 'config', 'omp-builds config', (theme, width) => configView(theme, width, loaded, here));
	}
	// A broken file can only be repaired as a whole; quick edits would overwrite it with defaults.
	const config = loaded.issues.length ? null : loaded.config;
	if (verb === 'edit' && !rest.length) return edit(ctx, config ?? loaded.config, onChange);
	if (!config)
		return ctx.ui.notify(`The config has errors; run /builds config edit.\n${loaded.issues.join('\n')}`, 'error');
	if (verb === 'add' && !rest.length) return add(ctx, config, onChange);
	if (verb === 'remove' && rest.length <= 1) return remove(ctx, config, rest[0], onChange);
	if (verb === 'build' && rest.length) {
		const next = { ...config, build: { ...config.build, command: rest.join(' '), process: undefined } };
		return save(ctx, next, `Build command: ${rest.join(' ')} <step>.`, onChange);
	}
	ctx.ui.notify(CONFIG_USAGE, 'info');
}
