# Deploying and running CollabOne

Full backend details: `backend/README.md`. This page is the organizer's checklist from an empty AWS sandbox to a running hackathon. For a hub for everyday work, deploy with `-c mode=ongoing` instead of `-c eventEndsAt=…` and follow `docs/ONGOING.md`.

## 1. Before the offsite

1. **Get access.** You need AWS credentials for a **sandbox** AWS account (never production), Node ≥ 22, the AWS CLI v2, `git`, and `gh` (logged in).
2. **Run it locally first** (no AWS needed): `bash e2e/cli-e2e.sh` and `cd e2e && npm ci && node board-e2e.mjs`. Both should end with `0 failed`. See `e2e/README.md` for what they cover and what only the deployed stack can show.
3. **Deploy:**
   ```bash
   cd backend && npm ci && npm run typecheck && npm test
   npx cdk bootstrap aws://<sandbox-account>/us-east-1        # once per account
   npx cdk deploy -c eventEndsAt=<ISO end of the event> -c domainPrefix=<unique-prefix> -c toolRepoUrl=<git URL of this repo>
   scripts/smoke.sh                                            # health, auth rejections, origin check
   ```
   Note the outputs, especially `BoardUrl` and `ApiUrl`.
4. **Invite everyone:** `scripts/invite.sh alice@… bob@…`. Each person:
   1. opens `BoardUrl`;
   2. sets a password and an authenticator app (MFA is mandatory);
   3. creates their seat.
5. **Install the plugin on every MacBook**, inside Claude Code:
   ```
   /plugin marketplace add jakinluk/collab1
   /plugin install c1@collabone
   ```
   Choose project scope in the repos you will hack in.
6. **Connect each Mac:**
   1. Board → **Tokens & Macs** → **Connect a Mac**. This gives a one-time code valid for 10 minutes.
   2. In Claude Code, run `/c1:join` (or paste the command the board shows: `c1 join --code XXXX-XXXX --api <BoardUrl>`).
   3. Restart Claude Code so the monitor starts.
7. **Dry run** with the checklist in `docs/SPEC.md` §14: `c1 doctor` on venue-like Wi-Fi and a hotspot, one ticket through work → review → merge, a proposal approved in the board, token revocation.

## 2. At the offsite

**Fixing CollabOne on the day** (details: `docs/SPEC.md` §8.5):
- One or two people pin to the `collabone` project and work its tickets; everyone else reports problems with `/c1:bug`.
- Backend or board fix: merge, then `npx cdk deploy` with the same `-c` values as the first deploy.
- Plugin fix: bump `plugin/.claude-plugin/plugin.json` `version`, merge to the branch the marketplace serves, then **Settings → CollabOne releases → Publish** (or `c1 release propose`). Add a minimum version only for changes old Macs must not miss. People run `/c1:update` and `/reload-plugins`.


1. `/c1:network` on every Mac. If `c1 doctor` fails on WebSockets, switch to an iPhone Personal Hotspot.
2. `/c1:project new` per idea. Each one creates `hack/<project>` branches and proposes the project; approve it in the board.
3. `/c1:goal` per project, then approve it.
4. `/c1:plan`, then approve the ticket graph.
5. Everyone runs `/c1:autopilot on` in their chosen work mode. Humans watch **Needs a human** and **Votes** on the board (projector mode on the venue TV).
6. Phase calls (`freeze`, `demo`) go from the board's Settings or the project menu.

## 3. After

1. `/c1:wrap`: export the event log, harvest follow-up issues, retire shared `c1--*` skills, revoke all tokens.
2. `cd backend && npx cdk destroy` (or keep it until the TTL clears the data).
