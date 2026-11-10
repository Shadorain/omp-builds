# omp-builds

OMP extension: backgrounds build commands, shows a build and dev-server status line. Bun + TypeScript, no build step; `index.ts` re-exports `src/extension.ts`. Config: `<agentDir>/omp-builds.json`, schema in `src/config.ts`.

```bash
bun test
bun run typecheck   # tsc; wrap in memcap on capped hosts
bun run format      # before every commit
bun run screens     # after UI changes, recapture docs/screens/
```

## Rules

- Pure logic (`src/steps.ts`, `src/config.ts`) gets behavior tests. UI changes need a real TUI run (`bun run screens --text` or a pty), not tests.
- Never run real builds or touch real repos to test: a throwaway `/tmp` repo with a stub build command on `PATH`.
- Status line text never enters model context; only the per-build nudge does.
- OMP loads extensions at session start: restart to pick up changes.
- Conventional commits. Never push without approval.
