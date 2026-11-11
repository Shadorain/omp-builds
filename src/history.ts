import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from '@oh-my-pi/pi-coding-agent';
import { agentDir } from './config';
import { expand } from './steps';
import type { Run } from './types';

const KEEP = 10;
const USUAL_OF = 5;

const SampleSchema = z.object({ run: z.string(), ms: z.number(), at: z.number() });
const HistorySchema = z.object({ version: z.literal(1), steps: z.record(z.string(), z.array(SampleSchema)) });

type Sample = z.infer<typeof SampleSchema>;
type Samples = Record<string, Sample[]>;

export const historyPath = (projectName: string) =>
	join(agentDir(), 'omp-builds', 'history', `${encodeURIComponent(projectName)}.json`);

/**
 * How long each step of a settled run took, for the steps that passed. A lone step takes the whole
 * run; a step of a chain takes its process's lifetime, when a scan saw it.
 */
export function passedDurations(run: Run): Record<string, number> {
	if (run.kind === 'other' || (run.state !== 'completed' && run.state !== 'failed') || run.end === undefined) return {};
	const out: Record<string, number> = {};
	for (const { name, state } of expand(run)) {
		if (state !== 'passed') continue;
		const timing = run.timings?.[name];
		const ms = run.steps.length === 1 ? run.end - run.start : timing ? timing.end - timing.start : 0;
		if (ms > 0) out[name] = ms;
	}
	return out;
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function merge(into: Samples, from: Samples): Samples {
	const out: Samples = { ...into };
	for (const [step, samples] of Object.entries(from)) {
		const seen = new Set((out[step] ?? []).map(s => s.run));
		const all = [...(out[step] ?? []), ...samples.filter(s => !seen.has(s.run))];
		out[step] = all.sort((a, b) => b.at - a.at).slice(0, KEEP);
	}
	return out;
}

async function readSamples(path: string): Promise<Samples> {
	const raw = await readFile(path, 'utf8').catch(() => null);
	if (raw === null) return {};
	try {
		const parsed = HistorySchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data.steps : {};
	} catch {
		return {};
	}
}

/** Pass times of one project's steps, shared by every session through one file. */
export class StepHistory {
	#samples: Samples = {};
	#added: Samples = {};

	constructor(readonly path: string | null) {}

	async load(): Promise<void> {
		if (this.path) this.#samples = merge(await readSamples(this.path), this.#added);
	}

	/** Adds a settled run's passed steps; the same run is counted once however often it is seen. */
	record(run: Run): void {
		const key = `${run.id}:${run.start}`;
		for (const [step, ms] of Object.entries(passedDurations(run))) {
			if (this.#samples[step]?.some(s => s.run === key)) continue;
			const sample = { run: key, ms, at: run.end ?? Date.now() };
			this.#samples = merge(this.#samples, { [step]: [sample] });
			this.#added = merge(this.#added, { [step]: [sample] });
		}
	}

	/** Median of the latest passes of a step, or null before its first. */
	usual(step: string): number | null {
		const samples = this.#samples[step];
		return samples?.length ? median(samples.slice(0, USUAL_OF).map(s => s.ms)) : null;
	}

	get dirty(): boolean {
		return Object.keys(this.#added).length > 0;
	}

	/** Merges new samples into what other sessions saved meanwhile, and writes atomically. */
	async save(): Promise<void> {
		if (!this.path || !this.dirty) return;
		const added = this.#added;
		this.#added = {};
		try {
			const samples = merge(await readSamples(this.path), added);
			await mkdir(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.${process.pid}.tmp`;
			await writeFile(tmp, `${JSON.stringify({ version: 1, steps: samples })}\n`);
			await rename(tmp, this.path);
			this.#samples = merge(samples, this.#samples);
		} catch (err) {
			this.#added = merge(this.#added, added);
			throw err;
		}
	}
}
