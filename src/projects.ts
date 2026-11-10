import { readFile } from 'node:fs/promises';
import { type Config, type DevServerConfig, expandHome, loadConfig, type ProjectConfig } from './config';
import { git, run } from './git';
import { runningSince, services, tailnetUrl } from './servers';
import type { DevPin, DevServer, DevState, Project } from './types';

type DevCheck = Pick<DevPin, 'here' | 'since'>;

const readText = (path: string) =>
	readFile(expandHome(path), 'utf8')
		.then(s => s.trim())
		.catch(() => null);

const check = (here: DevState, since: number | null = null): DevCheck => ({ here, since });

/** The server runs one commit; this checkout is deployed when its HEAD is that commit or an ancestor. */
async function deployedSha(file: string, root: string): Promise<DevCheck> {
	const [deployed, head] = await Promise.all([readText(file), git(root, 'rev-parse', 'HEAD')]);
	if (!head || !deployed) return check('unknown');
	const inDev = head === deployed || (await run(root, ['git', 'merge-base', '--is-ancestor', head, deployed])) !== null;
	if (!inDev) return check('not deployed');
	return check((await git(root, 'status', '--porcelain')) === '' ? 'live' : 'edits not live');
}

/**
 * The server runs one checkout. With a built stamp, it serves committed code once a rebuild of the
 * stamped paths finishes; without one, it serves the working tree as it is.
 */
async function servedCheckout(dev: DevServerConfig, file: string, root: string): Promise<DevCheck> {
	const stamp = dev.builtStamp;
	const [checkout, built, deploying] = await Promise.all([
		readText(file),
		stamp ? readText(stamp.file) : null,
		dev.redeployUnit ? runningSince(dev.redeployUnit) : null,
	]);
	if (checkout !== root) return check('not deployed');
	if (!stamp) return deploying ? check('rebuilding', deploying) : check('live');
	if ((await run(root, ['git', 'diff', '--quiet', 'HEAD', '--', ...stamp.paths])) === null)
		return check('edits not live');
	const revs = await run(root, ['git', 'rev-parse', ...stamp.paths.map(p => `HEAD:${p}`)]);
	if (revs === null) return check('unknown');
	const current = new Bun.CryptoHasher('sha1').update(revs).digest('hex').slice(0, 12);
	if (current === built) return check('live');
	return deploying ? check('rebuilding', deploying) : check('behind');
}

function devCheck(dev: DevServerConfig, root: string): Promise<DevCheck> {
	if (dev.deployedShaFile) return deployedSha(dev.deployedShaFile, root);
	if (dev.servedCheckoutFile) return servedCheckout(dev, dev.servedCheckoutFile, root);
	return Promise.resolve(check('up'));
}

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

/** The configured project whose origin pattern matches `originUrl`. */
export const matchProject = (config: Config, originUrl: string): ProjectConfig | undefined =>
	config.projects.find(p => new RegExp(p.origin, 'i').test(originUrl));

async function detect(config: Config, cwd: string): Promise<Project | null> {
	const root = await checkoutRoot(cwd);
	const origin = root ? await git(root, 'remote', 'get-url', 'origin') : null;
	const def = origin ? matchProject(config, origin) : undefined;
	const key = root ? await projectKey(root) : null;
	if (!root || !def || !key) return null;
	const dev = def.devServer;
	const devPin = dev
		? async (): Promise<DevPin> => {
				const [state, running] = await Promise.all([devCheck(dev, root), services(def.name)]);
				const main = running.find(s => s.unit === dev.unit);
				const extras: DevServer[] = [];
				for (const s of running) {
					if (s === main || s.port === null || !s.cwd || (await projectKey(s.cwd)) !== key) continue;
					const url = await tailnetUrl(s.port, s.loopback);
					extras.push({ unit: s.unit, port: s.port, url, root: await checkoutRoot(s.cwd) });
				}
				const url = main?.port ? await tailnetUrl(main.port, main.loopback) : null;
				return { ...state, up: !!main, url, extras };
			}
		: async () => null;
	return { name: def.name, root, key, devPin };
}

let cachedFor: Config | null = null;
const projects = new Map<string, Promise<Project | null>>();
/** The configured project `cwd` belongs to, or null. Cached per directory until the config changes. */
export async function projectFor(cwd: string): Promise<Project | null> {
	const { config } = await loadConfig();
	if (config !== cachedFor) {
		cachedFor = config;
		projects.clear();
	}
	let project = projects.get(cwd);
	if (!project) {
		project = detect(config, cwd);
		projects.set(cwd, project);
	}
	return project;
}
