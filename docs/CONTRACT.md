# CollabOne v1 — build contract

> **Implemented behaviour wins.** The backend's clarifications (subscribe to `/c1/all`, `/c1/p/*`, `/c1/s/<seat>` — never `/c1/*`; `plan.load` local ids; proposal and join response shapes; and more) are listed in `backend/README.md` → "API notes". The CLI and board follow them.

Shared reference for everyone building CollabOne (`c1`). Spec: `docs/SPEC.md`. When a detail here conflicts with the spec, this file wins for the code. Version 1 covers the first mode, the time-boxed hackathon (event mode); an ongoing mode comes later (`docs/SPEC.md` §15).

## 0. Decisions that shape the code

- **The hub is cloud-only and serverless**, in a sandbox AWS account, built with CDK:
  - API Gateway HTTP API + Lambda (Node.js 22, TypeScript, bundled with esbuild via `NodejsFunction`);
  - DynamoDB single table with Streams;
  - AppSync Events for push;
  - Cognito user pool for humans;
  - S3 + CloudFront (+ WAF) for the board;
  - EventBridge Scheduler schedule for the sweep (no event bus, no rule).
  
  There is no laptop host, no local SQLite and no LAN discovery.
- **Several projects per hub (D13).** Seats are pinned to one project for autopilot booking, but everyone sees everything (D10).
- **Open floor (D10):** any human can resolve human-routed items. The first answer applies, and others can contest it within a window.
- **Two credentials per seat:**
  - **agent token:** CLI, Claude sessions, factory workers;
  - **human session:** Cognito JWT, board only.
  
  Human-only actions never accept an agent token. An agent can only **propose** them (§4.4). A human approves in the board.
- **No Claude credentials ever reach the hub.** The hub never calls the Anthropic API and never starts `claude`.

## 1. Repository layout (all paths relative to repo root)

```
README.md
.claude-plugin/marketplace.json      # marketplace "collabone", one plugin: ./plugin
docs/                                # SPEC.md, CONTRACT.md, SECURITY.md, DEPLOY.md, RUNBOOK.md
plugin/                              # the Claude Code plugin, name "c1", displayName "CollabOne"
  .claude-plugin/plugin.json
  skills/<name>/SKILL.md             # network init join project goal plan ticket work review autopilot raise decide share board rules wrap
  hooks/hooks.json
  monitors/monitors.json
  bin/c1                             # #!/usr/bin/env node — zero npm dependencies, Node >= 22 (global fetch + WebSocket)
  lib/*.mjs                          # CLI modules
  templates/rules.default.json
  templates/settings.hackathon.json
  scripts/test-lock.sh
  test/*.test.mjs                    # node --test
backend/
  package.json  tsconfig.json  cdk.json  vitest.config.ts
  bin/app.ts                         # CDK app
  lib/c1-stack.ts                    # the stack
  src/core/*.ts                      # pure domain logic, no AWS imports
  src/adapters/*.ts                  # DynamoDB store, AppSync Events publisher, S3
  src/handlers/{api,authorizer,fanout,sweep}.ts
  src/shared/*.ts                    # zod schemas, types shared with the board/CLI (documented here)
  test/*.test.ts                     # vitest
board/                               # static SPA, no build step
  index.html  styles.css  app.js  api.js  realtime.js  auth.js  demo-data.js
  config.json                        # written by CDK at deploy; board/config.example.json in repo
```

## 2. Identifiers and naming

- `projectId`: `[a-z0-9-]{2,40}`, slug of the name. `seatId`: `[a-z0-9-]{2,40}`, e.g. `lukasz`.
- Tickets: `T1, T2, …`. Escalations: `E1…`. Decisions: `D1…`. Knowledge items: `K1…`. Proposals: `P1…`. All are hub-wide counters.
- Branches: `hack/<projectId>` is the integration branch. A ticket branch is `hack/<projectId>/<ticketId>-<slug>`.
- Channel ids must be AppSync-safe: segments are alphanumeric or dash, ≤ 50 chars, at most 5 segments.

## 3. Domain types (backend/src/shared/types.ts; the CLI and board use the same JSON)

