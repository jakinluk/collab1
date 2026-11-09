---
name: work
description: Implement one CollabOne ticket end to end — book it, work in an isolated worktree on its ticket branch, respect owned paths and contracts, verify with its acceptance commands, push and open a PR into the repo's integration branch, and update the board.
argument-hint: "<ticket id>"
allowed-tools: Bash(c1 *), Bash(git *), Bash(gh *)
---
# Work a ticket: $ARGUMENTS

1. **Card.** `c1 ticket show $ARGUMENTS`. If this seat hasn't booked it, `c1 ticket book $ARGUMENTS --session "$C1_SESSION_ID"`; on exit code 2 stop and report why.
2. **Repo and worktree.** The card's Repo section names the repo and its branches, setup and verify commands, instructions file and notes.
   - Find the checkout: `c1 repo path <repo>`. Exit code 2 means it isn't linked: ask the human for the path (or clone it) and run `c1 repo link <repo> <path>`.
   - Create the worktree inside that checkout (`git -C <path> worktree add .claude/worktrees/$ARGUMENTS`) and work there.
   - Use the branch the card names (`Branch:`; for example `hack/<project>/$ARGUMENTS-<slug>` at a hackathon, `c1/<epic>/…` in ongoing mode) from `origin/<integrationBranch>` (fetch first). If that branch already exists on origin (an earlier attempt), check it out and continue from it.
   - Run the repo's `setup` commands in the fresh worktree, and read its instructions file (e.g. `CLAUDE.md`) and notes before changing anything.
3. **Start.** `c1 ticket start $ARGUMENTS`. Re-read the card: `pathsOwned` are yours; contracts (`pathsRead`) and everything else are read-only. The guard hook blocks edits to other tickets' paths and to the repo's hot paths and contract paths (contract paths are open only to contract and glue tickets).
4. **Use shared knowledge first.** Check `c1 kb search <topic>` and any `c1--*` skills (e.g. how to run the mobile app or the tests) before figuring things out yourself.
5. **Implement** following the repo's CLAUDE.md. Commit early (WIP commits are fine) and **push after each meaningful step** so another seat can continue if this session dies.
6. **Verify.** Run every acceptance `cmd` and the repo's `verify` commands through the machine-wide lock: `"${CLAUDE_PLUGIN_ROOT}/scripts/test-lock.sh" <cmd>`. Follow the repo notes (for example, an Nx monorepo whose notes say never run builds). Iterate until green.
7. **Problems.** Classify against the blocker rules (shown at session start; `c1 rules show`). If no rule matches, decide yourself and log it in the PR. If a rule matches, use `/c1:raise`. For B1/B2 never work around a contract or another ticket's files.
8. **PR.** Rebase on `origin/<integrationBranch>`, re-run acceptance, push, then `gh pr create --base <integrationBranch> --label <each prLabel> --title "[$ARGUMENTS] <title>" --body "<card summary, what changed, how verified, known gaps>"`. Then `c1 ticket review-ready $ARGUMENTS --pr <url>`.
9. **If the ticket turns suspect** (the monitor says a change request may change it): finish to a clean checkpoint, push, and wait or take other work; it cannot be merged until the change request is decided. If it is amended, re-read the card; if it is superseded or dropped, stop and release.
10. **After review.** If the reviewer requests changes, fix them in the same worktree and push. When it's merged, share anything reusable you learned (`/c1:share`).
