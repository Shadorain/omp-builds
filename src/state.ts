import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from '@oh-my-pi/pi-coding-agent';
import { agentDir } from './config';
import type { Run, Summary } from './types';

const MAX_RUNS = 16;
const MAX_SUMMARIES = 20;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const RunSchema = z.object({
	id: z.string(),
	command: z.string(),
	steps: z.array(z.string()),
	live: z.string().nullable(),
	state: z.enum(['running', 'completed', 'failed', 'cancelled', 'finished']),
	who: z.string(),
	kind: z.enum(['main', 'sub']),
	start: z.number(),
	end: z.number().optional(),
	root: z.string().nullable(),
	tree: z.string().nullable(),
});

const StateSchema = z.object({
	version: z.literal(1),
	runs: z.array(RunSchema),
	summaries: z.array(z.object({ text: z.string(), at: z.string() })),
});

/** What one session tracked, kept across restarts: its own and its subagents' builds, and its summaries. */
export interface SessionState {
	runs: Run[];
	summaries: Summary[];
}

export const stateDir = () => join(agentDir(), 'omp-builds', 'sessions');
const statePath = (sessionId: string) => join(stateDir(), `${encodeURIComponent(sessionId)}.json`);

const saveable = (run: Run) => run.kind !== 'other';

/** The JSON saved for a session. */
export function formatState({ runs, summaries }: SessionState): string {
	const kept = runs
		.filter(saveable)
		.sort((a, b) => b.start - a.start)
		.slice(0, MAX_RUNS)
		.map(({ id, command, steps, live, state, who, kind, start, end, root, tree }) => ({
			id,
			command,
			steps,
			live,
			state,
			who,
			kind,
			start,
			end,
			root,
			tree,
		}));
	return `${JSON.stringify({ version: 1, runs: kept, summaries: summaries.slice(-MAX_SUMMARIES) })}\n`;
}

/**
 * The state as saved at `savedAt`. A build still running when the process went away died with it,
 * so it comes back stopped at that time.
 */
export function parseState(raw: string, savedAt: number): SessionState | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = StateSchema.safeParse(value);
	if (!parsed.success) return null;
	const { runs, summaries } = parsed.data;
	return {
		runs: runs.map(run => (run.state === 'running' ? { ...run, state: 'cancelled', end: savedAt } : run)),
		summaries,
	};
}

export async function loadState(sessionId: string): Promise<SessionState | null> {
	const path = statePath(sessionId);
	const [raw, info] = await Promise.all([readFile(path, 'utf8').catch(() => null), stat(path).catch(() => null)]);
	return raw === null || !info ? null : parseState(raw, info.mtimeMs);
}

let pruned = false;

/** Writes atomically; once per process, drops state of sessions untouched for a month. */
export async function saveState(sessionId: string, text: string): Promise<void> {
	const path = statePath(sessionId);
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, text);
	await rename(tmp, path);
	if (pruned) return;
	pruned = true;
	const dir = stateDir();
	for (const name of await readdir(dir).catch(() => [])) {
		const file = join(dir, name);
		const info = await stat(file).catch(() => null);
		if (info && Date.now() - info.mtimeMs > KEEP_MS) await unlink(file).catch(() => {});
	}
}
