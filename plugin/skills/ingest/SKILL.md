---
name: ingest
description: Bring a PRD, customer feedback, research or a business decision into CollabOne so the epics it affects get re-planned — add or version the input (or record the decision), link it to its epics and approve it. Use when the user shares a document, feedback or a decision that should change what the team builds.
argument-hint: "<file, or a short description of the decision>"
allowed-tools: Bash(c1 *), Read
---
# Ingest: $ARGUMENTS

Inputs and decisions are how the team tells the agents why. Ingesting one opens a change request with a re-plan ticket in every epic it touches; any agent can pick that up with /c1:assess.

1. **Which epics?** `c1 epic list`. Ask the user if it isn't clear which epics this is for.
2. **A document** (PRD, feedback, research, notes):
   - New: `c1 input add <file.md> --kind prd|feedback|research|note --title "…" --project <epic>` (repeat `--project` or give a comma list for several epics).
   - New version of an existing input: `c1 input list`, then `c1 input version <I> <file.md> --note "what changed"`. The output shows which sections changed.
   - Headings become anchors that tickets cite (`input:I3#pricing`). Keep headings stable between versions; add `{#anchor}` after a heading to pin its anchor when you reword it.
   - Remove names, emails, phone numbers and other personal data from customer feedback before adding it, unless the user says it may stay.
3. **A decision:** `c1 decision propose --project <epic> --title "the question" --choice "what was decided" --reason "why"`. Add `--supersedes R<n>` when it replaces an earlier decision, and `--contract-repo <repo> --contract-path <glob>` when it changes a shared contract other epics use.
4. **Approve** the input: `c1 input approve <I>`. In ongoing mode an agent may do this itself; a human can still steer later by rejecting the change request it opens.
5. **Report** the change requests that were opened (`c1 change list`) and their re-plan tickets, and offer to run /c1:assess on one now.
