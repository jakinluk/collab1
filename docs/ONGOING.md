# Ongoing mode

Ongoing mode is CollabOne for day-to-day team work. Event mode (the hackathon) stays as it was. A hub runs in one mode, chosen at deploy time with `-c mode=event|ongoing`.

It is **agent-native**: agents can do every operation themselves. A human steps in when the hub asks for one, or whenever they want to steer the work or bring in a new business decision.

## What changes compared with event mode

| | Event mode | Ongoing mode |
| --- | --- | --- |
| End date | `eventEndsAt`, required | none |
| Data | every record expires 21 days after its last write | epics, tickets, inputs, decisions and change requests are kept; events expire after `eventRetentionDays` (90); join codes after 1 day; proposals after 30 days |
| Agent tokens | expire when the event ends | last `tokenTtlDays` (30); the plugin rotates them at session start in their last 7 days (`c1 token rotate` by hand) |
| Projects | projects with hackathon phases | the same records, shown as **epics** with a state, dates, milestones, owners and a priority |
| Repos | defined per project | added once to the **repo catalog**; epics refer to them (`repoRefs`) |
| Branches | `hack/<project>/…` into `hack/<project>` | `c1/<epic>/…` into the repo's base branch (`branchPrefix` setting) |
| Who may act | agents propose, humans approve | agents act; humans are needed only for the conditions below |
| Review | another seat must review | the same person may review (a second session, or the board) |
| Plan changes | a goal change only logs a contestable B5 record | **change requests** re-plan the epic |
| Removal policy | `destroy` | `retain` (table, user pool and skills bucket survive a stack delete) |

## The moving parts

- **Inputs:** a PRD, customer feedback, research or a note, in markdown. Inputs are versioned, and every heading becomes an anchor tickets can cite: `input:I1#status-email`. Add `{#anchor}` after a heading to keep its anchor when you reword it.
- **Decision records:** what was decided and why (`decision:R4`). Votes, closed escalations, applied change requests and moved target dates are recorded automatically. `c1 decision list` is the decision log.
- **Refs:** every build ticket says what it implements: `dod:d1` (a definition-of-done item with a stable id), `input:I1#anchor`, `input:I1` or `decision:R1`. Agents must give at least one on slice, contract, glue and test tickets. `c1 ticket show` prints the cited text under "Why".
- **Change requests:** opened by ingesting something new, by a changed input version, by a superseded decision, by a contract decision in another epic, by a changed definition of done, by resuming a paused epic, or by hand (`c1 change open`).
  - The hub picks the affected tickets mechanically: cited refs, owned or read contract paths, dependencies.
  - Open affected tickets turn **suspect**: nobody can book them, and they cannot be merged until the change request is decided.
- **Re-plan ticket:** each change request creates one. Any participant's agent picks it up (`c1 ticket next` offers it first) and runs `/c1:assess`. The agent:
  - gives every affected ticket a verdict: keep, amend, supersede, obsolete or defer; for merged work, rework or revert;
  - adds new tickets;
  - corrects the goal;
  - writes an impact summary.
- **Applying a change request:**
  - Every applied change request makes a new scope version. Two change requests can't silently overwrite each other: a stale one must be rebased (`c1 change rebase`).
  - **Done stays done.** Merged code that is now wrong gets a **rework ticket** that owns the files of the merged PRs. It also lists the merge commits and the acceptance criteria to retire.
- **Change log:** `c1 epic log`, or the board's Log tab, shows scope versions, change requests (opened, applied, rejected, with impact summaries) and decisions, newest first.

## When a human is needed

An agent may approve a change request itself, but it applies only after the contest window (`defaultContestMin`, 5 minutes). A human can stop it from the board or with `c1 change reject` until then. A human is required outright when a change request:

- reworks or reverts merged code;
- changes an existing goal or definition of done;
- stops work in progress (supersede, obsolete or defer of a booked ticket).

Epic changes that move a target date, archive the epic or change its owners also need a human, as do hub administration actions: repo catalog, settings, rules, releases and retention. In all these cases the agent's call becomes a proposal, and the CLI says why. The list of agent actions is the hub setting `agentActions`.

Several ingests in a row fold into the epic's open re-plan while nobody has assessed it yet, so one meeting's decisions make one re-plan.

## Start alone

1. Deploy (or run locally):
   ```bash
   cd backend && npx cdk deploy -c mode=ongoing -c domainPrefix=<unique-prefix>
   # locally: npx tsx scripts/local-hub.ts --mode ongoing
   ```
   Options: `-c tokenTtlDays=30 -c eventRetentionDays=90 -c logRetentionDays=90`.
2. Sign in to the board, create your seat, connect your Mac (`/c1:join`).
3. Ask your agent: "add our app repo to the CollabOne catalog" (`c1 catalog propose`, which you approve on the board), then "create an epic for X on it" (`c1 epic propose-new`).
4. Bring the PRD in: `/c1:ingest prd.md for <epic>`. It opens CR1 with a re-plan ticket. `/c1:assess CR1` turns the PRD into the first goal and tickets.
5. Work as usual: `c1 ticket next`, `/c1:work`, `/c1:review`. When merging, pass `--sha` and `--files` so later change requests can find the code.
6. When something changes, ingest it (`/c1:ingest`). The board's **Changes** tab shows what needs you.
7. Invite a teammate when it works for you. Add their seat to the epic owners (`c1 epic update --owner a,b`, approved by a human) and set who decides change requests (`--mode owners|open`).

## Switching an existing event hub

Switching works one way, event to ongoing:

1. Redeploy with `-c mode=ongoing` and without `eventEndsAt`. The removal policy defaults to `retain` in ongoing mode.
2. Run `c1 retention apply` and approve the proposal on the board. It removes the expiry from work records and gives the rest their new expiry.
3. Existing projects get epic fields the first time they are updated (`c1 epic update`).

## Not built yet

- The GitHub PR check: an ownership and scope commit status, with PR events moving tickets.
- Roles: admin, member and viewer.
- SSO.
- Deleting retired skill versions from S3.

See the plan doc for the order.
