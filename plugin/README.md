# CollabOne plugin (`c1`)

Claude Code plugin for people and their Claude Code agents working on shared projects through a CollabOne hub (see `../docs/SPEC.md`). Its first mode, and the one this version is built for, is a team hackathon.

## Install

```
/plugin marketplace add jakinluk/collab1
/plugin install c1@collabone
```

Prefer project scope in the repos you hack in. Requirements: Node ≥ 22, `git`, and `gh` (logged in). On macOS the agent token is kept in the Keychain.

## First steps

1. `/c1:network`: check connectivity (`c1 doctor`).
2. Sign in to the board (MFA), then **Tokens & Macs → Connect a Mac**, then `/c1:join`.
3. Link your local checkouts of the project's repos: `c1 repo list`, then `c1 repo link <name> <path>`.
4. Restart Claude Code so the monitor starts.
5. `/c1:board`, then `/c1:autopilot on` or `/c1:work <ticket>`.

## What's inside

| Part | What it does |
|---|---|
| `skills/` | `/c1:network`, `init`, `join`, `project`, `goal`, `plan`, `ticket`, `work`, `review`, `autopilot`, `raise`, `decide`, `share`, `board`, `rules`, `wrap`, `bug`, `update` |
| `bin/c1` | the CLI the skills call (`c1 --help`) |
| `hooks/hooks.json` | session context, file-ownership guard, heartbeats, needs-input, autopilot continuation, release on session end |
| `monitors/monitors.json` | `c1 watch`: hub events delivered to Claude as notifications. It stays silent on machines that haven't joined |
| `templates/` | default blocker rules, repo presets (`nx-monorepo`, `node-app`, `expo-app`), project, goal and plan examples, auto-mode + ask/deny settings |
| `scripts/test-lock.sh` | machine-wide slot lock for heavy test and type-check runs |

Tests: `node --test test/*.test.mjs`.

## Fixing CollabOne during the event

- **Report:** `/c1:bug "what went wrong"` (or `c1 bug … --area plugin|board|backend|docs [--urgent]`) files a ticket in the **CollabOne fixes** project. Whoever pins to `collabone` fixes it through the normal ticket → review → merge flow, in the CollabOne repo.
- **Ship:** backend and board fixes reach everyone with the next deploy. Plugin fixes need a release: bump `version` in `plugin/.claude-plugin/plugin.json` (Claude Code only ships a plugin whose version changed), merge, then publish it in the board (**Settings → CollabOne releases**) or with `c1 release propose --version x.y.z --notes "…"`. Set a minimum version only for changes old Macs must not miss: below it, agents can read but not change anything.
- **Receive:** every Mac's monitor prints `[c1] UPDATE …` and new sessions say so at start. Run `/c1:update`, then `/reload-plugins`. With auto-update on for the marketplace (`/plugin` → Marketplaces → collabone → Enable auto-update), Claude Code fetches it in the background; `/reload-plugins` still loads it into running sessions.

## Repo metadata and the guard

Each project repo declares its base and integration branches, **hot paths** and **contract paths**, setup and verify commands, an instructions file and notes (see `templates/project.example.json`). The guard hook works out which repo you're in from your local links or from the git remote. It blocks edits to that repo's hot paths, to its contract paths (unless your ticket is a contract or glue ticket), and to other tickets' files. If the repo can't be identified, hot paths are not enforced unless you set `C1_GUARD_FALLBACK=nx-monorepo`.
