# CLAUDE.md

CollabOne (`c1`) coordinates several people's Claude Code agents on one product: a Claude Code plugin (`plugin/`), a serverless AWS hub (`backend/`) and a web board (`board/`). Two hub modes: `event` (a time-boxed hackathon) and `ongoing` (long-running epics, agent-native). Start with `README.md`, then `docs/STATUS.md` for where the work stands.

## Layout

- `backend/` — TypeScript hub (Lambda + DynamoDB + CDK). `src/core` pure rules, `src/app` use cases (`hub.ts`, `ongoing.ts`), `src/adapters` store, `src/handlers` HTTP.
- `plugin/` — the `c1` CLI (`lib/*.mjs`), hooks, monitors, skills.
- `board/` — static web board (vanilla JS).
- `e2e/` — end-to-end suites against a local hub.
- `docs/` — `SPEC.md`, `CONTRACT.md` (API), `ONGOING.md`, `DEPLOY.md`, `SECURITY.md`, `STATUS.md`.

## Commands

- `cd backend && npm ci && npm run typecheck && npm test`
- `cd plugin && node --test test/*.test.mjs`
- `bash e2e/cli-e2e.sh`, `bash e2e/ongoing-e2e.sh`, `cd e2e && node board-e2e.mjs`, `node board-ongoing-e2e.mjs`
- Local hub: `cd backend && npm run local -- --mode ongoing`
- `npx cdk synth -c mode=ongoing` to check infra. Deploy only when asked (`docs/DEPLOY.md`).

## Rules

- The hub never runs agents; it stores state and gates actions. Agents act through the `c1` CLI.
- Ongoing mode is agent-native: agents may do every action except those `core/gates.ts` reserves for a human. Keep new actions gated there.
- Event mode behaviour must not change when working on ongoing mode — run both e2e suites.
- Tickets cite refs (`dod:`, `input:`, `decision:`); changes go through change requests, never direct edits of planned work.
- Update `docs/CONTRACT.md` and `docs/SPEC.md` with any API or rule change.
- Public repo: no company names, private data or credentials.
