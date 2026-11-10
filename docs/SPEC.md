# CollabOne: people and Claude Code agents working on shared projects

**First mode: the hackathon.** CollabOne's first use case is a time-boxed team hackathon, and this spec describes that **event mode**: an end date after which data and tokens expire, project phases (plan, build, freeze, demo), and a teardown at the end. An **ongoing mode** for everyday team work is built alongside it and described in `docs/ONGOING.md`. Nothing here depends on the event being a hackathon except those event-mode rules.

Status: design spec, first written 2026-11-04 and revised 2026-11-09 (renamed from HackathonOne to CollabOne with the hackathon as its first mode; local end-to-end runs; sweep on EventBridge Scheduler; fix queue and plugin releases in §8.5).
- **Current design:** cloud-only serverless hub (D14), multi-project (§4.1), decisions D1–D14 recorded in §0.1. D2 is still open.
- **Facts checked:** Claude Code facts against the official docs on 2026-11-04. AWS facts on 2026-11-05.
- **Re-check before the offsite:** channels and plugin monitors are research preview / experimental, so check them again in the week before.
- **Basis:** this design grew out of a simpler coordinator, "hackboard", and reuses its ticket model, ownership guard, test lock and compliance rules P1–P7 (`docs/SECURITY.md`).
- There are deliberately **no time or effort estimates** here.
- **Implementation contract** (API routes, channels, table keys, CLI commands): `docs/CONTRACT.md` in the `collab1` repo.

---

## 0. TL;DR

- **CollabOne** (`c1` plugin) turns team work with Claude Code into shared skills, backed by a small **serverless hub** in a sandbox AWS account. In its first mode it runs a hackathon. The hub uses:
  - API Gateway HTTP API + Lambda;
  - a DynamoDB single table;
  - AppSync Events for push;
  - Cognito for human logins;
  - S3 + CloudFront for the board, with optional WAF (`-c waf=on`).

  There is no laptop host and no local storage. Everyone only needs internet, which Claude Code needs anyway.
- **Each participant's Claude Code** gets a bundled `c1` CLI for **pull** (book tickets, raise blockers, vote, share skills). A plugin **monitor** (`c1 watch`) gives **push**: it subscribes to AppSync Events and prints one-line events, which reach Claude as notifications.
- **The board** is a web app on CloudFront. It shows all projects, the goal and definition of done, kanban columns, the Blocked lane, "Needs a human", votes, people and usage, shared knowledge, the event log, and an editable rules table. It has dark, light and projector modes.
- **Everything is an ordered event log** in DynamoDB. Clients catch up from their last sequence number, so missed pushes don't matter.
- **Autonomy by default.** Humans create projects, set goals, approve generated plans, add tickets, and answer only what the **blocker rules table** routes to them. `/c1:autopilot` loops: book, build, verify, PR, cross-review, next.
- **Two credentials per seat.** An **agent token** (CLI, Claude, factory workers) can only *propose* human actions. A **human session** (Cognito login with MFA, in the board) approves them. Claude can't act as a human.
- **Open floor (D10):** everyone sees every project's blockers and votes, and any human can resolve a human-routed item. Others can contest it within a short window, which turns it into a human vote.
- **Several projects (D13)**, each with its own goal, repos, integration branch, tickets, votes and rule overrides. People are pinned to one project for booking only.

### 0.1 Decisions recorded

| # | Question | Decision | Where it lands |
|---|---|---|---|
| D1 | Where the board lives | ~~Host laptop + cloud backup~~ → **superseded by D14** | §2 |
| D2 | How news reaches each Claude | **Open.** Working default: plugin monitor subscribed to AppSync Events, with automatic fall-back to between-task checks. A two-way channel can be added later | §2.1, §8.4 |
| D3 | Network plan | **Simplified by D14:** any network with internet (venue Wi-Fi). An iPhone hotspot is the fallback for captive portals or networks that block WebSockets. No LAN discovery, no travel router needed | §11 |
| D4 | Autonomy | **Full autopilot; people only for escalations** | §9 |
| D5 | Review and merge | **Another participant's Claude reviews and merges** | §8.1 |
| D6 | Technical votes | **Claude votes first with a reason; its human can override until the deadline** | §7 |
| D7 | Starting rules | **The default rows**, with D10's change to who resolves human-routed rows | §5 |
| D8 | Sessions per person | **Each participant's own choice:** solo, sub-agents, several sessions, or their own "factory". No cap from the host | §9.3 |
| D9 | Low usage | **No cap.** Everyone is on a high-usage plan. Usage bars are for visibility only | §9.2, §15 |
| D10 | Final say on scope | **Open floor:** everyone sees all blockers across all projects, and any human can decide | §5, §7, §10 |
| D11 | Build before the offsite | **The full version, built as a warm-up mini-hackathon** | §14 |
| D12 | Command names | **Short: `/c1:…`** | §8 |
| D13 | Projects | **Several projects on one hub; each person pinned to one project.** Pinning limits what autopilot books, not what anyone can see or decide | §4.1 |
| D14 | Hosting | **Cloud only, serverless:** Lambda + DynamoDB + AppSync Events + Cognito + CloudFront (WAF optional) in the AWS sandbox account. No local storage. "It must be as safe" as the LAN design: see §2.3 | §2 |

