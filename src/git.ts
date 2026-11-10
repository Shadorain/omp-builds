import { copyFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Stdout of a successful command, or null on a non-zero exit or spawn failure. */
export async function run(cwd: string, argv: string[], env?: Record<string, string>): Promise<string | null> {
	try {
		const proc = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'ignore' });
		const out = await new Response(proc.stdout).text();
		return (await proc.exited) === 0 ? out : null;
	} catch {
		return null;
	}
}

export const git = async (cwd: string, ...args: string[]) => (await run(cwd, ['git', ...args]))?.trim() ?? null;

/** Hash of the working tree as `git add -A` would see it, so untracked files count too. */
export async function treeStamp(cwd: string): Promise<string | null> {
	const index = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
	const root = await git(cwd, 'rev-parse', '--show-toplevel');
	if (!index || !root) return null;
	const tmp = join(tmpdir(), `omp-builds-${process.pid}-${Math.random().toString(36).slice(2)}.idx`);
	try {
		// Seeding from the real index keeps git's stat cache, so this stays fast on big repos.
		await copyFile(index, tmp).catch(() => {});
		const env = { GIT_INDEX_FILE: tmp };
		if ((await run(root, ['git', 'add', '-A'], env)) === null) return null;
		return (await run(root, ['git', 'write-tree'], env))?.trim().slice(0, 7) ?? null;
	} finally {
		await unlink(tmp).catch(() => {});
	}
}
