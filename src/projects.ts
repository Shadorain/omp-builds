import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git, run } from './git';
import type { DevPin, Project } from './types';

interface ProjectDef {
	name: string;
	/** Matches the `origin` remote URL. */
	origin: RegExp;
	devPin(root: string): Promise<DevPin>;
}

const readText = (path: string) =>
	readFile(path, 'utf8')
		.then(s => s.trim())
		.catch(() => null);

const serviceUp = async (unit: string) =>
	(await run(homedir(), ['systemctl', '--user', 'is-active', unit]))?.trim() === 'active';

// webapp-dev.service serves origin/v2/backend-rewrite at the sha recorded in `deployed`.
async function webappPin(root: string): Promise<DevPin> {
	const deployed = await readText(join(homedir(), '.local/share/webapp-dev/deployed'));
	const up = await serviceUp('webapp-dev');
	const head = await git(root, 'rev-parse', 'HEAD');
	if (!head || !deployed) return { up, here: 'unknown', tone: 'muted' };
	const inDev = head === deployed || (await run(root, ['git', 'merge-base', '--is-ancestor', head, deployed])) !== null;
	if (!inDev) return { up, here: 'not on dev', tone: 'muted' };
	if ((await git(root, 'status', '--porcelain')) !== '') return { up, here: 'edits not live', tone: 'warning' };
	return { up, here: 'live', tone: 'success' };
}

// Mirrors studio's deploy/dev-deploy: the server rebuilds when the committed Rust stamp changes.
async function studioPin(root: string): Promise<DevPin> {
	const state = join(homedir(), '.config/studio');
	const checkout = await readText(join(state, 'dev-checkout'));
	const built = await readText(join(state, 'dev-built'));
	const up = await serviceUp('studio');
	if (checkout !== root) return { up, here: 'not on dev', tone: 'muted' };
	const paths = ['crates', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'];
	if ((await run(root, ['git', 'diff', '--quiet', 'HEAD', '--', ...paths])) === null) {
		return { up, here: 'edits not live', tone: 'warning' };
	}
	const revs = await run(root, ['git', 'rev-parse', ...paths.map(p => `HEAD:${p}`)]);
	if (revs === null) return { up, here: 'unknown', tone: 'muted' };
	const stamp = new Bun.CryptoHasher('sha1').update(revs).digest('hex').slice(0, 12);
	return stamp === built ? { up, here: 'live', tone: 'success' } : { up, here: 'rebuilding', tone: 'warning' };
}

/** Projects this extension switches on for. Every other checkout leaves OMP untouched. */
const PROJECTS: ProjectDef[] = [
	{ name: 'webapp', origin: /acme\/webapp/i, devPin: webappPin },
	{ name: 'studio', origin: /\/studio/i, devPin: studioPin },
];

// Worktrees of one repo share a common git dir, so they count as one project.
const keys = new Map<string, Promise<string | null>>();
export function projectKey(dir: string): Promise<string | null> {
	let key = keys.get(dir);
	if (!key) {
		key = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
		keys.set(dir, key);
	}
	return key;
}

async function detect(cwd: string): Promise<Project | null> {
	const root = await git(cwd, 'rev-parse', '--show-toplevel');
	const origin = root ? await git(root, 'remote', 'get-url', 'origin') : null;
	const def = origin ? PROJECTS.find(p => p.origin.test(origin)) : undefined;
	const key = root ? await projectKey(root) : null;
	if (!root || !def || !key) return null;
	return { name: def.name, root, key, devPin: () => def.devPin(root) };
}

const roots = new Map<string, Promise<string | null>>();
/** Top level of the checkout (worktree) `dir` is in. Cached per directory. */
export function checkoutRoot(dir: string): Promise<string | null> {
	let root = roots.get(dir);
	if (!root) {
		root = git(dir, 'rev-parse', '--show-toplevel');
		roots.set(dir, root);
	}
	return root;
}

const projects = new Map<string, Promise<Project | null>>();
/** The supported project `cwd` belongs to, or null. Cached per directory for the process lifetime. */
export function projectFor(cwd: string): Promise<Project | null> {
	let project = projects.get(cwd);
	if (!project) {
		project = detect(cwd);
		projects.set(cwd, project);
	}
	return project;
}
