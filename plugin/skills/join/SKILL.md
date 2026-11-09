---
name: join
description: Connect this Mac and its Claude Code to the CollabOne hub with a one-time code from the board, then choose project, lanes and work mode. Use for "join the hackathon", "connect to CollabOne", "c1 join".
argument-hint: "[join code]"
allowed-tools: Bash(c1 *)
---
# Join CollabOne

1. If `c1 status` already shows a seat, say so and stop unless the human wants to reconnect.
2. Ask the human to open the board, sign in (MFA), go to **Tokens & Macs → Connect a Mac**, and paste the code here (format `XXXX-XXXX`, valid 10 minutes). Also ask for the board URL if `c1 join` needs it.
3. Run `c1 join --code <code> --api <board URL>/api/v1`. The agent token goes into the macOS Keychain; never print it.
4. Set up the seat with the human:
   - project: `c1 project list`, then `c1 me pin <project>`;
   - lanes they want to work in: `c1 me lanes <a,b>`;
   - work mode: `c1 me mode solo|subagents|multi_session|factory` (their choice; `factory` means their own tooling pulls tickets with worker tokens created in the board).
5. Link local checkouts: `c1 repo list` shows the project's repos. For each one, ask the human where it is checked out (or clone it), then `c1 repo link <name> <path>`. Links stay on this Mac (`~/.c1/repos.json`).
6. Offer, and only with the human's yes, to merge `${CLAUDE_PLUGIN_ROOT}/templates/settings.hackathon.json` into `~/.claude/settings.json`: auto permission mode plus ask/deny rules (ask before pushing to main, never force-push, never build or deploy). Merge arrays; don't overwrite their other settings. Auto mode only works from the user-level file.
7. Ask the human to turn on plugin auto-update so fixes reach this Mac during the event: `/plugin` → Marketplaces → collabone → **Enable auto-update**. (It's off by default for team marketplaces. Without it, fixes arrive through `/c1:update`.)
8. Tell the human to restart Claude Code so the CollabOne monitor starts, then run `c1 status` and `/c1:board`.
