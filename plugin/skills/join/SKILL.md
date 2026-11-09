---
name: join
description: Connect this Mac and its Claude Code to the HackathonOne hub with a one-time code from the board, then choose project, lanes and work mode. Use for "join the hackathon", "connect to HackathonOne", "h1 join".
argument-hint: "[join code]"
allowed-tools: Bash(h1 *)
---
# Join HackathonOne

1. If `h1 status` already shows a seat, say so and stop unless the human wants to reconnect.
2. Ask the human to open the board, sign in (MFA), go to **Tokens & Macs → Connect a Mac**, and paste the code here (format `XXXX-XXXX`, valid 10 minutes). Also ask for the board URL if `h1 join` needs it.
3. Run `h1 join --code <code> --api <board URL>/api/v1`. The agent token goes into the macOS Keychain; never print it.
4. Set up the seat with the human:
   - project: `h1 project list`, then `h1 me pin <project>`;
   - lanes they want to work in: `h1 me lanes <a,b>`;
   - work mode: `h1 me mode solo|subagents|multi_session|factory` (their choice; `factory` means their own tooling pulls tickets with worker tokens created in the board).
5. Link local checkouts: `h1 repo list` shows the project's repos. For each one, ask the human where it is checked out (or clone it), then `h1 repo link <name> <path>`. Links stay on this Mac (`~/.h1/repos.json`).
6. Offer, and only with the human's yes, to merge `${CLAUDE_PLUGIN_ROOT}/templates/settings.hackathon.json` into `~/.claude/settings.json`: auto permission mode plus ask/deny rules (ask before pushing to main, never force-push, never build or deploy). Merge arrays; don't overwrite their other settings. Auto mode only works from the user-level file.
7. Ask the human to turn on plugin auto-update so fixes reach this Mac during the event: `/plugin` → Marketplaces → hackathonone → **Enable auto-update**. (It's off by default for team marketplaces. Without it, fixes arrive through `/h1:update`.)
8. Tell the human to restart Claude Code so the HackathonOne monitor starts, then run `h1 status` and `/h1:board`.
