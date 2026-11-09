---
name: assess
description: Re-plan an epic after a change request (a new or changed PRD, feedback, business decision, contract change, or resume after a pause) — read what changed and every impacted ticket, give each a verdict, add the tickets the change needs, correct the goal, write the impact summary and submit it. Use when a re-plan ticket is booked or a CR needs assessing.
argument-hint: "<change request id, e.g. CR3>"
allowed-tools: Bash(c1 *), Bash(git *), Read, Write
---
# Assess change request $ARGUMENTS

You are re-planning an epic. The hub found the impacted tickets mechanically (cited refs, contract paths, dependencies); your job is the judgement. Nothing changes until the assessment is approved.

1. **Book the re-plan ticket** if you haven't: `c1 change show $ARGUMENTS` names it in the change; `c1 ticket book <id>`.
2. **Read the change.** `c1 change show $ARGUMENTS` prints the reason, the changed and added refs, the before/after text of changed input sections, and every impacted ticket with why it was picked. Then read:
   - the epic: `c1 epic show <epic>` (goal, definition of done with ids, milestones);
   - each impacted ticket: `c1 ticket show <id>` (its card ends with the cited text);
   - the inputs and decisions involved: `c1 input show <I> --sections`, `c1 decision show <R>`;
   - for done tickets, the merged code: the card has the merge commit and files. Look at them in the repo checkout (`c1 repo path <repo>`) before deciding between keep, rework and revert.
3. **Look beyond the list.** The mechanical list misses tickets that don't cite the changed refs but are still affected. Scan `c1 ticket list` for the epic and add any you find to the assessment (they become suspect too).
4. **Decide a verdict for every impacted ticket:**
   - not done: `keep` · `amend` (give the new title, description, acceptance, refs, paths) · `supersede` (a new ticket replaces it; list it in that ticket's `supersedes`) · `obsolete` · `defer` (out of the current milestone);
   - done: `keep` · `rework` (the merged code must change; tickets sharing a `group` get one rework ticket, same repo only; give its `acceptance`) · `revert` (small, isolated merges only).
   Prefer the smallest change that makes the plan true again. Don't amend a booked ticket's owned paths: supersede it instead.
5. **Add new tickets** for anything the change adds (`newTickets`, each with a short `key`, `repo`, `pathsOwned`, `acceptance` and `refs` citing what it implements; `deps` may name other keys).
6. **Correct the goal** when the change moves it: `scope` with `statement`, `definitionOfDone` (keep ids: `{ "id": "d2", "text": "…" }` for changed items, plain strings for new ones) and `nonGoals`.
7. **Write the impact summary** (`summary`): a few sentences for the change log: what changes for the epic, what work is lost or redone, what is new, any risk.
8. **Submit:** write the JSON to a temp file and run `c1 change assess $ARGUMENTS --file <file>`. Shape:
   ```json
   { "impact": [{ "ticketId": "T12", "verdict": "amend", "amend": { "acceptance": [{ "criterion": "…" }] }, "note": "why" }],
     "newTickets": [{ "key": "digest", "repo": "app", "title": "…", "pathsOwned": ["…"], "acceptance": [{ "criterion": "…" }], "refs": ["input:I1#status-email"], "supersedes": ["T13"] }],
     "scope": { "definitionOfDone": [{ "id": "d1", "text": "…" }, "new item"] },
     "summary": "…" }
   ```
   Fix any validation error and submit again. The re-plan ticket closes itself when every impacted ticket has a verdict.
9. **Approve or hand over.** `c1 change show $ARGUMENTS` says whether a human must decide (rework of merged code, a goal change, or stopping work in progress). If not, `c1 change approve $ARGUMENTS`: it applies after the contest window unless a human stops it. If a human must decide, tell the user what they are approving and stop.
