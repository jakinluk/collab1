# CollabOne backend (`backend/`)

This is the serverless hub behind the CollabOne board, CLI and Claude Code plugin. One CDK stack deploys:

| Part | Service |
|---|---|
| Commands (`/api/v1/...`) | API Gateway HTTP API → one Lambda router (`src/handlers/api.ts`), reachable only through CloudFront |
| Auth | One Lambda authorizer (`src/handlers/authorizer.ts`), shared by the HTTP API and AppSync Events. It accepts agent tokens (`c1a_…`) and Cognito ID tokens (humans) |
| State + event log | DynamoDB single table `PK/SK + GSI1`, with Streams, TTL and PITR |
| Push | DynamoDB Stream → fan-out Lambda → AppSync Events namespace `c1`. Channels: `/c1/all`, `/c1/p/<project>`, `/c1/s/<seat>` |
| Housekeeping | EventBridge Scheduler schedule (rate 1 minute, no event bus) → sweep Lambda. It expires leases, closes votes, finalizes contest windows and expires proposals |
| Humans | Cognito user pool: invite-only, **TOTP MFA required**, hosted login with code + PKCE |
| Board | S3 (private, OAC) + CloudFront + security headers + WAF. `config.json` is generated at deploy |
| Shared skills | Private S3 bucket. Uploads and downloads use 5-minute pre-signed URLs; objects expire after 21 days |

The domain logic lives in `src/core/` and is pure, with no AWS imports. Use cases are in `src/app/hub.ts`. Adapters are in `src/adapters/`.

## Prerequisites

- Node.js ≥ 22 and npm.
- AWS CLI v2 with credentials for the **sandbox** account. Never use production.
- CDK bootstrap in **us-east-1**: `npx cdk bootstrap aws://<account>/us-east-1`.

### Why us-east-1

CloudFront web ACLs (WAF scope `CLOUDFRONT`) must be created in us-east-1. The simplest robust option is to deploy the whole stack there, so the edge WAF, the regional WAF on AppSync Events and everything else live in one stack with no cross-region references. The region is fixed in `bin/app.ts`.

## Deploy

```bash
cd backend
npm ci
npm run typecheck && npm test
npx cdk deploy \
  -c eventEndsAt=2026-12-05T18:00:00Z \
  -c domainPrefix=acme-c1-2026
```

Context values:

| Key | Required | Meaning |
|---|---|---|
| `eventEndsAt` | yes | ISO time. Every agent token expires at this moment |
| `domainPrefix` | yes | Cognito hosted-login prefix. It must be globally unique, lowercase, and must not contain `aws`, `amazon` or `cognito` |
| `dataTtlDays` | no (21) | DynamoDB TTL and S3 lifecycle. All hackathon data deletes itself after this many days |
| `removalPolicy` | no (`destroy`) | `retain` keeps the table, secrets, user pool and skills bucket on `cdk destroy` |
| `stackName` | no (`CollabOne`) | Lets you run a rehearsal stack next to the real one |
| `version` | no | Shown by `GET /api/v1/health` and in the board footer |

The deploy prints these outputs: `BoardUrl`, `ApiUrl`, `EventsHttpHost`, `EventsRealtimeUrl`, `UserPoolId`, `ClientId`, `LoginDomain` and `TableName`. `scripts/outputs.sh` prints them again later.

`cdk.json` holds placeholder context values so `cdk synth` works offline. Always pass real values on deploy.

## After deploy

1. Run `scripts/smoke.sh`. It expects health 200, anonymous 401, bad token 401/403, bad join 401, and **403 for the direct API Gateway URL** (the API answers only through CloudFront).
2. Invite people with `scripts/invite.sh ania@example.com bob@example.com …`. Each person gets a temporary password by email.
3. Each person then:
   1. opens `BoardUrl`, signs in, sets a new password and an authenticator app (MFA is mandatory);
   2. creates their seat (board → `POST /seats/me`);
   3. clicks **Connect a Mac**, which shows a one-time join code valid for 10 minutes;
   4. runs `c1 join --code XXXX-XXXX --api <ApiUrl>` (or `/c1:join`) on their MacBook. The agent token goes into the macOS Keychain.
