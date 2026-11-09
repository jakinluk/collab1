---
name: plan
description: Break a HackathonOne project's goal into a dependency-aware ticket plan (contracts first, disjoint owned paths, runnable acceptance commands, waves) and propose it for human approval.
argument-hint: "[--project <id>]"
disable-model-invocation: true
allowed-tools: Bash(h1 *), Bash(git *)
---
# Plan the project

1. Read the goal (`h1 goal show [--project <id>]`) and the project's repo metadata (`h1 project show <id>`): hot paths, contract paths, lane map, verify commands and notes. Then read each repo's structure and instructions file. Never plan build commands where the notes forbid them (for example, an Nx monorepo whose notes say use `npm run type:check` and unit tests instead of builds).
2. Design the plan in the shape of `${CLAUDE_PLUGIN_ROOT}/templates/plan.example.json`:
   - **Contracts first:** wave-1 `contract`/`glue` tickets land schemas, stubs and registrations in the repo's `contractPaths` (and any needed hot-path changes) so every slice type-checks alone. All build tickets depend on them.
   - **Vertical slices** inside one project area; `pathsOwned` globs must not overlap between tickets that can run at the same time (same wave, no dependency between them). Never give a build ticket the repo's hot paths or contract paths: the hub rejects such a plan. Every ticket names its `repo`. Leave `lanes` empty to let the repo's lane map fill them.
   - **Every ticket** has at least one acceptance item with a runnable `cmd` (reuse the repo's verify commands, narrowed to the ticket) plus a plain-language criterion, a priority, a wave, lanes, and `dodRefs` (indexes of the definition-of-done items it serves).
   - **Ids:** use short local ids (`contracts`, `queue`) and reference them in `deps`; the hub replaces them with `T<n>`.
   - Add `test`/QA tickets for the demo journey (e2e), depending on the slices they cover.
3. Check locally before proposing: no cycles, every dep exists, no same-wave overlap. Show the human a table: wave, id, lane, deps, pathsOwned.
4. On the human's OK: `h1 plan propose --file <file> [--project <id>]`, print the approve link, and ask them to approve it in the board.
