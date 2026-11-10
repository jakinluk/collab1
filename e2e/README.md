# End-to-end runs

Every suite starts its own local hub (`backend/scripts/local-hub.ts`) on a free port, use fresh temporary homes, and clean up after themselves. They need `npm ci` in `backend/` first.

| Suite | Command | What it drives |
|---|---|---|
| CLI | `bash e2e/cli-e2e.sh` | the real `c1` CLI and hooks for two seats (ania, bob), with both `c1 watch` monitors running |
| Board | `cd e2e && npm ci && node board-e2e.mjs [--headed]` | the real board in Google Chrome (Playwright, channel `chrome`), with a real CLI seat on the agent side |
| CLI, ongoing mode | `bash e2e/ongoing-e2e.sh` | one person and their agent in ongoing mode: catalog, epic, PRD ingest → re-plan ticket → assessment → agent approval and contest window, build and merge, PRD v2 → suspect tickets → rework of merged code needing a human, decisions folding into one re-plan, a human rejecting it, moved target date, change and decision logs, token rotation, export |
| Board, ongoing mode | `cd e2e && node board-ongoing-e2e.mjs` | roadmap, epic editor, changes (approve and reject from the board), inputs and the decision log, adding and approving an input, the change log |

Set `PORT` to move the hub (defaults: 8791 CLI, 8792 board, 8793 ongoing CLI, 8794 ongoing board). The board suite writes screenshots to a temp folder, or to `SHOTS=<dir>`.

## What the CLI suite checks

Seats and join codes (single use; agents cannot mint them); `c1 doctor`'s hub checks; project, goal and plan through proposals (agents cannot approve; a plan that breaks the repo's contract paths is refused when proposed); booking, the double-booking conflict, the PreToolUse guard (allow, block on a protected path, warn Claude through `additionalContext`), review and merge, dependents becoming ready; B4 resolve → contest → human vote, a B1 agent vote, a ticket staying parked until every blocker on it has closed; B3 help and an agent answer; tips, playbooks, a skill synced into the other seat's `~/.claude/skills`, the secret scan, search, DMs and their privacy in event catch-up; the SessionStart, Stop (autopilot), Notification and heartbeat hooks; lease expiry; the CollabOne fix queue (`c1 bug`, secrets refused, area paths) and releases (proposal and approval, the `UPDATE` monitor line, `c1 version`, a minimum version blocking old agents' writes but not reads, the SessionStart warning, `c1 update` on an in-place install). Every monitor notification it expects is read from the `c1 watch` output.

## What the board suite checks

Cognito-style sign-in with PKCE, seat creation, a proposal arriving live and being approved, event history on load, goal and plan approval, a CLI booking moving a card live, resolving a B4 from the board, a second human contesting it from another browser and the vote, editing a rule, creating a join code and joining with it, creating a project in the board editor (including its validation), setting the CollabOne repo in Settings so a CLI bug opens the fix queue, and publishing a release that shows a banner on another open board. It fails on any uncaught page error.

## What only a real deploy can check

The local hub replaces AWS, so these still need the dry run in `docs/SPEC.md` §14: IAM and SigV4 publishing to AppSync Events, the Lambda authorizer wiring in API Gateway and AppSync, Cognito managed login with MFA, CloudFront, the optional WAF and the origin-verify header, DynamoDB Streams ordering and retries, the EventBridge Scheduler invoke, and S3 presigned URLs. Claude Code itself is not driven here either: whether a monitor notification wakes an idle session is still open.
