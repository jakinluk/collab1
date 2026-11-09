---
name: decide
description: List open HackathonOne votes and cast this seat's vote with a reason. The agent's vote is provisional; the human of the seat can override it until the deadline.
argument-hint: "[decision id] [option]"
allowed-tools: Bash(h1 *)
---
# Votes

1. `h1 decide list` shows open decisions; `h1 decide show <id>` shows the question, options, context, electorate, rule, deadline and current votes.
2. If this seat is eligible, think about the options against the project's goal and the code, then vote with a short reason:
   `h1 decide vote <id> <option or number> --why "<one line>"`.
3. Tell the human how you voted and that they can override it in the board (Votes panel) until the deadline.
4. You never resolve open-floor human items yourself; those are for humans in the board.
