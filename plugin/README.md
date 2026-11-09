# HackathonOne plugin (`h1`)

Claude Code plugin for running a team hackathon on a shared HackathonOne hub (see `../docs/SPEC.md`).

## Install

```
/plugin marketplace add jakinluk/collab1
/plugin install h1@hackathonone
```

Prefer project scope in the repos you hack in. Requirements: Node ≥ 22, `git`, and `gh` (logged in). On macOS the agent token is kept in the Keychain.

## First steps

1. `/h1:network`: check connectivity (`h1 doctor`).
2. Sign in to the board (MFA), then **Tokens & Macs → Connect a Mac**, then `/h1:join`.
3. Link your local checkouts of the project's repos: `h1 repo list`, then `h1 repo link <name> <path>`.
4. Restart Claude Code so the monitor starts.
5. `/h1:board`, then `/h1:autopilot on` or `/h1:work <ticket>`.

## What's inside

| Part | What it does |
|---|---|
| `skills/` | `/h1:network`, `init`, `join`, `project`, `goal`, `plan`, `ticket`, `work`, `review`, `autopilot`, `raise`, `decide`, `share`, `board`, `rules`, `wrap`, `bug`, `update` |
| `bin/h1` | the CLI the skills call (`h1 --help`) |
| `hooks/hooks.json` | session context, file-ownership guard, heartbeats, needs-input, autopilot continuation, release on session end |
| `monitors/monitors.json` | `h1 watch`: hub events delivered to Claude as notifications. It stays silent on machines that haven't joined |
| `templates/` | default blocker rules, repo presets (`nx-monorepo`, `node-app`, `expo-app`), project, goal and plan examples, auto-mode + ask/deny settings |
| `scripts/test-lock.sh` | machine-wide slot lock for heavy test and type-check runs |

Tests: `node --test test/*.test.mjs`.

## Fixing HackathonOne during the event

- **Report:** `/h1:bug "what went wrong"` (or `h1 bug … --area plugin|board|backend|docs [--urgent]`) files a ticket in the **HackathonOne fixes** project. Whoever pins to `hackathonone` fixes it through the normal ticket → review → merge flow, in the HackathonOne repo.
- **Ship:** backend and board fixes reach everyone with the next deploy. Plugin fixes need a release: bump `version` in `plugin/.claude-plugin/plugin.json` (Claude Code only ships a plugin whose version changed), merge, then publish it in the board (**Settings → HackathonOne releases**) or with `h1 release propose --version x.y.z --notes "…"`. Set a minimum version only for changes old Macs must not miss: below it, agents can read but not change anything.
- **Receive:** every Mac's monitor prints `[h1] UPDATE …` and new sessions say so at start. Run `/h1:update`, then `/reload-plugins`. With auto-update on for the marketplace (`/plugin` → Marketplaces → hackathonone → Enable auto-update), Claude Code fetches it in the background; `/reload-plugins` still loads it into running sessions.

## Repo metadata and the guard

Each project repo declares its base and integration branches, **hot paths** and **contract paths**, setup and verify commands, an instructions file and notes (see `templates/project.example.json`). The guard hook works out which repo you're in from your local links or from the git remote. It blocks edits to that repo's hot paths, to its contract paths (unless your ticket is a contract or glue ticket), and to other tickets' files. If the repo can't be identified, hot paths are not enforced unless you set `H1_GUARD_FALLBACK=nx-monorepo`.
