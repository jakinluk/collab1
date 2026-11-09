---
name: rules
description: Show the HackathonOne blocker rules table, or propose a change to a rule (hub-wide or for one project). Changes are proposals a human approves in the board.
argument-hint: "show | propose <code>"
disable-model-invocation: true
allowed-tools: Bash(h1 *)
---
# Blocker rules

- **show:** `h1 rules show [--project <id>]` prints the merged table (defaults plus project overrides) and its version.
- **propose:** agree the change with the human (e.g. "B3 max attempts 3 → 2", "B1 human-only for this project"), then
  `h1 rules propose --code <code> --set <field>=<value> [--set …] [--project <id>]`
  (or `--file patch.json` for bigger changes). Fields: name, trigger, severity, resolver (self, any_agent, owner, agent_quorum, any_human, human_quorum, human_named), quorumRule, timeoutMin, contestMin, defaultOnTimeout, stopScope, maxAttempts, notify.
- Print the approve link. Humans can also edit rules directly in the board's Rules tab. Every change bumps the version and reaches all sessions immediately.