4. The first human creates a project, sets its goal and loads the plan, from the board or by approving the agent's proposals.

## Teardown

```bash
npx cdk destroy
```

With the default `removalPolicy=destroy`, this deletes the table, both buckets (their objects are emptied first), the secrets and the user pool. Data already expires through TTL and S3 lifecycle after `dataTtlDays` anyway.

## Verify locally

```bash
npm run typecheck     # tsc --noEmit, strict
npm test              # vitest: core logic, Hub use cases on an in-memory DynamoDB fake, authorizer, fan-out, SigV4 publisher
npx cdk synth --quiet # bundles all Lambdas with esbuild and synthesizes the template (no AWS credentials needed)
npm run local         # local hub on http://localhost:8787 (see below)
```

### Local hub (`scripts/local-hub.ts`)

Runs the real `Hub`, the real API router and the real authorizer decisions on one port, with stand-ins for the AWS services. It is for development and end-to-end tests only; it is not hardened and must not be exposed to a network.

| AWS piece | Local stand-in |
|---|---|
| DynamoDB | the in-memory fake from `test/fake-dynamo.ts`; `--state file.json` keeps a snapshot across restarts |
| DynamoDB Stream + fan-out Lambda | every committed event is pushed to WebSocket subscribers straight away |
| AppSync Events | a WebSocket server on `/event/realtime` speaking the same protocol (subprotocol auth header, `connection_init`/`ack`, `subscribe`, `data`, `ka`); publishing is refused as in AWS |
| Cognito | a sign-in page that accepts any email, `/oauth2/token` with PKCE, and HMAC-signed ID tokens |
| S3 skills bucket | an in-memory object store behind signed `/_files/` URLs |
| EventBridge Scheduler + sweep | a timer (`--sweep-ms`, default 60000) and `POST /_dev/sweep` |
| CloudFront | the same server serves `board/`, `config.json` and `/api/v1/*` |

Dev-only endpoints: `POST /_dev/token?email=` (an ID token for scripts), `POST /_dev/advance?ms=` (moves the hub clock forward and runs the sweep, to test leases, votes and contest windows). The end-to-end suites in `e2e/` use them.

## Security summary

- **TLS only:** CloudFront redirects to HTTPS, the `/api/*` behaviour is HTTPS-only, and AppSync Events uses WSS. The CloudFront default certificate is used. Add a custom domain + ACM certificate to also pin the TLS minimum version.
- **The API is only reachable through CloudFront.** CloudFront adds `x-c1-origin-verify` from Secrets Manager. The authorizer (via its identity source) and the API handler both reject requests without it, so the raw API Gateway URL answers 403.
- **WAF:**
  - On CloudFront: a stricter rate limit on `/api/v1/join` (100 per 5 minutes per IP), a general per-IP rate limit (6000 per 5 minutes), AWS Common Rule Set and Known Bad Inputs. `SizeRestrictions_BODY` is set to count, because plan uploads can exceed 8 KB.
  - On AppSync Events: a per-IP rate limit.
  - Participants at the venue usually share one public IP, so the limits are generous.
- **Agent tokens:** `c1a_` + 32 random bytes. Only `sha256(pepper + token)` is stored, and the pepper is in Secrets Manager. Tokens expire at `eventEndsAt` and can be revoked from the board. Authorizer caching is off, so revocation takes effect immediately.
- **Join codes:** single-use, 10-minute TTL, hashed with the same pepper. Only a signed-in human can create one, for their own seat.
- **Humans:** Cognito, invite-only, TOTP MFA required, ID tokens valid for 60 minutes, verified with `aws-jwt-verify` (issuer, audience = board client, `token_use = id`).
- **Human-only actions:**
  - Agent tokens get 403 on `/actions`, `/proposals/{id}/approve|reject`, `/escalations/{id}/resolve|contest`, `/join-codes` and `/tokens`.
  - Agents can only **propose** human-only changes. A human approves them in the board.
