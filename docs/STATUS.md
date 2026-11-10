# Status

Version 0.5.0. Event mode (hackathon) and ongoing mode (long-running epics, agent-native) are built and tested locally. Nothing is deployed yet.

## Built and verified

- Backend: 98 unit tests, typecheck, `cdk synth` in both modes.
- Plugin: 24 tests, `claude plugin validate --strict`.
- e2e: CLI event 96 checks, board event 14, CLI ongoing 51, board ongoing 10.
- Ongoing mode as described in `docs/ONGOING.md`: retention per record kind, token rotation, repo catalog, epics (states, dates, milestones, priority, owners), inputs with versioned sections, decision records, change requests (impact, suspect tickets, verdicts, rework, rebase, contest window), re-plan tickets on ingest, change log and decision log, export.

## Not built

In this order, unless the pilot says otherwise:

1. **First real use.** Deploy one ongoing hub (`docs/DEPLOY.md`), run one real epic alone, and push at least one real change request through. Fix what hurts via the fix queue.
2. **GitHub PR check.** A GitHub App sends PR webhooks (HMAC-verified). The PR is matched to a ticket by branch name. The hub posts a `collabone/ownership` commit status listing files outside the ticket's owned paths, plus hot and contract paths. PR events move tickets: opened → review, merged → done and claim released, closed unmerged → back to claimed or ready, CI red on the integration branch → U1. Suspect tickets fail a scope check. The hub never merges.
3. **Roles.** admin, member, viewer, and epic owners with a per-epic decision mode. Needed before a second person joins.
4. **Epic relay** (designed, see the relay doc below). The epic becomes the shared point between agents in different repos (for example backend and frontend):
   - `delivery: trunk | epic-branch`, with `integratedAt` (merged to the epic branch) separate from `deliveredAt` (reached the default branch), so progress counts integration and delivery separately;
   - a Release aggregate and `releaseOrder` across repos;
   - cross-repo read paths (`pathsRead: ["repo:glob"]`) so a contract change in one repo marks the other repo's tickets suspect;
   - an epic brief every session reads first, and journal notes (handoff, learning, question, risk) with refs that go stale when what they cite changes;
   - a drift guard that opens a sync ticket when one side of a contract moves.
5. SSO, deleting retired skill versions from S3, backups and a restore drill.

Not tested yet: an idle seat waking up on a monitor line.

## Open decisions

- Name it Epic in the API, or only in the UI.
- Default event-log retention (short with summaries, or keep).
- GitHub App or Action for the PR check (App first, Action as fallback).
- Personal data in customer feedback inputs: no policy yet; needed before feedback goes in.
- When an assessment agent is required (always, or only when merged code is hit).
- Changes coming from another epic: auto-draft a change request (current behaviour) or only notify.

## Design docs

The full plans live outside the repo (private to the author):

- Ongoing mode plan: https://claude.ai/artifact/VyeduMLXopFpMMazMTvkn4
- Epic relay proposal (backend and frontend agents on one epic): see the author's artifacts.

When a plan is accepted, write the parts that matter into `docs/SPEC.md` and `docs/CONTRACT.md`.
