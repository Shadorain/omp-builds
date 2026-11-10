# omp-builds

OMP extension for webapp and studio sessions. It moves `cargo auto` builds to the background so the session stays free. A single status line under the editor shows the project's builds and the dev server.

```
 ✓ check • ⚒ test 0:11 Dash • ✗ test@bl-demo-api • ◐ clippy 0:04 other pane  │  dev ● not deployed
```

## Status line

Each step (`check`, `test`, `clippy`, …) shows its latest outcome:

| Icon | Meaning |
|---|---|
| ◐ | running, with elapsed time |
| ⚒ | being fixed by a subagent, with time and fixer name |
| ✓ | passed |
| ✗ | failed |
| ■ | cancelled |

- Each checkout keeps its own steps. A step built outside this session's checkout carries its worktree name, as in `test@bl-demo-api`. Freshness is judged against that worktree's own code.
- A gray step name means the code changed after that result was built.
- `other pane` is a build started by another session in the same repo, including its worktrees. Builds in other repos never show.
- `dev ●` is the dev server. The dot is green while its service runs; a stopped server shows a red dot and `down`. The word says what the server runs compared with this checkout:

| State | Meaning |
|---|---|
| `live` | Serving this checkout as it is now |
| `edits not live` | Serving your last commit; uncommitted edits are not on it |
| `rebuilding` | Rebuilding with your latest commit (studio) |
| `not deployed` | Serving other code; this branch is not on it. webapp dev only runs `origin/v2/backend-rewrite` |
| `unknown` | Cannot tell what it is serving |
| `down` | The service is not running |

`/builds status` repeats this on its last row, with the dev UI's tailnet link (webapp `http://<host>:3000`, studio `https://<host>:7878`; `<host>` from `tailscale status`).

## What it does to the agent

- In the interactive main session, `cargo auto …` runs as a background job with no timeout. The agent is told not to wait or poll, and to send one fixer subagent if the build fails without waiting on it. Its turn ends, so you can keep sending ordinary prompts while builds and fixes run; results and the fixer's report arrive on their own.
- Subagents and `async: false` calls stay in the foreground. Their results still appear on the status line.
- The `work_summary` tool is active only in these projects. The agent uses it to post what it changed and why; build and test status stays on the status line. The summary opens in a window above the editor when the agent stops, and stays until Esc.

## Windows

`/builds status` and the work summary open in a temporary window above the editor, built like `/btw`'s panel. The window takes no focus, so typing still goes to the prompt. Esc closes it, and opening another window replaces it.

## Commands

| Command | Does |
|---|---|
| `/builds status` | Every tracked build: state, steps, who, checkout, how long, when, and whether the code changed since. Last row: the dev server and its link |
| `/builds summary last` | Show the latest work summary |
| `/builds summary` | Pick one of this session's summaries and show it |
| `/builds clear` | Clear finished results from the status line |

## Install

```bash
bun install
ln -sfn "$PWD" ~/.omp/agent/extensions/omp-builds
```

OMP loads extensions when a session starts. Start a new session after changing the code.

## Adding a project

Add an entry to `PROJECTS` in `src/projects.ts`. Each entry needs:
- a name;
- a regex that matches the `origin` URL;
- a function that reports the dev server for a checkout.