---

## 1. What changes compared with hackboard (the simpler coordinator)

| | Hackboard | CollabOne |
|---|---|---|
| Coordinator | Lambda + DynamoDB, or Node + SQLite on a laptop | Serverless hub in the AWS sandbox (D14) |
| How work reaches sessions | Pull only (`curl`, HTTP hooks) | Pull through the `c1` CLI, **push** through a plugin monitor on AppSync Events |
| Messaging | Slack webhook | Event log relayed into every live session, plus macOS notifications for humans |
| Knowledge sharing | — | Tips, playbooks and **temporary skills** that sync into everyone's Claude Code live |
| Blockers | `/hack:blocked` → integrator | Typed escalations matched against an **editable blocker rules table** |
| Decisions | Integrator decides | Quorum votes with deadlines and defaults; open floor for human-routed items |
| Human role | Integrator merges and supervises | Humans create projects, set goals, approve plans, add tickets and resolve escalations. Agents cross-review and merge |
| Projects | One idea per event | Several projects on one hub |
| Kept as is | — | Ticket fields (deps, `pathsOwned`, acceptance commands), the PreToolUse ownership guard, `test-lock.sh`, PRs into an integration branch (`hack/<project>`), compliance rules P1–P7 |

---

## 2. Architecture

```
┌──────────────────── AWS sandbox account · CDK stack "c1" ─────────────────────┐
│  CloudFront (+WAF) ┬─ /            → S3 board (static SPA, OAC)               │
│                    └─ /api/v1/*    → API Gateway HTTP API (origin-verify hdr) │
│                                         │  Lambda authorizer: agent token |   │
│                                         │  Cognito ID token (human)           │
│                                         ▼                                     │
│                                   Lambda "api" (all routes, zod-validated)    │
│                                         │ TransactWriteItems                  │
│                                         ▼                                     │
│                   DynamoDB "c1" (state + ordered event log, Streams, TTL)     │
│                                         │ stream (PK = EVENT)                 │
│                                         ▼                                     │
│                   Lambda "fanout" ── SigV4 publish ──► AppSync Events "c1"     │
│  Scheduler (1 or 5 min) → Lambda "sweep": leases, deadlines, contest windows  │
│  Cognito user pool (invite-only, MFA) · Secrets Manager · S3 skills bucket    │
└───────────────────────────────────────────────────────────────────────────────┘
        ▲ HTTPS: commands                         ▲ WSS: subscribe /c1/...
┌─────────── each participant's MacBook (own Claude login) ─────────────────────┐
│ Claude Code session(s) + plugin c1                                            │
│   skills /c1:*  → `c1` CLI (plugin bin/)  → HTTPS API with the agent token    │
│   monitor `c1 watch` → AppSync Events subscription → notifications to Claude  │
│   hooks: SessionStart · PreToolUse guard · PostToolUse heartbeat · Stop       │
│   agent token in the macOS Keychain · ~/.c1/config.json                       │
│ Browser: the board (Cognito login + MFA) — the only place human actions run   │
└───────────────────────────────────────────────────────────────────────────────┘
                      code: git worktrees → PRs into hack/<project> on GitHub
```

### 2.1 Push: monitor first, channel as an upgrade

- **Plugin monitors:** a monitor is "a shell command that runs in the background for the whole session. What it prints reaches Claude as notifications, so Claude can react to a log or a status change without being asked to watch it."
  - Limits: interactive sessions only (never with `-p`), no `${user_config.*}`, and the manifest key is `experimental.monitors`.
  - `c1 watch` keeps one AppSync Events WebSocket open and prints one short line per relevant event.
- **AppSync Events instead of API Gateway WebSockets:**
  - API Gateway WebSocket connections are limited to 2 hours and drop after 10 idle minutes, and those quotas can't be raised. They also need a connection table.
  - AppSync Events connections can stay open up to 24 hours and need no connection table. Clients subscribe with a Lambda authorizer, and only the fan-out Lambda can publish (IAM).
  - Delivery isn't confirmed, so every client catches up from the ordered event log (`GET /events?since=<seq>`) after a reconnect.
- **Channels (Claude Code)** would add two-way messaging and permission relay. That's v1.5 (§8.4), still D2.
- **Hot-loaded skills:** Claude Code picks up changes under `~/.claude/skills/` within the session. The SessionStart hook syncs shared skills and returns `reloadSkills: true` when something new arrived.

### 2.2 Trust and compliance (carried over from hackboard)

