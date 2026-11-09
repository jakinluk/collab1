---
name: share
description: Share knowledge with every HackathonOne participant — a short tip, a markdown playbook, or a temporary Claude Code skill that syncs to everyone's machine. Use after solving tooling or setup problems, or when a procedure worked after several attempts.
argument-hint: "tip | playbook <file> | skill <dir> | retire <id>"
allowed-tools: Bash(h1 *)
---
# Share knowledge

Never include secrets, tokens, passwords or personal data; the CLI and the hub both scan and refuse them.

- **tip** (one or two lines): `h1 share tip "<what to do and why>" [--tags a,b] [--project <id>]`.
- **playbook** (a markdown procedure): write the file, then `h1 share playbook <file.md> --name "<title>"`.
- **skill** (best for repeatable procedures such as building, launching or testing the mobile app):
  1. Create a directory with a `SKILL.md` at its root: frontmatter `name: h1-<short-name>` and a `description` that says when to use it ("Use whenever you need to build, launch or e2e-test the mobile app"), then the exact commands and pitfalls.
  2. `h1 share skill <dir>`. Every participant's monitor installs it into `~/.claude/skills/h1--<name>/`, and Claude Code picks it up without a restart.
  3. Publishing again with the same name creates a new version.
- **retire:** `h1 retire <knowledge id>` removes a bad skill or tip everywhere.
- Search what exists first: `h1 kb search <words>`.