```ts
type TicketStatus = 'planned'|'ready'|'booked'|'in_progress'|'review'|'done'|'blocked'|'dropped';
type TicketType = 'contract'|'slice'|'glue'|'test'|'review'|'spike'|'chore';
type WorkMode = 'solo'|'subagents'|'multi_session'|'factory';
type Resolver = 'self'|'any_agent'|'owner'|'agent_quorum'|'any_human'|'human_quorum'|'human_named';

interface Project { id; name; repos: {name; url; integrationBranch}[]; lanes: string[]; status: 'active'|'frozen'|'demo'|'archived'; phase: 'plan'|'build'|'freeze'|'demo'; goalVersion: number; createdBy; createdAt }
interface Goal { projectId; version; statement; definitionOfDone: string[]; demoScript: string; nonGoals: string[]; contact?: string; createdBy; createdAt }
interface Ticket {
  id; projectId; repo; title; description; type: TicketType; lanes: string[];
  deps: string[]; pathsOwned: string[]; pathsRead?: string[];
  acceptance: { cmd?: string; criterion: string }[];
  priority: number; wave?: number; status: TicketStatus;
  booking?: { seatId; workerId?; sessionId?; leaseExpiresAt: number };
  review?: { seatId; workerId?; leaseExpiresAt: number };
  branch?; prUrl?; attempts: number; createdBy; createdByAgent: boolean;
  dodRefs?: number[];                 // indexes into goal.definitionOfDone this ticket satisfies
  log: { ts; who; kind: 'agent'|'human'; text }[]; updatedAt; version: number;
}
interface Seat { id; name; machine?; lanes: string[]; projects: string[]; pinned: boolean; plan: 'pro'|'max'|'ultra'; workMode: WorkMode; maxConcurrentBookings?: number; autopilot: boolean; lastSeen?: number; usage?: { fiveHourPct?; sevenDayPct?; at }; cognitoSub?: string; sessions?: { sessionId; state: 'working'|'idle'|'needs_input'|'ended'; ticketId?; lastTool?; at }[] }
interface BlockerRule { code; name; trigger; severity: 'P0'|'P1'|'P2'|'P3'; resolver: Resolver; resolverNote?; quorumRule?: 'majority'|'two_thirds'|'unanimous'|'consent'; timeoutMin?: number; contestMin?: number; defaultOnTimeout: string; stopScope: 'none'|'ticket'|'dependents'|'all'; maxAttempts?: number; notify: 'affected'|'all'|'humans'; version: number }
interface Escalation { id; kind: 'blocker'|'issue'|'urgent'|'help'; projectId; ticketId?; ruleCode; ruleVersion; summary; detail; proposed?: string[]; status: 'open'|'resolved_pending_contest'|'resolved'|'contested'|'defaulted'; raisedBy; raisedByKind; resolution?: { text; by; at; contestUntil? }; decisionId?; deadline?: number; createdAt }
interface Decision { id; projectId?; escalationId?; question; options: string[]; context; electorate: 'all_seats'|'humans'|'affected_seats'|'agents'; eligible: string[]; rule: 'majority'|'two_thirds'|'unanimous'|'consent'; quorum: number; deadline: number; defaultOption: string; votes: { seat; option; by: 'agent'|'human'; why; ts }[]; status: 'open'|'made'|'defaulted'; outcome?: string }
interface KnowledgeItem { id; kind: 'tip'|'playbook'|'skill'; name; version; author; tags: string[]; scope: 'global'|{ projectId }; body?: string; s3Key?: string; status: 'active'|'retired'; createdAt }
interface Proposal { id; action: HumanAction; payload: unknown; summary: string; proposedBy; status: 'pending'|'approved'|'rejected'|'expired'; decidedBy?; createdAt; expiresAt }
type HumanAction = 'project.create'|'project.update'|'project.status'|'project.phase'|'goal.set'|'plan.load'|'rules.set'|'rules.override'|'escalation.resolve'|'escalation.contest'|'settings.set'|'token.worker'|'release.publish'
interface Envelope { seq: number; ts: number; stream: 'tasks'|'knowledge'|'escalations'|'decisions'|'broadcast'|'presence'|'dm'; type: string; projectId?: string; from: string; fromKind: 'agent'|'human'|'system'; ticketId?: string; to?: string; summary: string; data?: Record<string, unknown> }
```

`summary` is a one-line human-readable text of at most 200 chars. The monitor prints it. `data` is kept small (≤ 2 KB serialized); clients fetch details by id.

## 4. HTTP API (`/v1`, behind CloudFront at `https://<board-domain>/api/v1/...`; API Gateway also answers at its own URL but rejects requests without the CloudFront origin-verify header)

Auth header: `Authorization: Bearer <token>`.
- An **agent token** looks like `c1a_<43 base64url chars>`.
- Anything else is treated as a **Cognito ID token** (human).

