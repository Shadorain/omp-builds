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
|`src/extension.ts`|Event wiring, tick loop, edit tracking for work summaries, `/builds` command|
|`src/projects.ts`|Supported projects, project detection, checkout roots, dev-server pins|
|`src/servers.ts`|systemd + `ss` + `tailscale serve` lookups: project dev servers, ports, tailnet links|
|`src/procs.ts`|`/proc` scan for running `cargo-auto` processes, their owning `omp` or systemd unit|
|`src/tracker.ts`|Job snapshot + shared foreground registry + scan → runs, each with its checkout|
|`src/steps.ts`|Pure: runs → one latest outcome per step and checkout (tested)|
|`src/status-line.ts`|Status line rendering|
|`src/status-view.ts`|`/builds status` rows|
|`src/window.ts`|Temporary window: `OverlayPanel` in the above-editor layout, Esc via raw input|
|`src/summary.ts`|Final-reply extraction, summary window, picker (summaries live in memory only)|

## Rules

- The extension does nothing outside `PROJECTS`: no rewrite, no line, no summary window.
- Only the interactive main session rewrites `cargo auto` to background. Subagents and `async: false` stay foreground and report through the shared registry in `tracker.ts`.
- Status line text never enters model context. Only the per-build nudge does. Work summaries are the agent's own final reply, shown after a turn whose edits (main or subagent) touched the project.
- Keep merge logic pure in `steps.ts` and cover it with tests. UI changes need a real TUI run: tests do not count.
- Never run real builds to test. A stub `cargo-auto` script on `PATH` in a throwaway repo, with a webapp `origin`, exercises the full path.

## Commits

Conventional commits. Commit freely; never push without approval.
