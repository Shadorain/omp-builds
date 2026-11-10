import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { run } from './git';

/** A running user service and where it listens. */
export interface Service {
	unit: string;
	cwd: string | null;
	/** Lowest listening TCP port of any process in the unit. */
	port: number | null;
	/** Whether that port listens only on loopback. */
	loopback: boolean;
}

const home = homedir();
const systemctl = (...args: string[]) => run(home, ['systemctl', '--user', ...args]);

// MagicDNS name of this machine, e.g. devbox.tailnet.ts.net. Asked once per process.
let tailnetHost: Promise<string | null> | undefined;
export function hostName(): Promise<string | null> {
	tailnetHost ??= run(home, ['tailscale', 'status', '--json']).then(out => {
		try {
			const name: unknown = out && JSON.parse(out).Self?.DNSName;
			return typeof name === 'string' && name ? name.replace(/\.$/, '') : null;
		} catch {
			return null;
		}
	});
	return tailnetHost;
}

/** Ports `tailscale serve` fronts with HTTPS on this host. */
async function servedPorts(): Promise<Set<number>> {
	const out = await run(home, ['tailscale', 'serve', 'status', '--json']);
	try {
		const web: unknown = out && JSON.parse(out).Web;
		const keys = web && typeof web === 'object' ? Object.keys(web) : [];
		return new Set(keys.map(k => Number(k.slice(k.lastIndexOf(':') + 1))).filter(Number.isFinite));
	} catch {
		return new Set();
	}
}

/** Listening TCP sockets by owning pid: `ss -ltnpH` rows. */
async function listeners(): Promise<Map<number, { port: number; loopback: boolean }[]>> {
	const out = (await run(home, ['ss', '-ltnpH'])) ?? '';
	const byPid = new Map<number, { port: number; loopback: boolean }[]>();
	for (const line of out.split('\n')) {
		const local = line.trim().split(/\s+/)[3];
		if (!local) continue;
		const at = local.lastIndexOf(':');
		const host = local.slice(0, at);
		const port = Number(local.slice(at + 1));
		const loopback = host.startsWith('127.') || host === '[::1]';
		for (const [, pid] of line.matchAll(/pid=(\d+)/g)) {
			const list = byPid.get(Number(pid)) ?? [];
			list.push({ port, loopback });
			byPid.set(Number(pid), list);
		}
	}
	return byPid;
}

/** Running user services whose unit name starts with `prefix`, with their working directory and port. */
export async function services(prefix: string): Promise<Service[]> {
	const list =
		(await systemctl('list-units', '--type=service', '--state=running', '--no-legend', '--plain', `${prefix}*`)) ?? '';
	const units = list
		.split('\n')
		.map(l => l.trim().split(/\s+/)[0])
		.filter(u => u?.endsWith('.service'));
	if (!units.length) return [];
	const [shown, sockets] = await Promise.all([
		systemctl('show', ...units, '-p', 'Id', '-p', 'WorkingDirectory', '-p', 'ControlGroup'),
		listeners(),
	]);
	const out: Service[] = [];
	for (const block of (shown ?? '').split('\n\n')) {
		const props = Object.fromEntries(
			block
				.split('\n')
				.filter(l => l.includes('='))
				.map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
		);
		if (!props.Id) continue;
		const procs = await readFile(`/sys/fs/cgroup${props.ControlGroup}/cgroup.procs`, 'utf8').catch(() => '');
		const ports = procs
			.split('\n')
			.filter(Boolean)
			.flatMap(pid => sockets.get(Number(pid)) ?? [])
			.sort((a, b) => a.port - b.port);
		const cwd = props.WorkingDirectory?.replace(/^!/, '') || null;
		out.push({
			unit: props.Id.replace(/\.service$/, ''),
			cwd: cwd === home ? null : cwd,
			port: ports[0]?.port ?? null,
			loopback: ports.length > 0 && ports.every(p => p.loopback),
		});
	}
	return out;
}

/** Address of a listening service on the tailnet: HTTPS through `tailscale serve`, else plain HTTP if reachable. */
export async function tailnetUrl(port: number, loopback: boolean): Promise<string | null> {
	const [host, served] = await Promise.all([hostName(), servedPorts()]);
	if (!host) return null;
	if (served.has(port)) return `https://${host}:${port}`;
	return loopback ? null : `http://${host}:${port}`;
}

/** Start time of a unit that is running (a oneshot mid-run counts), or null when it is not. */
export async function runningSince(unit: string): Promise<number | null> {
	const out =
		(await systemctl(
			'show',
			`${unit}.service`,
			'-p',
			'ActiveState',
			'-p',
			'InactiveExitTimestamp',
			'--timestamp=unix',
		)) ?? '';
	if (!/ActiveState=(activating|active)\b/.test(out)) return null;
	const at = /InactiveExitTimestamp=@(\d+)/.exec(out)?.[1];
	return at ? Number(at) * 1000 : Date.now();
}

export const unitActive = async (unit: string) =>
	(await systemctl('is-active', `${unit}.service`))?.trim() === 'active';
