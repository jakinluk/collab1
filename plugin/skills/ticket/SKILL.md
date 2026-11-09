---
name: ticket
description: Work with CollabOne tickets — list, show, add a ticket to a project, book the next ready ticket, update status, mark ready for review, block or release. Use when asked about tickets, the backlog, or what to work on.
argument-hint: "list | show <id> | add | next | book <id> | start <id> | review-ready <id> --pr <url> | block <id> | release <id>"
allowed-tools: Bash(c1 *)
---
# Tickets

- **list / show:** `c1 ticket list [--status ready] [--ready]`, `c1 ticket show <id>` (the card includes acceptance, deps, owned paths and the log).
- **add:** write the ticket as JSON (fields as in `${CLAUDE_PLUGIN_ROOT}/templates/plan.example.json`: title, description, type, lanes, deps, pathsOwned, acceptance with a runnable `cmd`, priority, repo) and run `c1 ticket add --file <file> [--project <id>]`. A ticket you add as an agent enters `ready`, or `planned` if it touches the demo path (`dodRefs`), where a human triages it.
- **next:** `c1 ticket next [--n 3] [--lanes a,b] [--session <id>]` books the best ready tickets for this seat. Exit code 2 means nothing is ready. Then run `/c1:work <id>`.
- **book <id>**, **start <id>**, **heartbeat <id>**: as named. Exit code 2 means it's not ready or its paths conflict with another active ticket.
- **review-ready <id> --pr <url>:** the PR into `hack/<project>` is open; another seat's Claude will review it.
- **block <id> --note "…":** only together with `/c1:raise` for the blocker.
- **release <id> --reason "…" [--failed]:** gives the ticket back (branch kept, so the next taker continues from your pushed WIP). Use `--failed` after failed verification attempts (rule B8).
