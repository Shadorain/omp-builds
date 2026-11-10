import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git, run } from './git';
import type { DevPin, DevState, Project } from './types';

type DevCheck = Omit<DevPin, 'url'>;

interface ProjectDef {
	name: string;
	/** Matches the `origin` remote URL. */
	origin: RegExp;
	/** Dev UI address on this host's tailnet name. */
	devUrl(host: string): string;
	devPin(root: string): Promise<DevCheck>;
}

const readText = (path: string) =>
	readFile(path, 'utf8')
		.then(s => s.trim())
		.catch(() => null);

const serviceUp = async (unit: string) =>
	(await run(homedir(), ['systemctl', '--user', 'is-active', unit]))?.trim() === 'active';

// MagicDNS name of this machine, e.g. devbox.tailnet.ts.net. Asked once per process.
let tailnetHost: Promise<string | null> | undefined;
function hostName(): Promise<string | null> {
	tailnetHost ??= run(homedir(), ['tailscale', 'status', '--json']).then(out => {
		try {
			const name: unknown = out && JSON.parse(out).Self?.DNSName;
			return typeof name === 'string' && name ? name.replace(/\.$/, '') : null;
		} catch {
			return null;
		}
	});
	return tailnetHost;
}

const pin = (up: boolean, here: DevState): DevCheck => ({ up, here });

// webapp-dev.service serves origin/v2/backend-rewrite at the sha recorded in `deployed`.
async function webappPin(root: string): Promise<DevCheck> {
	const deployed = await readText(join(homedir(), '.local/share/webapp-dev/deployed'));
	const up = await serviceUp('webapp-dev');
	const head = await git(root, 'rev-parse', 'HEAD');
	if (!head || !deployed) return pin(up, 'unknown');
	const inDev = head === deployed || (await run(root, ['git', 'merge-base', '--is-ancestor', head, deployed])) !== null;
	if (!inDev) return pin(up, 'not deployed');
	if ((await git(root, 'status', '--porcelain')) !== '') return pin(up, 'edits not live');
	return pin(up, 'live');
}

// Mirrors studio's deploy/dev-deploy: the server rebuilds when the committed Rust stamp changes.
async function studioPin(root: string): Promise<DevCheck> {
	const state = join(homedir(), '.config/studio');
	const checkout = await readText(join(state, 'dev-checkout'));
	const built = await readText(join(state, 'dev-built'));
	const up = await serviceUp('studio');
	if (checkout !== root) return pin(up, 'not deployed');
	const paths = ['crates', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'];
	if ((await run(root, ['git', 'diff', '--quiet', 'HEAD', '--', ...paths])) === null) {
		return pin(up, 'edits not live');
	}
	const revs = await run(root, ['git', 'rev-parse', ...paths.map(p => `HEAD:${p}`)]);
	if (revs === null) return pin(up, 'unknown');
	const stamp = new Bun.CryptoHasher('sha1').update(revs).digest('hex').slice(0, 12);
	return pin(up, stamp === built ? 'live' : 'rebuilding');
}

/** Projects this extension switches on for. Every other checkout leaves OMP untouched. */
const PROJECTS: ProjectDef[] = [
	{
		name: 'webapp',
		origin: /acme\/webapp/i,
		devUrl: host => `http://${host}:3000`,
		devPin: webappPin,
	},
	// `tailscale serve` fronts studio with HTTPS on the same port.
	{ name: 'studio', origin: /\/studio/i, devUrl: host => `https://${host}:7878`, devPin: studioPin },
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
		const [check, host] = await Promise.all([def.devPin(root), hostName()]);
		return { ...check, url: host ? def.devUrl(host) : null };
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