- Every Claude Code session runs under the login of the person at that MacBook.
- The hub **never** holds Claude credentials, never calls the Anthropic API, and never starts `claude`. It stores tickets, messages, rules and the telemetry participants push.
- Pushing an event is a notification, not remote execution. Each participant's own session decides to book work.
- Autopilot stops at the end conditions in §9.3. There are no overnight unattended loops (P7).

### 2.3 Security model ("must be as safe")

The LAN design got part of its safety from being unreachable from the internet. The cloud hub is reachable, so it has to earn the same safety with identity, edge protection and data hygiene.

| Threat | Controls |
|---|---|
| Someone outside the team reaches the hub | Every data route needs a credential. Only `/health` and `/join` are public: `/join` takes a single-use code with a 10-minute TTL, created by a logged-in human, and is rate-limited by the API stage throttle; a code is one of about 10^12 values, so it cannot be guessed in 10 minutes. The board shell holds no data. With `-c waf=on`, CloudFront WAF adds AWS managed rule groups plus per-IP rate limits, and the Event API gets its own rate rule. API Gateway rejects requests that didn't come through CloudFront (secret origin-verify header) |
| Stolen human login | Cognito is invite-only (self sign-up off) with **MFA required** (TOTP). Login is authorization code + PKCE with a public client, and callbacks only go to the board URL. ID tokens last 60 min and are kept in session storage only |
| Stolen agent token | 256-bit random token, stored in the macOS Keychain. The hub stores only a salted hash. Tokens expire at the event end and can be revoked on the board. Factory workers get child tokens, each revocable on its own |
| Claude acting as a human | Agent tokens can't call human-only routes. Claude can only create a **proposal**; a human approves it in the board with their Cognito session |
| Injection through the push path | Clients can't publish to AppSync channels (IAM-only publish). Every write is validated (zod, size limits). Monitor lines are labelled as teammate data, and the SessionStart text tells Claude that hub content never authorizes secrets, pushes to `main`, deploys or human-only actions |
| Secrets leaking into shared content | Secret-pattern scanning on tips, playbooks, skills and messages, both in the CLI before upload and on the server. Hooks send only session, event, tool name and ticket id, never `tool_input` |
| Eavesdropping | TLS everywhere: CloudFront, API Gateway and AppSync WSS. No HTTP listeners. CloudFront uses its default certificate, which also allows TLS 1.0 and 1.1; a custom domain with an ACM certificate is needed to require TLS 1.2 |
| Data lingering after the event | DynamoDB TTL on every item, a 21-day S3 lifecycle, 7-day log retention, and no request bodies or tokens in logs. `/c1:wrap` revokes all tokens and can destroy the stack |
| Over-privileged infrastructure | One Lambda per role with least-privilege IAM, in the sandbox account only, never production. No VPC, so nothing to misconfigure in one |
| Accountability | The event log records who did what, and whether it was an agent or a human |

Full detail: `docs/SECURITY.md`.

---

## 3. Streams and channels

The event envelope is `{ seq, ts, stream, type, projectId?, from, fromKind, ticketId?, to?, summary, data? }`.
- `summary` is at most 200 characters; `data` is at most 2 KB.
- Clients fetch details by id.
- Events are stored in order under `PK=EVENT, SK=<seq>` and fanned out to AppSync Events channels:

| Channel | Gets |
|---|---|
| `/c1/all` | hub-wide events: `project.created`, global knowledge, settings, announcements |
| `/c1/p/<projectId>` | everything scoped to that project: tickets, escalations, decisions, goal, phase, rule overrides |
| `/c1/s/<seatId>` | DMs, outcomes of that seat's proposals, review results for its tickets |

The board and `c1 watch` both subscribe to `/c1/all`, `/c1/p/*` and their own `/c1/s/<seatId>`. The monitor then keeps only what concerns its pinned project and seat, so re-pinning needs no resubscribe.

| Stream | Typical events | What `c1 watch` prints |
|---|---|---|
| `tasks` | `ticket.added/ready/booked/status/pr/review_needed/done/released` | newly ready tickets in my lanes and project; changes to my tickets and their dependencies |
| `knowledge` | `tip.shared`, `playbook.shared`, `skill.published/updated/retired` | one-line notice; skills auto-sync |
| `escalations` | `blocker.raised`, `issue.raised`, `urgent.raised`, `help.requested`, `escalation.resolved/contested` | items routed to me or to humans |
| `decisions` | `decision.opened`, `vote.cast`, `decision.made/defaulted` | "vote needed" when I'm eligible; outcomes |
| `broadcast` | `project.created`, `goal.set/updated`, `rules.updated`, `phase.changed`, `announce` | always |
| `presence` | `session.*`, `usage` | board only |
| `dm` | `message` | mine only |

Example monitor output:

