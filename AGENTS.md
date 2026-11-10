# omp-builds

OMP extension that backgrounds `cargo auto` and shows a per-project build status line in webapp and studio sessions. Bun + TypeScript, no build step. `index.ts` re-exports `src/extension.ts`. Symlinked as `~/.omp/agent/extensions/omp-builds`.

## Commands

```bash
bun test              # full suite
bun run typecheck     # tsc --noEmit; wrap in memcap on daedalus
bun run format        # biome format --write
```

Run format, then test and typecheck, before a commit.

## Map

|File|Owns|
|---|---|
|`src/extension.ts`|Event wiring, tick loop, `work_summary` tool, `/builds` command|
|`src/projects.ts`|Supported projects, project detection, dev-server pins|
|`src/procs.ts`|`/proc` scan for running `cargo-auto` processes and their owning `omp`|
|`src/tracker.ts`|Job snapshot + shared foreground registry + scan → runs|
|`src/steps.ts`|Pure: runs → one latest outcome per step (tested)|
|`src/status-line.ts`|Status line rendering|
|`src/summary.ts`|Summary entries, the summary window, the picker|

## Rules

- The extension does nothing outside `PROJECTS`: no rewrite, no line, `work_summary` inactive.
- Only the interactive main session rewrites `cargo auto` to background. Subagents and `async: false` stay foreground and report through the shared registry in `tracker.ts`.
- Status line text never enters model context. Only the per-build nudge and `work_summary` calls do.
- Do not touch the active tool set unless it changes; rewriting it invalidates the prompt cache.
- Keep merge logic pure in `steps.ts` and cover it with tests. UI changes need a real TUI run: tests do not count.
- Never run real builds to test. A stub `cargo-auto` script on `PATH` in a throwaway repo, with a webapp `origin`, exercises the full path.

## Commits

Conventional commits. Commit freely; never push without approval.