- **Push:** clients cannot publish to AppSync Events; publishing is IAM-only and only the fan-out Lambda holds `appsync:EventPublish`. Subscribers may read `/c1/all` and `/c1/p/*`, but only **their own** `/c1/s/<seat>`. Wildcards such as `/c1/*` and `/c1/s/*` are refused, so other seats' direct messages stay private.
- **Input:** zod validation on every route, a 256 KB body limit, and secret scanning on shared knowledge and messages. Skill archives must be at most 2 MB, are checked after upload, and can only be uploaded under the uploader's own `skills/<seat>/` prefix.
- **Data at rest:** DynamoDB AWS-managed encryption, S3-managed encryption with `enforceSSL`, public access blocked, Lambda logs kept 14 days. Request bodies and tokens are never logged.
- **Least privilege:**
  - The authorizer only reads the table.
  - The API writes the table and only touches `skills/*` in the skills bucket.
  - The fan-out Lambda can only publish to the `c1` namespace.
  - The sweep Lambda only writes the table.
  - The Lambdas read their runtime configuration from one SSM parameter.

## API notes for the CLI and board builders (clarifications of `docs/CONTRACT.md`)

These are clarifications, not changes. Each was needed to make an edge case precise:

1. **Board subscriptions:** subscribe to `/c1/all`, `/c1/p/*` and `/c1/s/<yourSeat>` as three subscriptions on one WebSocket. `/c1/*` is **denied**, because it would expose other seats' direct messages. Envelopes with `to: 'humans'` are published to `/c1/all` (there is no separate humans channel). Envelopes with `to: <seatId>` go only to `/c1/s/<seatId>`.
2. **`data` messages:** each element of the AppSync `event` array is `JSON.stringify(envelope)`. Parse each element once.
3. **`plan.load` ticket ids:** an `id` that matches an existing `T<n>` updates that ticket. Any other `id` (for example `"contracts"`) is a **local key**: other tickets in the same plan may list it in `deps`, and it is replaced by a new `T<n>`. The result is `{ created: string[], updated: string[] }`.
4. **Escalation action payloads:** `escalation.resolve` and `escalation.contest` take `escalationId` in the payload (`{ escalationId, resolution, reason? }` / `{ escalationId, reason }`). The direct routes `POST /escalations/{eid}/resolve|contest` take the id from the path.
5. **`POST /proposals` response:**
   - from an agent: `{ executed: false, proposal, approveUrl }`, where `approveUrl` = `<boardUrl>/#/approve/<Pn>`;
   - from a human: `{ executed: true, result }`.
   
   `POST /proposals/{id}/approve` returns the proposal with `result`.
6. **`POST /join` response:** `{ token, tokenId, seatId, projectId?, apiUrl, boardUrl, events: { httpHost, realtimeUrl, namespace }, expiresAt }`. Join codes match `^[A-Z2-9]{4}-[A-Z2-9]{4}$`.
7. **`GET /knowledge?since=`:** `since` is `createdAt` in epoch milliseconds, not an event seq.
8. **Extra read route:** `GET /escalations/{eid}`.
9. **`GET /me`:** `{ seat, actor, projectId, repos, rules: { version, digest } }`. `repos` is the pinned project's full `Repo[]` (empty without a pinned project), so the CLI guard needs one call. `digest` is the plain-text rules summary for the SessionStart hook.
10. **`GET /board?projectId=`:** `{ lastSeq, settings, projects: [Project & { counts, total, done, openEscalations, openDecisions, members }], projectId, project, goal, tickets, seats: [Seat & { human: boolean }] (cognitoSub removed), escalations (open, all projects), decisions (open), proposals (pending), knowledge (latest 30 active) }`.
11. **Agent-created tickets:** they go to `ready`, unless they have `dodRefs`; then they are `planned` and a human triages them by approving a `plan.load` with the same `id` and `status: 'ready'`.
12. **Worker tokens (factory mode):** a human calls `POST /actions { action: 'token.worker', payload: { workerId } }` and receives `{ token, tokenId, workerId }` once.
13. **`PATCH /me`:** `maxConcurrentBookings: null` clears the seat limit.
14. **Errors:** codes are as in the contract, plus `internal` (HTTP 500).
15. **Board CSP:** `script-src 'self'`, so the board **must not use inline scripts or inline event handlers**. Inline styles and Google Fonts are allowed. `connect-src` allows only the board origin, the AppSync endpoints and Cognito. The board reads `config.json`:
    `{ apiBase: '/api/v1', events: { httpHost, realtimeUrl, namespace: 'c1' }, cognito: { region, userPoolId, clientId, domain, redirectUri }, version }`.
