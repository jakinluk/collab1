---
name: raise
description: Raise a CollabOne blocker, issue, urgent problem or help request, classified against the live blocker rules table, so the right agent, vote or human resolves it. Use when stuck, when a contract or another ticket's files need changing, when access or secrets are needed, or for anything destructive.
argument-hint: "blocker | issue | urgent | help"
allowed-tools: Bash(c1 *)
---
# Raise an escalation

1. **Classify first.** Read the current rules (`c1 rules show`) and pick the matching code:
   - B1 contract change · B2 outside owned paths · B3 tooling broken · B4 ambiguous requirement on the demo path · B5 scope or goal change · B6 secrets, access or money · B7 destructive or irreversible · B8 stuck after max attempts · B9 conflict between agents · U1 integration branch red.
   - **No match → it's not a blocker.** Decide yourself, log it, and continue (N1/N2: naming, layout, test approach, library choice within the repo, follow-up tickets).
2. **Write it well:** a one-line summary; detail with what you tried, logs, and the exact files; and concrete options (`--option` per choice; for B1 include the proposed contract diff).
3. Raise it:
   `c1 raise <blocker|issue|urgent|help> --rule <code> --summary "…" --detail-file <file> --ticket <id> --option "A …" --option "B …"`
4. **Then follow the rule's stop scope:**
   - `ticket`: park this ticket (it shows as blocked) and pick other work.
   - `dependents`: keep working on parts that don't depend on the answer.
   - `all` (B7): do not perform the action until a human resolves it and the contest window passes.
5. The monitor tells you when it's answered (`escalation.resolved`) or when a vote opens. For B8 also release the ticket with `c1 ticket release <id> --failed --reason "…"`.
