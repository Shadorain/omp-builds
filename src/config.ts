import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from '@oh-my-pi/pi-coding-agent';

const text = () => z.string().min(1);

const validRegex = (source: string) => {
	try {
		new RegExp(source, 'i');
		return true;
	} catch {
		return false;
	}
};

const BuildSchema = z
	.object({
		/** Shell command prefix; the word after it is the step, e.g. `cargo auto` + `test`. */
		command: text(),
		/** Process argv prefix that runs a step, when it differs from `command` (e.g. `cargo-auto auto`). */
		process: text().optional(),
		/** Only these steps count; every step when absent. */
		steps: z.array(text()).min(1).optional(),
	})
	.strict();

const DevServerSchema = z
	.object({
		/** systemd user unit of the shared dev server, without `.service`. */
		unit: text(),
		/** File holding the commit the server runs; a checkout whose HEAD is in it is deployed. */
		deployedShaFile: text().optional(),
		/** File holding the path of the checkout the server runs. */
		servedCheckoutFile: text().optional(),
		/** With `servedCheckoutFile`: a rebuild stamp, `git rev-parse HEAD:<paths> | sha1sum | cut -c1-12`. */
		builtStamp: z
			.object({ file: text(), paths: z.array(text()).min(1) })
			.strict()
			.optional(),
		/** Unit that redeploys the server; running means `rebuilding`. */
		redeployUnit: text().optional(),
	})
	.strict()
	.refine(d => !(d.deployedShaFile && d.servedCheckoutFile), 'only one of deployedShaFile and servedCheckoutFile')
	.refine(d => !d.builtStamp || !!d.servedCheckoutFile, 'given servedCheckoutFile when builtStamp is set');

const ProjectSchema = z
	.object({
		/** Shown in the UI; also the prefix of systemd units searched for extra dev servers. */
		name: z.string().regex(/^[\w.-]+$/, "letters, digits, '.', '_' or '-'"),
		/** Case-insensitive regex tested against the `origin` remote URL. */
		origin: text().refine(validRegex, 'a valid regular expression'),
		devServer: DevServerSchema.optional(),
	})
	.strict();

const ConfigSchema = z
	.object({
		build: BuildSchema.optional(),
		/** Repositories the extension switches on in. Every other checkout is left alone. */
		projects: z.array(ProjectSchema).optional(),
	})
	.strict()
	.refine(c => new Set(c.projects?.map(p => p.name)).size === (c.projects?.length ?? 0), 'unique project names');

export type BuildConfig = z.infer<typeof BuildSchema>;
export type DevServerConfig = z.infer<typeof DevServerSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export interface Config {
	build: BuildConfig;
	projects: ProjectConfig[];
}

export const DEFAULT_CONFIG: Config = {
	build: { command: 'cargo', steps: ['build', 'check', 'test', 'clippy', 'nextest', 'bench', 'doc'] },
	projects: [],
};

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR?.trim() || env.OMP_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent');
}

export const configPath = () => join(agentDir(), 'omp-builds.json');

/** `~/x` → absolute. */
export const expandHome = (path: string) =>
	path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;

export type ConfigResult = { config: Config } | { issues: string[] };

/** A config from parsed JSON, or the reasons it is invalid. Missing keys take their defaults. */
export function parseConfig(value: unknown): ConfigResult {
	const parsed = ConfigSchema.safeParse(value);
	if (!parsed.success) {
		// The validator echoes whole objects after "(was …)"; the path already says where.
		const issue = (i: { path: PropertyKey[]; message: string }) =>
			`${i.path.map(String).join('.') || 'config'}: ${i.message.replace(/ \(was [[{].*\)$/s, '')}`;
		return { issues: parsed.error.issues.map(issue) };
	}
	return { config: { build: parsed.data.build ?? DEFAULT_CONFIG.build, projects: parsed.data.projects ?? [] } };
}

export interface LoadedConfig {
	config: Config;
	/** Why the file was rejected; `config` then holds the defaults, with no projects. */
	issues: string[];
}

const CACHE_KEY = Symbol.for('omp-builds.config');
// Shared by every instance of the extension in this process (the main session and subagents).
const cache = ((globalThis as Record<symbol, unknown>)[CACHE_KEY] ??= { stamp: '', loaded: null }) as {
	stamp: string;
	loaded: LoadedConfig | null;
};

/**
 * The config as it is on disk now. The same object comes back until the file changes, so callers
 * can cache work per config by identity.
 */
export async function loadConfig(path = configPath()): Promise<LoadedConfig> {
	const info = await stat(path).catch(() => null);
	const stamp = info ? `${path}:${info.mtimeMs}:${info.size}` : `${path}:none`;
	if (cache.loaded && cache.stamp === stamp) return cache.loaded;
	const result = await readConfig(path);
	cache.stamp = stamp;
	cache.loaded =
		'config' in result ? { config: result.config, issues: [] } : { config: DEFAULT_CONFIG, issues: result.issues };
	return cache.loaded;
}

/** The saved config, defaults when there is no file, or the reasons it cannot be used. */
export async function readConfig(path = configPath()): Promise<ConfigResult> {
	let raw: string;
	try {
		raw = await readFile(path, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: DEFAULT_CONFIG };
		return { issues: [`cannot read ${path}: ${(err as Error).message}`] };
	}
	try {
		return parseConfig(JSON.parse(raw));
	} catch (err) {
		return { issues: [`not valid JSON: ${(err as Error).message}`] };
	}
}

export const formatConfig = (config: Config) => `${JSON.stringify(config, null, '\t')}\n`;

/** Writes atomically, so a crash never leaves half a file. */
export async function writeConfig(config: Config, path = configPath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, formatConfig(config));
	await rename(tmp, path);
	cache.stamp = '';
}

/** Project entry for a repository: a name and an anchored `owner/repo` pattern from its origin URL. */
export function projectFromOrigin(name: string, originUrl: string): ProjectConfig {
	const path = originUrl
		.trim()
		.replace(/\.git$/, '')
		.replace(/^[a-z+]+:\/\/[^/]+\//i, '')
		.replace(/^[^@/]+@[^:]+:/, '');
	const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return { name, origin: `[/:]${escaped}(\\.git)?$` };
}