16. **Throttling:** API Gateway allows 100 requests/s with a burst of 200 for the whole stage. Hooks should keep heartbeats to about one per minute per session.

## Fix queue and releases

- `POST /tool/bugs` files a ticket into project `collabone`, created on first use from the `toolRepoUrl` setting or the `-c toolRepoUrl=` deploy context (env `TOOL_REPO_URL`). Area → owned paths and checks live in `src/core/tool.ts`.
- `release.publish` (human action) stores `HUB`/`RELEASE` and emits `tool.released`. `GET /release` and `/me` return it.
- The API router reads `x-c1-client-version`; with a minimum set, non-GET agent calls below it get 426 `update_required` (cached release lookup, 30 s per Lambda instance).

## Layout

```
bin/app.ts                 CDK app (context validation, us-east-1)
lib/c1-stack.ts            the stack
src/shared/                types + zod schemas (the API contract in code)
src/core/                  pure logic: paths, tickets, plan, rules, quorum, escalations, envelope, secrets, tokens
src/app/hub.ts             use cases (Hub) over the store
src/adapters/              DynamoDB store (transactions + gap-free event seq), AppSync SigV4 publisher, S3, config
src/handlers/              api (router), authorizer (HTTP + AppSync Events), fanout, sweep
test/                      vitest suites + in-memory DynamoDB fake
scripts/                   invite.sh, outputs.sh, smoke.sh, local-hub.ts
```

### Repo and project metadata (CONTRACT §13, v0.2)

- **`Repo`** = `{ name, url, baseBranch, integrationBranch, hotPaths[], contractPaths[], setup[], verify: {name, cmd}[], instructionsPath?, laneMap: {glob, lane}[], prLabels[], notes? }`.
  - In payloads only `name` and `url` are required. `baseBranch` defaults to `main`, `integrationBranch` to `hack/<projectId>`, and the lists to `[]`.
  - Repo names must be unique within a project (`invalid: duplicate repo name …`).
- **`Project`** gains `description?`, `demo?: { url?, stage?, notes? }`, `links: {label, url}[]` and `tags[]`. Every URL in `links` and `demo.url` must be `https://` (`invalid`).
- **Old records** are normalized when read, so every response carries the full shapes above: `GET /projects`, `GET /projects/{pid}`, `GET /board` (each `projects[]` entry and `project`) and `GET /me` (`repos`).
- **`project.create`** payload: `{ id?, name, repos: RepoInput[], lanes?, description?, demo?, links?, tags? }`.
- **`project.update`** payload: `{ projectId, name?, repos?, lanes?, description?, demo?, links?, tags? }`.
  - `repos` replaces the whole list. Fields left out keep their values.
  - Removing a repo that still has tickets in `booked | in_progress | review | blocked` fails with `conflict` (`repo <name> still has active tickets: T…`).
- **Ticket validation** (`POST /projects/{pid}/tickets` and `plan.load`):
  - `repo` must be one of the project's repos.
  - Unless `type` is `contract` or `glue`, no `pathsOwned` entry may overlap the repo's `hotPaths` or `contractPaths`; this fails with `invalid`, naming the ticket, path and rule. Globs with a literal prefix compare by prefix (`libs/**` overlaps `libs/shared/**`); patterns starting with `**` or `*` match by pattern (`services/x/serverless.yml` hits `**/serverless*.yml`, but `apps/mobile/**` doesn't hit `**/project.json`).
  - Empty `lanes` are filled from the repo's `laneMap`, where an owned path inside a hint's folder gets that lane.
- **`GET /tickets/{tid}`** → `{ ticket, card, repo }`. `repo` is the ticket's full `Repo` (or `null` if the repo was removed). `card` gains a "## Repo <name>" section with the remote, base and integration branches, instructions file, setup and verify commands, hot and contract paths, PR labels and notes.

