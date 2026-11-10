import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git, run } from './git';
import { runningSince, services, tailnetUrl } from './servers';
import type { DevPin, DevServer, DevState, Project } from './types';

type DevCheck = Pick<DevPin, 'here' | 'since'>;

interface ProjectDef {
	name: string;
	/** Matches the `origin` remote URL. */
	origin: RegExp;
	/** The shared dev server's systemd unit. Other running `<name>*` units with a port are extra servers. */
	unit: string;
	devPin(root: string): Promise<DevCheck>;
}

const readText = (path: string) =>
	readFile(path, 'utf8')
		.then(s => s.trim())
		.catch(() => null);

const check = (here: DevState, since: number | null = null): DevCheck => ({ here, since });

// webapp-dev.service serves origin/v2/backend-rewrite at the sha recorded in `deployed`.
async function webappPin(root: string): Promise<DevCheck> {
	const deployed = await readText(join(homedir(), '.local/share/webapp-dev/deployed'));
	const head = await git(root, 'rev-parse', 'HEAD');
	if (!head || !deployed) return check('unknown');
	const inDev = head === deployed || (await run(root, ['git', 'merge-base', '--is-ancestor', head, deployed])) !== null;
	if (!inDev) return check('not deployed');
	if ((await git(root, 'status', '--porcelain')) !== '') return check('edits not live');
	return check('live');
}

// Mirrors studio's deploy/dev-deploy: studio-dev.service redeploys on each commit in the
// served checkout and rebuilds the server when the committed Rust stamp changes.
async function studioPin(root: string): Promise<DevCheck> {
	const state = join(homedir(), '.config/studio');
	const [checkout, built, deploying] = await Promise.all([
		readText(join(state, 'dev-checkout')),
		readText(join(state, 'dev-built')),
		runningSince('studio-dev'),
	]);
	if (checkout !== root) return check('not deployed');
	const paths = ['crates', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'];
	if ((await run(root, ['git', 'diff', '--quiet', 'HEAD', '--', ...paths])) === null) return check('edits not live');
	const revs = await run(root, ['git', 'rev-parse', ...paths.map(p => `HEAD:${p}`)]);
	if (revs === null) return check('unknown');
	const stamp = new Bun.CryptoHasher('sha1').update(revs).digest('hex').slice(0, 12);
	if (stamp === built) return check('live');
	return deploying ? check('rebuilding', deploying) : check('behind');
}

/** Projects this extension switches on for. Every other checkout leaves OMP untouched. */
const PROJECTS: ProjectDef[] = [
	{ name: 'webapp', origin: /acme\/webapp/i, unit: 'webapp-dev', devPin: webappPin },
	{ name: 'studio', origin: /\/studio/i, unit: 'studio', devPin: studioPin },
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
	const devPin = async (): Promise<DevPin> => {
		const [state, running] = await Promise.all([def.devPin(root), services(def.name)]);
		const main = running.find(s => s.unit === def.unit);
		const extras: DevServer[] = [];
		for (const s of running) {
			if (s === main || s.port === null || !s.cwd || (await projectKey(s.cwd)) !== key) continue;
			extras.push({
				unit: s.unit,
				port: s.port,
				url: await tailnetUrl(s.port, s.loopback),
				root: await checkoutRoot(s.cwd),
			});
		}
		const url = main?.port ? await tailnetUrl(main.port, main.loopback) : null;
		return { ...state, up: !!main, url, extras };
	};
	return { name: def.name, root, key, devPin };
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
