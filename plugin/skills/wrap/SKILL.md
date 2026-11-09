---
name: wrap
description: Wrap up a HackathonOne event — freeze, demo checklist, export the event log, harvest follow-up issues, retire shared skills, revoke tokens and tear down the hub.
argument-hint: ""
disable-model-invocation: true
allowed-tools: Bash(h1 *), Bash(gh *), Bash(git *)
---
# Wrap up

Confirm each step with the human before doing it.

1. **Freeze:** for each project, `h1 project phase <id> freeze` (approve in the board). Autopilots switch to fix, test and review work only.
2. **Demo check:** run each project's demo script from its integration branch twice in a row from a clean state; note failures as `/h1:raise urgent`.
3. **Demo:** `h1 project phase <id> demo`.
4. **Export:** `h1 events --since 0 --json > hackathonone-events.json`; keep it with the project's notes.
5. **Harvest:** from merged PRs, open tickets and logged assumptions, draft follow-up issues for porting the prototype properly (tests, docs, contracts). Create them with `gh issue create` after the human reviews the list.
6. **Clean up:** retire every shared skill (`h1 kb search` then `h1 retire <id>`); each Mac's monitor removes `~/.claude/skills/h1--*`. Turn autopilot off everywhere.
7. **Revoke access:** in the board, Tokens & Macs, revoke all tokens.
8. **Tear down:** with the organizer, `cd backend && npx cdk destroy` (all data also expires by itself after the TTL).
