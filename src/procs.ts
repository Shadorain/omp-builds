import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Build } from './types';

// Every `cargo auto` runs as a `cargo-auto auto <step>` process. Its nearest `omp` ancestor
// is the session that started it.

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

function autoIndex(argv: string[]): number {
	const i = argv.findIndex(a => a === 'cargo-auto' || a.endsWith('/cargo-auto'));
	return i >= 0 && argv[i + 1] === 'auto' ? i : -1;
}

export async function scanBuilds(): Promise<Build[]> {
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
	const autoPids = new Set([...argvs].filter(([, argv]) => autoIndex(argv) >= 0).map(([pid]) => pid));
	const builds: Build[] = [];
	for (const pid of autoPids) {
		const chain: number[] = [];
		for (let p = (await stat(pid))?.ppid ?? 0; p > 1 && chain.length < 40; p = (await stat(p))?.ppid ?? 0)
			chain.push(p);
		// Wrappers that re-exec cargo-auto would double count.
		if (chain.some(p => autoPids.has(p))) continue;
		const argv = argvs.get(pid) ?? [];
		builds.push({
			pid,
			step: argv.slice(autoIndex(argv) + 2).find(a => !a.startsWith('+')) ?? '?',
			start: (await stat(pid))?.start ?? Date.now(),
			owner: chain.find(p => basename(argvs.get(p)?.[0] ?? '') === 'omp') ?? null,
			cwd: await readlink(`/proc/${pid}/cwd`).catch(() => null),
			// Resolved by the caller: a git call per build does not belong in the scan.
			root: null,
		});
	}
	return builds;
}
