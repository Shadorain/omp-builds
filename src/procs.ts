import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { type BuildMatcher, processStep } from './steps';
import type { Build } from './types';

// Every build step runs as a process whose argv is the configured process words plus the step
// (`cargo-auto auto test`). Its nearest `omp` ancestor is the session that started it.

interface Stat {
	ppid: number;
	start: number;
}

let bootMs: number | null = null;
async function bootTime(): Promise<number> {
	if (bootMs === null) {
		const stat = await readFile('/proc/stat', 'utf8').catch(() => '');
		bootMs = Number(/^btime (\d+)/m.exec(stat)?.[1] ?? 0) * 1000;
	}
	return bootMs;
}

async function procStat(pid: number): Promise<Stat | null> {
	const raw = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
	if (!raw) return null;
	// Fields after the `(comm)`; starttime is field 22, in clock ticks (100/s) since boot.
	const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
	return { ppid: Number(fields[1]), start: (await bootTime()) + Number(fields[19]) * 10 };
}

/** The systemd service a process runs under, from its cgroup path, without `.service`. */
async function serviceUnit(pid: number): Promise<string | null> {
	const cgroup = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => '');
	return /\/([^/]+)\.service$/m.exec(cgroup.trim())?.[1] ?? null;
}

export async function scanBuilds(m: BuildMatcher): Promise<Build[]> {
	const pids = (await readdir('/proc').catch(() => [] as string[])).filter(n => /^\d+$/.test(n)).map(Number);
	const argvs = new Map<number, string[]>();
	await Promise.all(
		pids.map(async pid => {
			const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
			if (raw) argvs.set(pid, raw.split('\0').filter(Boolean));
		}),
	);
	const stats = new Map<number, Stat | null>();
	const stat = async (pid: number) => {
		if (!stats.has(pid)) stats.set(pid, await procStat(pid));
		return stats.get(pid) ?? null;
	};
	const steps = new Map<number, string>();
	for (const [pid, argv] of argvs) {
		const step = processStep(m, argv);
		if (step) steps.set(pid, step);
	}
	const builds: Build[] = [];
	for (const [pid, step] of steps) {
		const chain: number[] = [];
		for (let p = (await stat(pid))?.ppid ?? 0; p > 1 && chain.length < 40; p = (await stat(p))?.ppid ?? 0)
			chain.push(p);
		// A wrapper that runs the build process again under itself would double count.
		if (chain.some(p => steps.has(p))) continue;
		const owner = chain.find(p => basename(argvs.get(p)?.[0] ?? '') === 'omp') ?? null;
		builds.push({
			pid,
			step,
			start: (await stat(pid))?.start ?? Date.now(),
			owner,
			cwd: await readlink(`/proc/${pid}/cwd`).catch(() => null),
			// Resolved by the caller: a git call per build does not belong in the scan.
			root: null,
			unit: owner === null ? await serviceUnit(pid) : null,
		});
	}
	return builds;
}
