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
2. **Scopes instead of file locks, and overlap across epics.** Next code change. Decided on 2026-11-10.
   - Today booking takes a hard lock on the ticket's owned path prefixes (`lockOps` in `app/hub.ts`, `path_conflict` in `core/tickets.ts`). Locks are keyed per project (`K.lock(projectId, …)`), so two epics on the same repo are not kept apart at all.
   - Ongoing mode: drop the hard lock. Booking an overlapping ticket is allowed and its card warns ("T7 also touches `src/api/router.ts`, expect a merge"). Event mode keeps hard locks.
   - Keep the plan-time check that tickets in one wave with no dependency don't own overlapping paths (`core/plan.ts`): ticket scopes must not overlap.
   - Hot and contract paths stay hard: only contract or glue tickets own them.
   - **Barrier tickets** for heavy refactors (`barrier: true`): while one is open, no new claims start in that epic's repo; in-flight tickets finish and merge; then the refactor runs alone. If the refactor changes what planned tickets must do, it opens a change request so those tickets go suspect and get amended after it merges. An agent may mark a barrier; it applies after the contest window, so a human can stop it.
   - **Cross-epic overlap alerts.** Overlap is checked per repo across all epics, at three points: planning (an epic's new tickets own paths that another epic's open tickets own), booking, and merge (`--files` touch paths another epic's open tickets own). Plain paths: an `OVERLAP` monitor line to followers of both epics and an item on both boards, with the other epic's ticket, owner and paths. Hot or contract paths: a B1 between the two epics' agents. A merge that touched another epic's open area marks those tickets "rebase advised", not suspect, unless a contract path changed.
3. **GitHub PR check.** A GitHub App sends PR webhooks (HMAC-verified). The PR is matched to a ticket by branch name. The hub posts a `collabone/ownership` commit status listing files outside the ticket's owned paths, plus hot and contract paths. PR events move tickets: opened → review, merged → done and claim released, closed unmerged → back to claimed or ready, CI red on the integration branch → U1. Suspect tickets fail a scope check. The hub never merges.
4. **Roles.** admin, member, viewer, and epic owners with a per-epic decision mode. Needed before a second person joins.
5. **Epic relay** (designed, see the relay doc below). The epic becomes the shared point between agents in different repos (for example backend and frontend):
   - `delivery: trunk | epic-branch`, with `integratedAt` (merged to the epic branch) separate from `deliveredAt` (reached the default branch), so progress counts integration and delivery separately;
   - a Release aggregate and `releaseOrder` across repos;
   - cross-repo read paths (`pathsRead: ["repo:glob"]`) so a contract change in one repo marks the other repo's tickets suspect;
   - an epic brief every session reads first, and journal notes (handoff, learning, question, risk) with refs that go stale when what they cite changes;
   - a drift guard that opens a sync ticket when one side of a contract moves.
6. **Knowledge across epics.** Knowledge travels with the code area, not the epic, and reaches agents in their ticket brief instead of a wiki nobody opens:
   - three levels: hub (tips, playbooks, skills, which exist today with scope `global` or a project), repo area (new: a note anchored to a catalog repo and path globs, such as "how auth works in `src/auth/**`"), and epic (journal notes from the relay);
   - the ticket brief includes every repo-area note whose globs match the ticket's owned or read paths, from any epic;
   - when an epic reaches `done`, the hub opens a harvest ticket: an agent turns the epic's `learning` journal notes into repo-area notes or hub tips, and drops the rest;
   - a note goes stale when files under its globs change in a merge it does not cite, and the next agent working there is asked to confirm or fix it;
   - decisions and inputs are already hub-level and can be linked to several epics; a contract decision already drafts a change request in every epic using that repo.
7. SSO, deleting retired skill versions from S3, backups and a restore drill.

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
