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
- `other pane` is a build started by another session in the same repo, including its worktrees. Builds in other repos never show. A build run by a systemd unit instead of a session carries the unit's name, e.g. `◐ build 3:10 studio-dev` while the studio dev server redeploys.
- `dev ●` is the shared dev server (`webapp-dev`, `studio`). The dot is green while its service runs; a stopped server shows a red dot and `down`. The word says what the server runs compared with this checkout:

| State | Meaning |
|---|---|
| `live` | Serving this checkout as it is now |
| `edits not live` | Serving your last commit; uncommitted edits are not on it |
| `rebuilding 3:12` | studio only: `studio-dev.service` is redeploying your latest commit; the old build serves until it finishes. Not a build of this session |
| `behind` | studio only: serving an older build of this checkout and no redeploy is running; run `deploy/dev-deploy` |
| `not deployed` | Serving other code; this branch is not on it. webapp dev only runs `origin/v2/backend-rewrite` |
| `unknown` | Cannot tell what it is serving |
| `down` | The service is not running |

- Other servers: any running user service named `<project>*` (e.g. `webapp-refresh-3001`, made with `systemd-run --user --unit …`) whose working directory is inside one of the project's checkouts and that listens on a port. One running from this checkout adds `• :3001 ●` after the dev chip.

`/builds status` lists them on its last rows: the dev server, then every other server with its tailnet link and the checkout it runs from. Links use the host's MagicDNS name: `https://` when `tailscale serve` fronts the port, else `http://` for ports not bound to loopback.

## What it does to the agent

- In the interactive main session, `cargo auto …` runs as a background job with no timeout. The agent is told not to wait or poll, and to send one fixer subagent if the build fails without waiting on it. Its turn ends, so you can keep sending ordinary prompts while builds and fixes run; results and the fixer's report arrive on their own.
- Subagents and `async: false` calls stay in the foreground. Their results still appear on the status line.
- After a turn that changed code (here or in a subagent), the agent's final reply opens as the work summary in a window above the editor, rendered as markdown. It is sticky: it stays while you type, send prompts and ask questions, until a newer summary replaces it or you press Esc. While it is up, a reply the agent makes on its own (a build or fixer reporting in) replaces it, so it never goes stale. A reply too tall for the window is cut, with the rest in the chat.

## Windows

`/builds status` and the work summary open in a temporary window above the editor, built like `/btw`'s panel. The window takes no focus, so typing still goes to the prompt. Esc closes it, and opening another window replaces it. Esc on `/builds status` brings back the summary it covered.

## Commands

| Command | Does |
|---|---|
| `/builds status` | Every tracked build: state, steps, who, checkout, how long, when, and whether the code changed since. Last row: the dev server and its link |
| `/builds summary last` | Show the latest work summary |
| `/builds summary` | Pick any summary from this session, across every branch of its tree, and show it |
| `/builds clear` | Clear finished results from the status line |

## Install

```bash
bun install
ln -sfn "$PWD" ~/.omp/agent/extensions/omp-builds
```

OMP loads extensions when a session starts. Start a new session after changing the code.

## Adding a project

Add an entry to `PROJECTS` in `src/projects.ts`. Each entry needs:
- a name, which also prefixes the systemd units searched for extra servers;
- a regex that matches the `origin` URL;
- the shared dev server's unit;
- a function that reports what that server runs compared with a checkout.
