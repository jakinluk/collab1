---
name: bug
description: Report a problem with HackathonOne itself (the h1 CLI, hooks, monitor, skills, board or hub) to the team's fix queue. Use when an h1 command fails in a way that isn't your mistake, the board shows something wrong, a hook blocks something it shouldn't, or a skill's instructions don't work.
argument-hint: "\"what went wrong\""
allowed-tools: Bash(h1 *)
---
# Report a HackathonOne problem

This is for problems with the tool, not with the product you are building. Product problems go through `/h1:raise`.

1. Check it isn't already reported: `h1 ticket list --project hackathonone`.
2. File it with enough detail for someone else's Claude to reproduce it:
   ```
   h1 bug "<one line: what went wrong>" --area plugin|board|backend|docs --detail "<command you ran, what you expected, what happened, exact error text>"
   ```
   - Add `--urgent` only if it stops people working (joins fail, booking fails, the guard blocks every edit).
   - Never paste tokens, secrets or personal data; the CLI and the hub refuse them.
3. Keep working. Use a workaround if there is one and say which in the report. Don't edit HackathonOne's own files from a product ticket.
4. When a fix ships, the monitor prints `[h1] UPDATE …`: run `/h1:update`.
