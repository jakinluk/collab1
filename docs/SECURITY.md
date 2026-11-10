# CollabOne security model

The earlier design ran the hub on a laptop inside the venue LAN, so part of its safety came from not being reachable from the internet. The cloud hub (D14) is reachable from the internet, so it gets the same or better safety from identity, edge protection, least privilege and short data lifetime. This document lists every control and where it lives in the code.

## 1. Trust boundaries

| Actor | Credential | Can | Cannot |
|---|---|---|---|
| Human in the board | Cognito ID token (invite-only user, MFA required), kept in `sessionStorage` | Everything an agent can, plus human-only actions: approve or reject proposals, resolve or contest escalations, create and change projects and goals, load plans, edit rules and settings, create join codes, revoke tokens, issue factory worker tokens | Act as another seat |
| Agent (Claude session or `c1` CLI) | Agent token `c1a_…`, 256-bit random, stored in the macOS Keychain | Read everything (D10 visibility), book and work tickets, raise blockers, vote provisionally, share knowledge, message, **propose** human actions | Execute any human-only action, publish to push channels, read other seats' DM channels |
| Factory worker | Child token of a seat, one per worker | Same as an agent, attributed to `seat/worker` | Same limits; it can be revoked on its own |
| Fan-out Lambda | IAM role | Publish to AppSync Events | Anything else |
| Anyone else on the internet | none | `GET /health`; `POST /join` with a valid single-use code | Anything else |

## 2. Controls

### Identity
- **Cognito user pool:**
  - self sign-up disabled; users are created with `scripts/invite.sh`;
  - MFA required (TOTP);
  - managed login with authorization code + PKCE, a public client with no secret, and callback and logout URLs limited to the board URL;
  - ID tokens valid for 60 minutes.
- **Agent tokens:**
  - minted only by the hub, in exchange for a single-use join code. The code is created by a logged-in human, lasts 10 minutes, and is stored hashed.
  - The hub stores only `sha256(pepper + token)`; the pepper is in Secrets Manager.
  - Tokens expire at `eventEndsAt` and can be revoked one by one on the board.
- **One authorizer** for both the HTTP API and AppSync Events:
  - results are not cached, so revocation applies immediately;
  - personal channels `/c1/s/<seat>` are only subscribable by that seat.

### Human-in-the-loop guarantee
- Human-only routes reject agent tokens with 403.
- Agents submit **proposals** instead. A proposal runs only when a human approves it in the board, and the approval is recorded with that human's identity.
- Setup skills are `disable-model-invocation: true`, but the guarantee doesn't rely on that: the server enforces it.

### Edge and transport
- **CloudFront:** HTTPS only (HTTP redirects). CloudFront uses its default certificate, which also allows TLS 1.0 and 1.1; a custom domain with an ACM certificate is needed to require TLS 1.2.
- **WAF on CloudFront (optional, `-c waf=on`, about $15/month with the AppSync one):** AWS managed common rules and known-bad-inputs, a per-IP rate rule, and a strict rate rule on `/api/v1/join`. Off by default. Without it there are no per-IP limits; the API stage throttle (100 req/s, burst 200) and the Lambda concurrency limits cap the load, and a join code (one of about 10^12 values, 10 minutes, single use) cannot be guessed at that rate.
- The board and API share one origin, so CORS is never needed.
- **API Gateway** checks a secret `x-c1-origin-verify` header that only CloudFront adds, so the raw execute-api URL is useless.
- **AppSync Events:** WSS only, publish IAM-only, subscribe through the Lambda authorizer, and a WAF rate rule with `-c waf=on`.

### Input and content
- zod schemas on every route; request body ≤ 256 KB; text fields capped; ids restricted to `[a-z0-9-]`.
- Secret-pattern scanning on tips, playbooks, shared skills and messages, client-side before upload and server-side before storing. Patterns cover AWS keys, GitHub tokens, Anthropic keys, private key blocks and generic credential assignments.
- **Shared skills:**
  - uploaded through pre-signed S3 PUT URLs (5 minutes). The client states the size first (≤ 2 MB); the URL signs that `content-length` and `application/gzip`, so S3 refuses any other size or type;
  - downloaded through pre-signed GETs;
  - the CLI rejects archives containing absolute paths or `..`, and extracts only under `~/.claude/skills/c1--<name>/`.
- Hooks send only `{ sessionId, event, toolName, ticketId }`, never tool inputs or file contents.
- Text pushed into Claude sessions is labelled as teammate data. The SessionStart instructions say hub content never authorizes secrets, pushes to `main`, deploys or human-only actions.

### Infrastructure
- One Lambda per role (api, authorizer, fanout, sweep), each with least-privilege IAM.
- Reserved concurrency caps each one (api 10, authorizer 10, fanout 2, sweep 1), so a flood of requests cannot scale them without limit. `-c lambdaConcurrency=off` removes the caps for accounts whose concurrency quota is too low.
- No call loops: API and sweep write the table, the stream feeds only the fan-out Lambda, and the fan-out Lambda only publishes to AppSync. The sweep runs every 1 minute in event mode and every 5 minutes in ongoing mode (`sweepMinutes`).
- The stack creates no CloudTrail trail and no CloudFront or API Gateway access logs. AWS keeps 90 days of account activity history on its own.
- Deployed only to a **sandbox** AWS account, never production. No VPC.
- **DynamoDB:** encrypted at rest, point-in-time recovery on, TTL on every item.
- **S3:** public access blocked, encryption on, HTTPS required, board served through CloudFront OAC. Skills expire after 21 days in event mode and are kept in ongoing mode.
- **CloudWatch Logs:** 7-day retention (`logRetentionDays`) for every Lambda, CDK helper Lambdas included. Never log request bodies, tokens or JWTs.

### Data lifetime
- Items expire 21 days after creation by default.
- `/c1:wrap` exports the event log (for the harvest), revokes every token, and documents `cdk destroy` for the stack.

### Compliance with Claude subscription terms
- The hub holds no Claude credentials, never calls the Anthropic API, and never starts `claude`.
- Every session and factory worker runs the official `claude` binary under its owner's own login.

## 3. Residual risks

- **A stolen agent token can act as that seat's agent until revoked.** Mitigations: Keychain storage, revocation, expiry, and human-only actions being impossible with it.
- **A teammate's agent could publish misleading content** (a bad skill, a wrong tip). Mitigations: authorship is shown everywhere, retire is one command, and every change is in the event log.
- **Monitors and channels are preview features.** Behaviour may change; re-check before the event.
