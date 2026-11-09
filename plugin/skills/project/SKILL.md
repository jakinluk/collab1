---
name: project
description: Create or manage a CollabOne project — new project with repos and integration branches, list, edit, pin this seat to a project, freeze or archive. Changes are proposals a human approves in the board.
argument-hint: "new | list | edit <id> | pin <id> | freeze <id> | archive <id>"
disable-model-invocation: true
allowed-tools: Bash(c1 *), Bash(git *), Bash(gh *)
---
# Projects

Creating, changing, freezing and archiving projects are human actions. You draft them and submit a **proposal**; a human approves it in the board (any human can — open floor).

**new**
1. Ask for the project name (it becomes an id like `offline-capture`), a one-line description, its lanes (e.g. `mobile, api, web, infra`), tags, links (Slack channel, designs, PRD; https only) and the demo target (URL and/or stage).
2. For each repo, collect its metadata. Offer a preset from `${CLAUDE_PLUGIN_ROOT}/templates/repo-presets.json` (`nx-monorepo` for an Nx monorepo, `node-app`, `expo-app`) and adjust with the human:
   - name, git URL, base branch (default `main`), integration branch (default `hack/<project-id>`);
   - **hotPaths** (files no build ticket may touch: lockfiles, workspace config, CI, registrations) and **contractPaths** (shared contracts, owned only by contract/glue tickets);
   - `setup` commands for a fresh worktree, `verify` commands (typecheck, lint, unit), the instructions file (e.g. `CLAUDE.md`), a folder → lane map, PR labels, and notes for agents (e.g. "never run builds").
   Write it as `project.json` in the shape of `${CLAUDE_PLUGIN_ROOT}/templates/project.example.json` and show it to the human.
3. For each repo, create and push the integration branch from its base branch: `git fetch origin && git push origin origin/<baseBranch>:refs/heads/<integrationBranch>`. Ask before pushing.
4. `c1 project propose-new --file project.json` (quick form: `--name … --repo name=url --preset nx-monorepo --lane … --link Label=https://… --demo-url … --stage …`).
5. Print the approve link and ask the human to approve it in the board. After approval: everyone links their local checkouts (`c1 repo link <name> <path>`), then `/c1:goal` and `/c1:plan`.

**edit:** `c1 project show <id>` to see the current metadata, change `project.json`, then `c1 project propose-update <id> --file project.json` (or flags such as `--description`, `--link`, `--tag`, `--repo`). Repos are replaced as a whole list; removing a repo that still has active tickets is refused.

**list / show:** `c1 project list`, `c1 project show <id>` (repos with branches, protected paths, setup and verify commands, and whether each is linked on this Mac).
**pin:** `c1 me pin <id>` (this seat's autopilot books only from the pinned project; bookings in the old project are released first).
**edit / freeze / archive / phase:** `c1 project freeze|archive|activate|demo <id>` or `c1 project phase <id> <plan|build|freeze|demo>`, then share the approve link. Archiving can be contested by anyone for a few minutes.
