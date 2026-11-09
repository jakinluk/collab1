---
name: review
description: Review and merge another participant's CollabOne PR — never your own seat's ticket. Check acceptance and repo rules, then squash-merge into the repo's integration branch or request changes.
argument-hint: "[ticket id]"
allowed-tools: Bash(c1 *), Bash(git *), Bash(gh *)
---
# Review a ticket

1. Pick one: `c1 review next` (books the oldest ticket in review that this seat didn't author), or the id the human gave. You never review your own seat's tickets.
2. Read the card (`c1 ticket show <id>`) and the PR (`gh pr view <url>`, `gh pr diff <url>`).
3. Find the repo's checkout with `c1 repo path <repo>` (link it if needed), check out the PR branch in a fresh worktree there, and run the repo's `setup` commands. Run every acceptance `cmd` and the repo's `verify` commands through `"${CLAUDE_PLUGIN_ROOT}/scripts/test-lock.sh" <cmd>`, following the repo notes (for example, an Nx monorepo whose notes say never run builds).
4. Review against the acceptance criteria, owned paths (no edits outside `pathsOwned`), the repo's hot and contract paths untouched unless the ticket is a contract or glue ticket, and the repo's CLAUDE.md critical rules. Fix trivial issues yourself (push to the PR branch); request changes for anything bigger.
5. Outcome:
   - **merged:** `gh pr merge <url> --squash`, then `c1 review done <id> --outcome merged --sha <merge commit> --files "<changed paths, comma separated>"` (`gh pr view <url> --json mergeCommit,files`). This frees the ticket's locks and unblocks its dependents; the sha and files let later change requests find this code. If the hub refuses because the ticket is suspect, don't merge: wait for the change request.
   - **changes requested:** comment on the PR, then `c1 review done <id> --outcome changes_requested --note "<what to fix>"`.
6. If the integration branch is red after a merge (rule U1), revert first (`gh pr revert` or a revert commit) and raise it with `/c1:raise urgent`.