One Lambda authorizer handles both kinds and puts `{ seatId, kind: 'agent'|'human', workerId? }` in the request context. Error JSON: `{ error: { code, message } }`, with codes `unauthorized|forbidden|not_found|conflict|invalid|not_ready|path_conflict|rate_limited|update_required`.

Clients send `x-c1-client-version: <plugin version>`. When a release sets a minimum version, any non-GET call from an **agent** below it gets **426 `update_required`** with `details: { client, minimum, latest }`; reads keep working, humans are never affected. A missing header counts as `0.0.0`, so factory tooling that calls the API directly must send it.

### 4.1 Public (no authorizer)
| Method | Path | Body → Response |
|---|---|---|
| GET | `/health` | → `{ ok: true, version }` |
| POST | `/join` | `{ code, machine, sessionLabel? }` → `{ token, seatId, projectId?, apiUrl, events: { httpHost, realtimeUrl, namespace: 'c1' } }`. The code is single-use with a 10-minute TTL, created by a human in the board. Rate-limited by WAF |

### 4.2 Agent or human
| Method | Path | Notes |
|---|---|---|
| GET | `/me` | seat + effective rules digest for the pinned project |
| PATCH | `/me` | `{ lanes?, workMode?, maxConcurrentBookings?, autopilot?, usage?, machine?, pinProject? }` (`pinProject` moves the seat's pinned project to the front of `projects`; the CLI releases bookings in the old project first) |
| POST | `/me/sessions` | `{ sessionId, state, ticketId?, lastTool? }` (heartbeat / presence from hooks) |
| GET | `/board?projectId=` | aggregated view: projects[], tickets of the project, seats, open escalations (all projects), open decisions, proposals pending, recent knowledge, rules version |
| GET | `/projects` · `/projects/{pid}` · `/projects/{pid}/goal` | |
| GET | `/projects/{pid}/tickets?status=&ready=true` | `ready=true` applies the readiness rule |
| GET | `/tickets/{tid}` | full ticket + a rendered markdown card (`card`) |
| POST | `/projects/{pid}/tickets` | create. From an agent: status `planned`, `createdByAgent: true`; auto-`ready` unless `dodRefs` non-empty (demo path → needs human triage via proposal). From a human: `ready` or `planned` as given |
| POST | `/tickets/next` | `{ projectId?, lanes?, n?: 1..5, workerId?, sessionId? }` → `{ booked: Ticket[] }`. Picks by priority, wave and lane match, never by request order. Respects `maxConcurrentBookings` and the `maxBookingsPerSeat` setting |
| POST | `/tickets/{tid}/book` | → `409 {code: not_ready|path_conflict|conflict}` when it can't |
| POST | `/tickets/{tid}/heartbeat` | `{ sessionId? }` → extends the lease (`leaseTtlSec`, default 900) |
| POST | `/tickets/{tid}/status` | `{ status: 'in_progress'|'review'|'blocked', note?, prUrl? }` |
| POST | `/tickets/{tid}/release` | `{ reason, failed?: boolean }` → back to `ready`, `attempts++` if failed, locks freed, branch kept |
| POST | `/tickets/{tid}/review/book` | a seat other than the booking seat books the review |
| POST | `/tickets/{tid}/review/done` | `{ outcome: 'merged'|'changes_requested', note?, prUrl? }` → `done` (frees locks, unblocks dependents) or back to `in_progress` for the author |
| POST | `/escalations` | `{ kind, projectId, ticketId?, ruleCode, summary, detail, proposed? }`. The server attaches rule version, routing and deadline, opens a Decision when the resolver is a quorum, and parks the ticket per `stopScope` |
| GET | `/escalations?status=open` | all projects (D10) |
| POST | `/escalations/{eid}/answer` | agent answers for `any_agent`/`self` rows (e.g. a B3 help answer) → resolved |
| GET | `/decisions?status=open` · `/decisions/{did}` | |
| POST | `/decisions/{did}/vote` | `{ option, why }`. An agent vote is provisional; a human vote from the same seat overrides it |
| POST | `/knowledge` | `{ kind: 'tip'|'playbook', name, tags, scope, body }` or `{ kind: 'skill', name, tags, scope, s3Key }`. The server rejects bodies matching secret patterns |
| POST | `/knowledge/skills/upload-url` | `{ name }` → `{ uploadUrl, s3Key }` (pre-signed PUT, 5 min, `application/gzip`, max 2 MB) |
| GET | `/knowledge?since=&status=active` · `/knowledge/{kid}/download-url` | |
| POST | `/knowledge/{kid}/retire` | author seat or any human |
| POST | `/messages` | `{ to: seatId|'all', projectId?, text }` |
| GET | `/events?since=<seq>&limit=200` | ordered envelopes `{ events, lastSeq }`, for catch-up |
| GET | `/rules?projectId=` | merged rules (defaults + project overrides) + version |
| POST | `/proposals` | `{ action, payload, summary }`. From an agent: stored `pending`, returns `{ proposal, approveUrl }` (board deep link `#/approve/P7`). A `plan.load` payload is validated against the project's repos when it is proposed, so a bad plan fails at once instead of at approval. From a human: executes immediately |
| GET | `/proposals?status=pending` | |
| GET | `/release` | `{ release: { latest, minimum?, notes, publishedAt, by } | null }` |
| POST | `/tool/bugs` | `{ summary, detail?, area: plugin|board|backend|docs, urgent?, ticketId? }` → a `ready` ticket in project `collabone` (the fix queue), created on first use from the `toolRepoUrl` setting (or the stack's `toolRepoUrl` context). Each area owns fixed paths of the CollabOne repo; secrets are refused |

### 4.3 Human only (Cognito JWT; agent tokens get 403)
| Method | Path | Notes |
|---|---|---|
| POST | `/seats/me` | first login: create or link the seat `{ id, name, plan, lanes }` to the Cognito `sub` |
| POST | `/join-codes` | → `{ code, expiresAt }` for connecting a Mac to the caller's seat |
| GET | `/tokens` · DELETE `/tokens/{tokenId}` | list / revoke the caller's agent and worker tokens |
| POST | `/proposals/{pid}/approve` · `/proposals/{pid}/reject` | executes the action as the approving human |
| POST | `/actions` | `{ action, payload }`: direct human action (same executor as proposals) |
| POST | `/escalations/{eid}/resolve` | `{ resolution, reason }` → `resolved_pending_contest` until `contestUntil`, then `resolved` (by the sweep) |
| POST | `/escalations/{eid}/contest` | `{ reason }` → opens a `human_quorum` Decision; the ticket stays parked |

### 4.4 Human actions (one executor; payload validation in `src/shared/schemas.ts`)
| Action | Payload | Effect |
|---|---|---|
| `project.create` | `{ id?, name, repos[], lanes[] }` | creates the project and emits `project.created` (hub-wide). Branch creation is done by the CLI skill with `git`/`gh`, not by the hub |
| `project.update` / `project.status` / `project.phase` | … | `project.archived` is contestable like any open-floor action |
| `goal.set` | `{ projectId, statement, definitionOfDone[], demoScript, nonGoals[] }` | new goal version. If a previous version exists, this is a B5 change: it is recorded as an escalation already resolved, with a 10-minute contest window |
| `plan.load` | `{ projectId, tickets: TicketInput[] }` | validates the graph (no cycles, deps exist, every ticket has acceptance, no `pathsOwned` overlap between tickets of the same wave without a dependency), then upserts the tickets |
| `rules.set` / `rules.override` | `{ code, patch }` / `{ projectId, code, patch }` | bumps the rules version and emits `rules.updated`. In a patch, `timeoutMin`, `contestMin` and `maxAttempts` may be `null` to clear them |
| `escalation.resolve` / `escalation.contest` | as in §4.3 | |
| `settings.set` | `{ leaseTtlSec?, maxBookingsPerSeat?, defaultContestMin?, toolRepoUrl? }` | `null` clears `maxBookingsPerSeat` or `toolRepoUrl` |
| `token.worker` | `{ workerId }` | → a worker sub-token for the caller's seat (factory mode) |
| `release.publish` | `{ version, notes, minimum? }` | stores the release (`HUB`/`RELEASE`; must be newer than the last; `minimum` ≤ `version`, kept from the previous release when omitted) and emits `tool.released` to `/c1/all`. The hub never ships code: Macs update through Claude Code's plugin manager |

## 5. Readiness, booking and locks (core)

- **Claimable** means: `status === 'ready'`; every dep is `done`; no active ticket (`booked|in_progress|review|blocked`) in the same project and repo has an overlapping `pathsOwned`; and the seat is under its limits.
- **Overlap** uses the non-wildcard prefix of each glob, compared segment by segment. `a/b/**` overlaps `a/b/c.ts` and `a/**`; `a/b/**` does not overlap `a/c/**`.
- **Booking** is one DynamoDB `TransactWriteItems`:
  - ticket update conditioned on `status = ready AND version = :v`;
  - one lock item per owned prefix: `PK=LOCK#<pid>#<repo>#<prefix>`, put with `attribute_not_exists(PK)`;
  - the event-counter update and the event item.
  
  On `TransactionCanceledException` it re-reads and either retries (up to 3 times) or answers 409. Before writing locks, it checks for an existing lock whose prefix is an ancestor or descendant of the new one. Locks are deleted when the ticket goes back to `ready`, `done` or `dropped`.
- **Event sequence:** the item `PK=HUB SK=COUNTER#event` has `seq`. Every mutation that emits events runs `UpdateItem SET seq = seq + n` conditioned on `seq = :read`, inside the same transaction as `PK=EVENT SK=<seq padded to 12>` puts. The result is a gap-free, ordered log.

## 6. DynamoDB single table `c1` (PK, SK, GSI1PK, GSI1SK, ttl; Streams NEW_IMAGE)

| Item | PK | SK | GSI1PK / GSI1SK |
|---|---|---|---|
| Settings, counters, release | `HUB` | `SETTINGS`, `COUNTER#event`, `COUNTER#ticket`, `RELEASE`, … | |
| Default rule | `HUB` | `RULE#B1` | |
| Seat | `SEAT#<id>` | `META` | `SEATS` / `<id>` |
| Cognito link | `SUB#<cognitoSub>` | `META` (`seatId`) | |
| Agent / worker token | `TOKEN#<sha256(pepper+token)>` | `META` (`seatId, tokenId, kind, workerId?, expiresAt, revoked`) | `SEAT#<id>` / `TOKEN#<tokenId>` |
| Join code | `JOIN#<sha256(code)>` | `META` | ttl = 10 min |
| Project | `PROJECT#<pid>` | `META`, `GOAL#<v padded 4>`, `RULE#<code>` | `PROJECTS` / `<pid>` |
| Ticket | `TICKET#<tid>` | `META` | `PROJECT#<pid>#TICKETS` / `<tid padded>` |
| Lock | `LOCK#<pid>#<repo>#<prefix>` | `META` (`ticketId`) | `PROJECT#<pid>#LOCKS` / `<repo>#<prefix>` |
| Escalation, Decision, Knowledge, Proposal | `ESC#<id>`, `DEC#<id>`, `KNOW#<id>`, `PROP#<id>` | `META` | `ESCS`/`DECS`/`KNOW`/`PROPS` / `<status>#<id padded>` |
| Event | `EVENT` | `<seq padded 12>` | |

Every item gets `ttl = eventEndsAt + 7 days`, from the `C1_DATA_TTL_DAYS` env var counted from creation (default 21 days).

## 7. Push (AppSync Events)

- Event API `c1-events` with channel namespace `c1`.
- **Publish:** IAM only. Only the fan-out Lambda can publish. **Subscribe:** Lambda authorizer only, the same token logic as the HTTP authorizer. Agent tokens and Cognito JWTs both go in `Authorization`.
- **Channels:**
  - `/c1/all`: hub-wide events, global knowledge, `project.created`;
  - `/c1/p/<projectId>`: project-scoped events;
  - `/c1/s/<seatId>`: DMs, proposal outcomes for that seat, its tickets' review results.
  
  Subscribe authorization: `/c1/s/<seatId>` only for that seat. `/c1/all` and `/c1/p/*` for any authenticated seat (D10 visibility). The board and `c1 watch` both subscribe to `/c1/all`, `/c1/p/*` and `/c1/s/<seat>`.
- **Fan-out:** a Lambda reads the DynamoDB Stream filtered to `PK = EVENT` and publishes each envelope with HTTP POST to `https://<httpHost>/event` (SigV4, service `appsync`). The body is `{ channel, events: [JSON.stringify(envelope)] }`, in batches of at most 5 events per request.
- **Clients:** WebSocket to `realtimeUrl` with subprotocols `['aws-appsync-event-ws', 'header-' + base64url(JSON.stringify({ host: httpHost, Authorization: token }))]`. Then:
  1. send `{type:'connection_init'}` and wait for `connection_ack` (`connectionTimeoutMs`);
  2. send `{type:'subscribe', id, channel, authorization: { host, Authorization }}`;
  3. receive `{type:'data', id, event: [jsonString]}` (event is an array of JSON strings), plus `{type:'ka'}` every 60 s.
  
  If no `ka` arrives within `connectionTimeoutMs`, reconnect with jittered exponential backoff, then catch up with `GET /events?since=<lastSeq>`. Delivery is not confirmed, so the seq log is the truth.

## 8. Authorizer (one Lambda, used by HTTP API and AppSync Events)

- **`c1a_…` token:** sha256(pepper + token) → `TOKEN#…`. The token must not be revoked or expired. → `{ seatId, kind: 'agent', workerId }`.
- **Otherwise:** verify a Cognito ID token (`aws-jwt-verify`, user pool + app client), with `token_use = id`. Map `sub` → `SUB#` → seatId. A token with no seat yet passes only for `POST /seats/me` → `{ kind: 'human', seatId: null }`.
- **Origin check:** the HTTP API requires header `x-c1-origin-verify` = the secret (Secrets Manager, injected by CloudFront as an origin custom header).
- **Responses:** HTTP API uses simple responses with `isAuthorized` + `context`, with authorizer caching off (tokens can be revoked). AppSync Events returns `{ isAuthorized, ttlOverride: 0 }`; for `/c1/s/<seat>` it checks the seat matches.
- The pepper and origin secret come from Secrets Manager, cached in memory for 5 min.

## 9. Sweep (EventBridge Scheduler, every 1 minute)

- Expire booking and review leases → back to `ready` (event `ticket.released`, reason `lease_expired`).
- Close decisions past their deadline: tally them, or apply the default.
- Finalize `resolved_pending_contest` escalations whose `contestUntil` has passed.
- Expire proposals older than 24 h.
- Escalations past their rule timeout get `defaultOnTimeout` and status `defaulted`.

## 10. CLI (`plugin/bin/c1`) contract

- **Config:** `~/.c1/config.json` = `{ apiUrl, events: { httpHost, realtimeUrl }, seatId, projectId, workMode, lanes }`.
- **Token storage:**
  - macOS Keychain: `security add-generic-password -U -s c1-agent-token -a <seatId> -w <token>`, read with `security find-generic-password -s c1-agent-token -a <seatId> -w`;
  - fallback `~/.c1/token` with mode 0600 when `security` is missing (CI and Linux).
- **State:** `~/.c1/state.json` = `{ lastSeq, syncedSkills: { [kid]: version } }`.
- **Commands** (all accept `--json`; human-readable by default):
  ```
  c1 join --code XXXX-XXXX [--api https://…] [--project <pid>]
  c1 me [mode <workMode>] [pin <pid>]            (PATCH /me; a seat may re-pin itself; bookings in the old project are released first)
  c1 status                                       (connectivity + seat + project summary)
  c1 project list|show <pid>|propose-new --name … --repo name=url …
  c1 goal show [--project] | c1 goal propose --file goal.json [--project]
  c1 plan propose --file tasks.json [--project]
  c1 ticket list [--status] [--ready] | show <tid> | add --file t.json | next [--n 3] [--lanes a,b] [--worker id] | book <tid> | heartbeat <tid> | start <tid> | review-ready <tid> --pr <url> | block <tid> --note | release <tid> --reason [--failed]
  c1 review next | c1 review done <tid> --outcome merged|changes_requested [--note]
  c1 raise blocker|issue|urgent|help --rule B3 --summary … [--detail-file f] [--ticket T1] [--option …]
  c1 answer <eid> --text …
  c1 decide list | show <did> | vote <did> <option> --why …
  c1 share tip "…" [--tags] [--project] | share playbook <file.md> --name … | share skill <dir> [--name] | retire <kid>
  c1 kb search <words>
  c1 rules show
  c1 say "…" [--to seat]
  c1 board                                         (compact terminal board + board URL)
  c1 events [--since n]
  c1 sync                                          (pull shared skills into ~/.claude/skills/c1--<name>/)
  c1 watch                                         (the monitor: subscribe + one-line output + skill sync)
  c1 hook session-start|guard|heartbeat|needs-input|autopilot-stop|session-end   (reads hook JSON on stdin)
  c1 doctor                                        (used by /c1:network: DNS, HTTPS, WSS, GitHub, Anthropic reachability)
  c1 bug "…" [--detail …] [--area plugin|board|backend|docs] [--urgent] [--ticket T1]   (POST /tool/bugs)
  c1 version                                       (installed plugin version against GET /release)
  c1 update [--marketplace collabone]           (claude plugin marketplace update + claude plugin update; explains in-place installs)
  c1 release show | propose --version x.y.z --notes … [--minimum x.y.z]   (proposal for release.publish)
  ```
- **Exit codes:** 0 ok, 1 error, 2 conflict/not ready, 3 update required (scripts and skills branch on it).
- **Version:** every request sends `x-c1-client-version` from `plugin/.claude-plugin/plugin.json`. SessionStart compares it with `/me`'s `release` and adds a user-visible `systemMessage` when behind or blocked; the monitor prints `[c1] UPDATE …` (and a macOS notification) on `tool.released`.
- **Hooks** must never block work when the hub is unreachable: 3 s timeouts, and they exit 0. The exceptions are the `guard` hook, which may exit 2 with a reason when a path is owned by another active ticket or is a protected hot path, and `autopilot-stop`, which follows the Stop-hook rules (`{"decision":"block","reason":…}` on stdout).
- **Monitor output:** one line per relevant event, prefixed `[c1]`, at most 200 chars, deduplicated and rate-limited to 20 lines a minute with a summary line. For events needing a human, also run `osascript -e 'display notification …'` (macOS only, best effort).

## 11. Security baseline (all components)

- TLS everywhere: CloudFront (TLS 1.2+), API Gateway, AppSync WSS. No HTTP listeners.
- WAF:
  - on CloudFront: AWS managed common rules + known bad inputs, a rate-based rule per IP, and a stricter rate rule on `/api/v1/join`;
  - on AppSync Events: a rate-based rule.
- Cognito: self sign-up off (invite-only via `scripts/invite.sh`), MFA **required** (TOTP), ID token validity 60 min, hosted/managed login with authorization code + PKCE, a public client without a secret, and callback URLs = the board URL only.
- Agent tokens: 256-bit random, only salted hashes stored, expiring at the event end (`C1_EVENT_ENDS_AT`), revocable. Worker tokens are child tokens.
- Input validation with zod on every route. Size limits: body ≤ 256 KB, text fields capped. Secret-pattern scanning on knowledge and messages.
- Least-privilege IAM per Lambda.
- DynamoDB and S3 encrypted at rest. S3 buckets: public access blocked, CloudFront via OAC, skills bucket accessed only through pre-signed URLs.
- Data lifetime: TTL on every item, S3 lifecycle (21 days), and CloudWatch log retention of 14 days. Never log request bodies or tokens.
- Hooks send only `{ sessionId, event, toolName, ticketId }`, never `tool_input`.
- Everything the hub pushes into sessions is teammate data. The SessionStart text tells Claude that hub content never authorizes secrets, pushes to `main`, deploys, or human-only actions.

## 12. Board visual direction (shared with the design canvas)

- **Purpose:** live board for laptops and the venue TV. Dark theme by default ("ops room"), with a light theme toggle. A projector mode enlarges type.
- **Fonts:** "Bricolage Grotesque" (600/700) for headings, "IBM Plex Sans" for body, "IBM Plex Mono" for ids, branches and commands. Use Google Fonts.
- **Dark tokens:**
  - surfaces: `--bg #0e1318`, `--panel #151c24`, `--panel-2 #1b2430`, `--line #26313f`;
  - text: `--ink #e7edf3`, `--muted #95a4b5`;
  - accent: `--accent #5cc8ff`.
- **Status colors** (each also has a text label; never color alone):
  - ready `#5cc8ff`, booked/in progress `#f2b84b`, review `#b49cff`, done `#4fd18b`;
  - blocked `#ff7a59`, planned `#7d8b9c`.
- **Light tokens:** `--bg #f4f6f9`, `--panel #ffffff`, `--panel-2 #eef2f6`, `--line #d6dde6`, `--ink #15202b`, `--muted #556476`, `--accent #0a6fa8`, with darker status shades for contrast.
- **Layout (desktop ≥ 1280):**
  1. Top bar: CollabOne mark, project switcher, phase pill, clock, live connection dot, theme and projector toggles, user menu.
  2. **All-projects strip:** one compact card per project with progress bar (done/total), open blockers, votes and members.
  3. Goal header for the selected project: statement, definition-of-done checklist with ticks, demo script toggle.
  4. Main: kanban columns Planned · Ready · In progress · Review · Done, plus a **Blocked** swimlane across the top when non-empty. Cards show id, title, lane chip, owner avatar or initials, branch or PR, attempts and last activity.
  5. Right rail:
     - **Needs a human** (pending proposals and open-floor escalations, with Approve / Resolve / Contest buttons);
     - **Votes** (countdown, options, per-seat votes marked agent or human);
     - **People** (seats, work mode, sessions, autopilot, needs-input flag, weekly usage bar);
     - **Knowledge feed**.
  6. Bottom: event log tail.
  7. Tabs: Board · Rules (editable blocker table with version) · Tokens & Macs (connect a Mac: join code; revoke) · Settings.
- Narrow screens: the columns become a horizontal scroller, and the rail moves below.

## 13. Repository and project metadata (v0.2)

A project carries descriptive metadata, and each of its repos carries the facts agents need: where to branch from, what not to touch, and how to set up and verify. Agents never rely on hard-coded paths.

```ts
interface Repo {
  name: string;                 // [A-Za-z0-9._-]{1,60}, unique within the project
  url: string;                  // git remote URL (https or ssh form)
  baseBranch: string;           // default 'main'; the integration branch is cut from it
  integrationBranch: string;    // default 'hack/<projectId>'
  hotPaths: string[];           // globs nobody edits from a build ticket (lockfiles, workspace config, CI, registrations); ≤ 50
  contractPaths: string[];      // globs holding shared contracts; only 'contract'/'glue' tickets may own them; ≤ 50
  setup: string[];              // commands to prepare a fresh worktree, e.g. ['npm ci']; ≤ 10
  verify: { name: string; cmd: string }[];   // standard checks, e.g. typecheck, unit, lint; ≤ 10
  instructionsPath?: string;    // e.g. 'CLAUDE.md'
  laneMap: { glob: string; lane: string }[]; // folder → lane hints for planning and the board; ≤ 30
  prLabels: string[];           // labels for PRs opened by agents; ≤ 10
  notes?: string;               // ≤ 2000 chars, free text for agents (e.g. "never run builds")
}
interface Project {
  /* existing fields */
  description?: string;         // ≤ 2000
  demo?: { url?: string; stage?: string; notes?: string };
  links: { label: string; url: string }[];   // Slack channel, designs, PRD; ≤ 20
  tags: string[];               // ≤ 20
}
```

- **Defaults:** `baseBranch: 'main'`, `integrationBranch: 'hack/<projectId>'`, and every list empty. Older projects without these fields are read with those defaults.
- **Validation:** URLs in `links` and `demo.url` must be `https://`. Globs are at most 200 chars. Commands are at most 500 chars. Repo names are unique within a project.
- **`project.update`** may replace `repos` (whole list), `description`, `demo`, `links`, `tags`, `lanes` and `name`. Removing a repo that still has active tickets fails with `conflict`.
- **Plan and ticket validation** (`plan.load`, `POST /projects/{pid}/tickets`):
  - `ticket.repo` must name one of the project's repos;
  - a ticket whose type is not `contract` or `glue` must not own paths overlapping the repo's `hotPaths` or `contractPaths` (error `invalid`, naming the ticket and path);
  - when `ticket.lanes` is empty and `pathsOwned` match a `laneMap` glob, the lane is filled in.
- **Ticket card** (`GET /tickets/{tid}`) gains a `repo` section with the full Repo object, so agents see setup and verify commands next to the ticket.
- **Local checkouts** are per Mac and never sent to the hub: `~/.c1/repos.json` = `{ "<projectId>": { "<repoName>": "/abs/path" } }`.
  - Set it with `c1 repo link <name> [path]`; the path defaults to the git toplevel of the current directory.
  - `c1 repo list` shows each project repo with its local path or "not linked".
  - `c1 repo path <name>` prints the path, exit 2 if not linked.
  - The CLI can also auto-match a checkout by comparing normalized git remote URLs: drop `.git`, unify `git@host:org/x` and `https://host/org/x`, lower-case the host.
- **Guard hook:** protected paths = the ticket repo's `hotPaths`, plus `contractPaths` unless the booked ticket's type is `contract` or `glue`. The repo is identified from the hook `cwd` through local links or remote matching. The original hard-coded list is kept only as the `nx-monorepo` preset in `plugin/templates/repo-presets.json`. The guard falls back to it only when the repo can't be identified **and** the user opted in with `C1_GUARD_FALLBACK=nx-monorepo`; otherwise it doesn't block on hot paths.
- **Presets** (`plugin/templates/repo-presets.json`, used by `/c1:project new`):
  - `nx-monorepo`: `hotPaths` = package.json, package-lock.json, nx.json, `**/project.json`, tsconfig.base.json, `.github/**`, `**/serverless*.yml`; `contractPaths` = `libs/shared/**`; `setup` = `npm ci`; `verify` = typecheck `npm run type:check`, lint `npx nx affected -t lint`, unit `npx nx affected -t unit`; `notes` = "Never run builds (npm run build, nx build, affected:build): use type:check and unit tests"; `instructionsPath` = CLAUDE.md.
  - `node-app` and `expo-app` with sensible equivalents.