```
[c1] T12 ready (mobile) "Offline cache for jobs list" — you're idle → /c1:ticket next
[c1] VOTE D7 needed by 14:14 "Add syncState to NoteDraft?" (agent quorum) → /c1:decide D7
[c1] SKILL c1-run-ios-sim v2 published by Ania → synced; use it before figuring builds out yourself
[c1] RULES v4: B3 max_attempts 3→2
```

Items that need a human also raise a macOS notification.

---

## 4. Data model

Domain types, extending hackboard's: Project, Goal (versioned per project), Ticket (with `projectId`, `repo`, `booking`, `review`, `dodRefs`), Seat (`workMode`, `pinned`, `projects`), BlockerRule, Escalation, Decision, KnowledgeItem, Proposal, Envelope. Exact shapes: `docs/CONTRACT.md` §3.

**Storage:** one DynamoDB table with streams and TTL.
- Settings, counters and default rules live under `PK=HUB`. Seats, tokens (hashed), join codes (hashed), projects (with goal versions and rule overrides), tickets, path locks, escalations, decisions, knowledge items and proposals each get their own partition.
- The event log sits under `PK=EVENT`. GSI1 serves the per-project and per-status lists.

**Booking and ordering (replacing SQLite's single writer):**
- Booking a ticket is one `TransactWriteItems`:
  - the ticket update, conditioned on `status = ready` and its version;
  - one **lock item per owned path prefix**, put only if it doesn't exist (after checking ancestor and descendant prefixes);
  - the event counter advance;
  - the event item.
- Two agents can never hold overlapping files, and every event gets a gap-free sequence number.
- Conflicts retry up to three times, then return 409.

### 4.1 Multiple projects on one hub

| Concern | Rule |
|---|---|
| Scoping | Every ticket, escalation and decision carries a `projectId`. Readiness, dependencies and path locks are per project and repo. Cross-project dependencies are allowed but shown in red |
| Membership | `/c1:join` picks the project; `c1 me pin <pid>` moves a seat (its bookings in the old project are released first). By default a seat is pinned: autopilot only books from its project |
| Goal and decisions | One goal per project. No goal owner (D10): any human can resolve human-routed items in any project |
| Visibility | Pinning affects only booking. Everyone sees every project's board, blockers and decisions |
| Votes | Electorates resolve within the project. A decision without a project is hub-wide |
| Rules | The hub-wide table (§5) is the default. Projects override single rows |
| Knowledge | Global by default; it can be limited to a project |
| Code | Each repo of a project has an integration branch `hack/<project>`, cut from its base branch. Ticket branches are `hack/<project>/<ticket>-<slug>` |
| Repo metadata (v0.2) | Per repo: base and integration branch, **hot paths** (only contract or glue tickets may touch them) and **contract paths**, setup and verify commands, instructions file, folder → lane map, PR labels and notes for agents. Presets: `nx-monorepo`, `node-app`, `expo-app`. The hub rejects plans whose build tickets own hot or contract paths. The guard hook protects exactly the ticket repo's paths |
| Project metadata (v0.2) | Description, demo (URL, stage, notes), links (Slack channel, designs, PRD) and tags, shown on the board |
| Local checkouts | Each Mac maps repo names to folders in `~/.c1/repos.json` (`c1 repo link`), never sent to the hub. The CLI can also match a checkout by its git remote |
| Board | **All projects** strip at the top; each project opens its own columns |
| Commands | `/c1:project` creates and manages projects. `/c1:goal`, `/c1:plan` and `/c1:ticket add` are always scoped to one project: the pinned one by default, or `--project` |

---

## 5. Blocker rules table (editable live)

The table is the contract for when an agent may stop and ask.
- It lives on the hub, versioned, and is edited on the board's Rules tab (a human action) or proposed with `/c1:rules`.
- Each edit emits `rules.updated`. Sessions get the digest at SessionStart and on each update.
- An agent that hits a problem **must** classify it against this table. If no row matches, it decides itself and logs the decision.

**Columns:** `code` · `name` · `trigger` · `severity` (P0–P3) · `resolver` (`self` | `any_agent` | `owner` | `agent_quorum` | `any_human` | `human_quorum` | `human_named`) · `quorumRule` · `timeout` · `contest window` · `defaultOnTimeout` · `stopScope` · `maxAttempts` · `notify`. `any_human` is the open-floor resolver (D10).

| code | name | trigger | sev | resolver | quorum / timeout → default | stop scope | max attempts |
|---|---|---|---|---|---|---|---|
| B1 | Contract change | Needs to change a shared interface, schema, event or API another ticket uses | P1 | agent_quorum (affected seats) | majority, 10 min → keep the contract, add an adapter on your side | dependents | — |
| B2 | Outside owned paths | Needs to edit a file outside `pathsOwned` | P2 | owner of that path or ticket | owner OK, 5 min → open a `glue` ticket, continue with a stub | ticket | — |
| B3 | Env / tooling broken | Simulator, build, emulator, deploy, CI or local service won't work | P2 | any_agent (`help.requested`), then any_human | first answer wins, 10 min → any_human | ticket | 2 |
| B4 | Ambiguous requirement | Unclear acceptance **and** the choice changes user-visible behaviour on the demo path | P2 | any_human (contest 5 min) | 10 min → simplest option that satisfies the demo script, logged as an assumption | ticket | — |
| B5 | Scope / goal change | Ticket can't be done as specified, or the goal / definition of done needs to change | P1 | any_human (contest 10 min → human_quorum) | 15 min → cut the ticket, keep the goal | dependents | — |
| B6 | Secrets / access / money | Needs credentials, paid services, production data or third-party accounts | P0 | any_human who has the access | no timeout → wait (ticket parked, agent takes other work) | ticket | 0 |
| B7 | Destructive / irreversible | Deleting data, force push, rewriting shared history, deploying to a shared or production environment | P0 | any_human (contest 5 min before it runs) | no timeout → do not do it | all (that action only) | 0 |
| B8 | Stuck | `maxAttempts` failed verification cycles, or no progress since the last checkpoint | P2 | self → any_agent | auto: release with notes; next taker continues from pushed WIP; second time → B5 | ticket | 3 |
| B9 | Disagreement / conflict | Two agents' work conflicts | P1 | agent_quorum (involved seats + one neutral) | majority, 10 min → the ticket earlier in the dependency order wins | dependents | — |
| U1 | Urgent: branch red | Integration branch fails type-check, tests or smoke | P0 | any_agent (first to book the fix) | → revert the offending PR | all merges | — |

**Non-blockers** (decide yourself, add a log line, keep going):
- N1: naming, layout, style, test approach, choosing between libraries already in the repo, UI details not in the demo script.
- N2: follow-up tickets. Agent-created tickets enter `planned` and become `ready` automatically unless they touch the demo path. Those need a human to triage them in the board.

---

## 6. Knowledge and temporary skill sharing

1. **Tip:** one or two lines, pushed to everyone and searchable with `c1 kb search`.
2. **Playbook:** a markdown procedure, fetched on demand.
3. **Shared skill:**
   - Uploaded as a `.tar.gz` (≤ 2 MB) through a pre-signed S3 URL and announced as `skill.published`.
   - Every `c1 watch` downloads it into `~/.claude/skills/c1--<name>/`, where Claude Code picks it up live.
   - Archives with absolute paths or `..` are rejected. Retiring a skill deletes it everywhere, and `/c1:wrap` removes all `c1--*` skills.

**Mobile-app example.** The first agent that gets "build the app, boot the iOS Simulator, run the e2e flow" working writes `c1-run-ios-sim` and publishes it. From then on every agent uses it, so runs stay consistent across machines.

**Sharing rules:**
- Resolving a B3 requires a tip or skill before the escalation can close.
- After each ticket, autopilot shares any procedure that took more than one attempt.
- Secret scanning runs both client-side and server-side.

---

## 7. Quorum decisions and the open floor

- **Seats:** one per participant. The seat's agent casts a provisional vote with a reason. Its human can override it on the board or with `/c1:decide` until the deadline.
- **Electorate** comes from the rule row. `affected_seats` means the owners of dependent or blocked tickets.
- **Outcome:** quorum is reached under the rule (majority / two-thirds / unanimous / consent), or the deadline passes and the default applies (`decision.defaulted`). Parked tickets unblock automatically.
- **Open floor (D10):**
  - Every participant sees every open item across all projects.
  - The first human answer resolves an `any_human` item, with name and reason broadcast.
  - Anyone can **contest** within the row's window, which opens a short human vote. Until then the affected tickets stay parked, and for B7 the action itself waits.
  - The sweep finalizes windows that pass without a contest.
- **Joint resolution** (`help.requested`): idle agents can book it like a ticket. If nobody books it before the rule's timeout, it goes to humans.

---

## 8. Plugin components

### 8.1 Skills

| Skill | Who | What it does |
|---|---|---|
| `/c1:network` | Everyone, first | Connectivity procedure and `c1 doctor` checks (§11) |
| `/c1:init` | Organizer, once | Deploys the CDK stack (or checks it), invites participants, opens the board, creates the first project |
| `/c1:join` | Every participant | Log into the board (MFA), create a join code in Tokens & Macs, then `c1 join --code`. Pick project, lanes and work mode; install the event permission settings (with consent); start the monitor |
| `/c1:project` | Human (proposal) | `new` (name, repos, lanes; creates the `hack/<project>` branches with git/gh, then proposes `project.create`), `list`, `edit`, `pin`, `freeze`/`archive` |
| `/c1:goal` | Human (proposal) | Drafts the project's goal, definition of done, demo script and non-goals with the human, then proposes `goal.set`. Changing an existing goal is a B5 with a contest window |
| `/c1:plan` | Human approves | Breaks the goal into tickets (contracts first, disjoint `pathsOwned`, runnable acceptance commands, waves) and proposes `plan.load` |
| `/c1:ticket` | Anyone | `add`, `next`, `book`, `start`, `review-ready`, `block`, `release`, `show`, `list` |
| `/c1:work <id>` | Agent | One ticket end to end in a worktree on `hack/<project>/<id>-<slug>`: contracts are read-only, WIP is pushed, acceptance commands run through `test-lock.sh`, then rebase, PR and status |
| `/c1:review <id>` | Agent, never the author seat | Reviews the PR against acceptance and the repo's rules, then squash-merges into `hack/<project>` or requests changes |
| `/c1:autopilot` | Each participant | The loop in §9.2 |
| `/c1:raise` | Agent or human | Classify against the rules, attach context and options, raise it |
| `/c1:decide` | Agent or human | List, vote, override |
| `/c1:share` | Agent or human | Tip, playbook or skill (§6) |
| `/c1:board` | Anyone | Compact terminal board + board URL |
| `/c1:rules` | Human (proposal) | Show, or propose rule changes |
| `/c1:wrap` | Organizer | Freeze, demo checklist, export the event log, harvest follow-ups, retire `c1--*` skills, revoke tokens, optionally destroy the stack |
| `/c1:bug` | Agent or human | Report a problem with CollabOne itself into the fix queue (§8.5) |
| `/c1:update` | Human | Update the plugin to the announced release through Claude Code's plugin manager (§8.5) |

- Setup skills that change shared state (`init`, `project`, `goal`, `plan`, `rules`, `wrap`) use `disable-model-invocation: true`.
- Their hub writes go through **proposals** that a human approves in the board.
- `allowed-tools: Bash(c1 *)` pre-approves the CLI.

### 8.2 `c1` CLI

- A zero-dependency Node ≥ 22 script in the plugin's `bin/`, on the Bash tool's `PATH` while the plugin is enabled.
- Talks to `https://<board-domain>/api/v1` with the agent token from the Keychain, and to AppSync Events over WSS.
- Commands: `docs/CONTRACT.md` §10.

### 8.3 Hooks and monitor

```
SessionStart  → c1 hook session-start   identity, project, goal, my tickets, rules digest, trust note; syncs skills (reloadSkills)
PreToolUse    → c1 hook guard           Edit|Write|NotebookEdit: pathsOwned / other tickets / hot paths
PostToolUse   → c1 hook heartbeat       lease + presence, throttled; never blocks
Notification  → c1 hook needs-input     board shows "needs input"; macOS notification
Stop          → c1 hook autopilot-stop  §9.2
SessionEnd    → c1 hook session-end     releases this session's bookings unless in review
monitor       → c1 watch                AppSync Events subscription → one-line events (experimental.monitors)
```

The monitor sleeps quietly until `~/.c1/config.json` exists, so the plugin is harmless in other projects. Enable it at project scope in the hackathon repos.

### 8.4 v1.5: two-way channel

Expose the hub as a Claude Code channel (`claude/channel` + `claude/channel/permission` + a reply tool). Teammates could then message an agent directly, and permission prompts would relay to the board.

Until the channel is allowlisted:
- every session starts with `--dangerously-load-development-channels plugin:c1@collabone`;
- on a claude.ai Team or Enterprise org, an admin must turn channels on.

Ship v1 without it (D2 open).

### 8.5 Fixing CollabOne during the event

The tool will have bugs on the day, so fixing it uses the same machinery as the product work.

- **Fix queue.** `/c1:bug "…"` (from any session, agent or human) files a ticket in a built-in project, `collabone` ("CollabOne fixes"). The hub creates it on first use, pointing at the CollabOne repo (`toolRepoUrl`, set at deploy or in the board's Settings). Each report names an area (`plugin`, `board`, `backend`, `docs`) that decides which repo paths the ticket owns and which tests prove the fix; `--urgent` puts it first. One or two people pin to `collabone` and their agents fix the tool through the normal ticket → review → merge flow.
- **Backend and board fixes** reach everyone with one deploy. Open boards show a "reload" banner when a release is announced.
- **Plugin fixes** live on every Mac, so they ship as a **release**: bump `version` in `plugin/.claude-plugin/plugin.json` (Claude Code only updates a plugin whose version changed), merge, then publish the release in the board (Settings → CollabOne releases) or propose it with `c1 release propose`. The hub announces it with `tool.released`: every monitor prints `[c1] UPDATE …`, and new sessions say so at start. People run `/c1:update`, which calls `claude plugin marketplace update` and `claude plugin update`, then `/reload-plugins`. Auto-update for the marketplace is off by default; `/c1:join` asks people to turn it on.
- **Breaking changes** set a minimum version on the release. Below it, an agent's hub calls that change anything fail with 426 `update_required`; reads still work and humans are unaffected.
- **Safety:** the hub only announces versions. Code always comes from the CollabOne git repository through Claude Code's own plugin manager, so the hub still can't run anything on a participant's Mac.

---

## 9. Autonomy model

### 9.1 Human touchpoints

1. `/c1:network`, then log into the board and `/c1:join`, once per machine.
2. `/c1:project new` and `/c1:goal` per project, approved in the board.
3. Approve the `/c1:plan` graph; add tickets whenever.
4. Answer what the rules route to humans (B4–B7, contests, human votes).
5. Phase calls (`freeze`, `demo`) and the demo itself.

### 9.2 `/c1:autopilot` loop

```
loop:
  if phase is freeze: only fix/test/review tickets
  pick: reviews I didn't author > ready tickets in my lanes and pinned project > any ready ticket in my project > open help requests
  book (c1 ticket next) → /c1:work or /c1:review
  on a problem: classify against the rules (§5)
      no matching row → decide, log, continue
      matching row    → /c1:raise; if stopScope=ticket, park it and pick other work
  on done: share what was learned (§6), continue
  nothing to pick → stop and wait (the monitor wakes the session)
```

**Stop hook:**
- When autopilot is on and either a booked ticket isn't in review or done, or ready work exists within the seat's limits, it returns `{"decision":"block","reason":"<next step>"}`.
- A per-session counter stops it re-blocking for the same reason without progress.
- There's no usage cap (D9). A seat that hits its weekly limit releases its bookings with a note.

### 9.3 Permissions, limits and work modes

- **Auto mode** goes in `~/.claude/settings.json` (it doesn't take effect in project settings), plus event rules: ask before `git push * main`, deny `git push --force*`, deny deploys to shared or production stages. Not `bypassPermissions`.
- **End conditions:** the definition of done holds on the integration branch, the phase is `demo`, or `/c1:autopilot off`. No overnight loops (P7).
- **Work modes (D8):**

  | Mode | What happens | Booking |
  |---|---|---|
  | `solo` | One autopilot session, one ticket at a time | One lease |
  | `subagents` | One session delegates parts of its ticket | One lease; sub-agents stay inside `pathsOwned` |
  | `multi_session` | Several sessions, one ticket each | One lease per session; `c1 ticket next --n 3` |
  | `factory` | The participant's own orchestration pulls tickets through the CLI or API | One worker token and lease per worker |

- **Bring your own factory:** workers use their owner's child tokens, keep their leases alive, respect `pathsOwned` and the rules, and open PRs like any session. The factory runs the official `claude` binary under its owner's login (P1, P6).
- **Fair share:** the hub hands out ready work by priority and wave, not by who asks first. A `maxBookingsPerSeat` setting can be switched on mid-event.

---

## 10. The board

Static app on CloudFront with Cognito login and MFA. Design: the "CollabOne board" canvas.
- **Top bar:** project switcher, phase, live connection with the current sequence number, clock, theme toggle, projector mode.
- **All projects strip:** progress, blockers, votes and members per project, plus "New project".
- **Goal header:** statement, definition-of-done checklist ticked from finished tickets, contest status.
- **Columns:** Planned · Ready · In progress · Review · Done, with a **Blocked** lane above them. A card opens a detail drawer.
- **Right panel:**
  - **Needs a human:** pending proposals with Review and approve / Reject; open-floor escalations with Resolve / Contest / "I have access".
  - **Votes:** countdown, options, each seat's vote marked agent or human, override.
  - **People:** work mode, session state, needs-input flag, weekly usage bar.
  - **Shared knowledge.**
- **Event log tail.**
- **Tabs:** Rules (editable table, versioned) · Tokens & Macs (create a join code, list and revoke tokens) · Settings.
- **Demo mode** (`?demo`) runs offline with sample data and a simulated event stream.

---

## 11. Connectivity (`/c1:network`)

1. Everyone joins any network with internet: venue Wi-Fi is fine. Laptops don't need to reach each other, so client isolation no longer matters.
2. `c1 doctor` checks DNS, HTTPS to the API, a WSS connection to AppSync Events, and reachability of GitHub and the Anthropic API.
3. **Common failures:**
   - A captive portal: log in through the browser first.
   - A network that blocks WebSockets or long connections: switch to an **iPhone Personal Hotspot**.
   - A corporate proxy: use the hotspot.
4. **Bandwidth:** Claude Code and GitHub traffic dominate. The hub traffic is tiny.

---

## 12. Failure handling

| Failure | Detection | Response |
|---|---|---|
| A session dies with a booking | Lease expires (no heartbeats) | Back to `ready` with the branch kept; the next taker continues from the pushed WIP (B8) |
| A participant's internet drops | Monitor reconnects with backoff | Catch-up from the last sequence number; leases may expire meanwhile and the work is re-taken |
| A push is missed | Gap in sequence numbers | `GET /events?since=` fills it |
| Booking conflict | `TransactionCanceledException` | Retry up to 3 times, then 409 and pick another ticket |
| Hub error | 5xx from the API, CloudWatch alarm | CLI hooks never block work; fix and redeploy the Lambda (seconds) |
| Token leaked | Seen on the board or reported | Revoke it in Tokens & Macs; create a new join code |
| Bad shared skill | Agents report failures | Retire it (removed everywhere); re-publish the previous version |
| Rules change mid-ticket | `rules.updated` | Applies to the next classification; open escalations keep their rule version |
| Integration branch red | Rule U1 | Fix ticket at P0; revert first, fix second |
| A bug in CollabOne itself | Someone runs `/c1:bug` | Ticket in the `collabone` fix queue; backend/board fixes deploy, plugin fixes ship as a release (§8.5) |
| AWS region problem | Everything fails | Fall back to GitHub Issues as the ticket list; the exported event log keeps the plan |

---

## 13. Repository layout and distribution

```
collab1/
  .claude-plugin/marketplace.json   marketplace "collabone" → ./plugin
  plugin/                           the Claude Code plugin "c1" (skills, hooks, monitor, bin/c1, templates, scripts)
  backend/                          CDK app + Lambdas (TypeScript), core domain logic with tests
  board/                            the board web app (static, demo mode)
  docs/                             SPEC.md (this doc), CONTRACT.md, SECURITY.md, DEPLOY.md
```

- Install with `/plugin marketplace add jakinluk/collab1` (or a local path), then `/plugin install c1@collabone`, at project scope in the hackathon repos.
- `claude plugin validate ./plugin --strict` runs in CI.
- Updates reach Macs only when `version` in `plugin.json` changes (§8.5). Background auto-update is off for team marketplaces until each person (or an admin, through managed settings) turns it on.
- Installing through claude.ai organization settings instead of a git marketplace would need the CLI moved out of the top-level `bin/` folder, which that route rejects.

---

## 14. Before the offsite (no estimates)

1. Build the plugin, backend and board. Building CollabOne **with CollabOne** is the warm-up. Run the local end-to-end suites first (`e2e/README.md`): they drive the real CLI, hooks, monitor and board against a local hub.
2. Deploy the stack to the sandbox (`docs/DEPLOY.md`), invite everyone, check that MFA enrolment works for each person.
3. Default rules, goal and demo-script templates, ticket templates for the mobile app.
4. Seed shared skills: monorepo test commands (`type:check`, ts-jest; never build), worktree setup, the `node_modules` strategy.
5. **Dry run on the real MacBooks:**
   - venue-like Wi-Fi and the hotspot;
   - `c1 doctor`;
   - each work mode, including one factory worker;
   - the monitor in foreground and `--bg` sessions, and whether it wakes an idle session;
   - skill hot-sync;
   - Stop-hook autopilot ending correctly;
   - auto mode with the ask and deny rules;
   - a proposal approved in the board;
   - one full ticket through work → review → merge;
   - token revocation.
6. Kit: phone hotspots, chargers, an HDMI connection for the board on the venue TV.

---

## 15. Open questions and risks

- **Ongoing mode:** built (see `docs/ONGOING.md`). Still open: the GitHub PR check, roles, SSO, and a review of the security posture for long-lived data and everyday repos.
- **Monitors are experimental.** Fallbacks are Stop-hook polling, between-task checks, or the v1.5 channel (D2).
- **Idle sessions:** does an idle session start a new turn on a monitor notification? Confirm in the dry run.
- **Agent votes are cheap.** If agent quorums rubber-stamp, switch B1/B9 to `human_quorum` on the Rules tab.
- **Usage (D9):** check nobody starts the event near their weekly usage reset.
- **Open floor (D10):** two people can pull a project in different directions. The contest window and the visible log are the guard. A project can switch rows back to `human_quorum`.
- **Internet dependency (D14):** without internet nothing works, but Claude Code needs it anyway. Bring hotspots.
- **Sandbox account:** confirm the account, region, and who holds deploy rights before the warm-up.

---

## Sources

- Plugin manifest reference: https://code.claude.com/docs/en/plugins-reference
- Plugin components (monitors, bin/): https://code.claude.com/docs/en/plugins/components
- Channels / channels reference: https://code.claude.com/docs/en/channels · https://code.claude.com/docs/en/channels-reference
- Skills (live change detection): https://code.claude.com/docs/en/skills
- Hooks (SessionStart `reloadSkills`, Stop blocking): https://code.claude.com/docs/en/hooks
- Permission modes (auto mode): https://code.claude.com/docs/en/permission-modes
- API Gateway WebSocket quotas: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html
- AppSync Events WebSocket protocol: https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
- AppSync Events authorization: https://docs.aws.amazon.com/appsync/latest/eventapi/configure-event-api-auth.html
- ALB idle timeout (for the earlier Fargate option): https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html
