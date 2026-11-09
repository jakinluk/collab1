# HackathonOne

A Claude Code plugin (`h1`) and a small serverless hub that run a hackathon in which people set goals and the participants' Claude Code sessions do most of the building:

- people create projects, set goals, approve plans and answer the blockers routed to them;
- each participant's Claude Code books tickets, builds them in worktrees, opens PRs, reviews other people's PRs, shares what it learned and raises blockers against an editable rules table;
- a live board in the browser shows every project, ticket, blocker, vote, person and shared skill.

```
.claude-plugin/marketplace.json   marketplace "hackathonone" → ./plugin
plugin/                           the Claude Code plugin: skills, hooks, monitor, the `h1` CLI
backend/                          AWS CDK stack + Lambdas (TypeScript): API, DynamoDB, AppSync Events, Cognito, CloudFront + WAF
board/                            the board web app (static; open board/index.html?demo to see it with sample data)
e2e/                              end-to-end runs of the real CLI and the real board against a local hub
docs/                             SPEC.md (design), CONTRACT.md (API/CLI contract), SECURITY.md, DEPLOY.md
```

## Try the board now

Open `board/index.html?demo` in a browser. It runs offline with sample data and a simulated event stream, and every button works locally.

## Run the whole thing locally

`cd backend && npm run local` starts a local hub on http://localhost:8787: the real API, hub logic and realtime protocol, with in-memory stand-ins for DynamoDB, S3, Cognito and AppSync Events. Open that URL to use the live board (sign in with any email), and point the CLI at it with `h1 join --code … --api http://localhost:8787`. See `e2e/README.md`.

## Set it up

Follow `docs/DEPLOY.md`:
1. Deploy `backend/` to the AWS sandbox account.
2. Invite people.
3. Install the plugin:
   ```
   /plugin marketplace add jakinluk/collab1
   /plugin install h1@hackathonone
   ```
4. Connect each Mac with `/h1:join`.

## Status

v0.3, built and tested locally: type-check, unit tests (backend 74, plugin 24), CDK synth, `claude plugin validate --strict`, and two end-to-end runs against the local hub (CLI: 96 checks with two seats; board in Chrome: 14 checks). **Not yet deployed to AWS.** The first deploy and the dry run in `docs/SPEC.md` §14 are the next steps. Open items: D2 (monitor vs channel) and checking that monitors wake idle sessions.
