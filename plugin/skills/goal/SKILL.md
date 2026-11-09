---
name: goal
description: Draft and propose the goal of a HackathonOne project — goal statement, definition of done, demo script and non-goals. Always scoped to one project (the pinned one unless --project is given).
argument-hint: "[--project <id>]"
disable-model-invocation: true
allowed-tools: Bash(h1 *)
---
# Project goal

1. Find the project: the pinned one (`h1 status`) unless the human named another (`--project <id>`). Show the current goal with `h1 goal show [--project <id>]`.
2. Draft with the human, briefly and concretely:
   - **statement:** one sentence a customer would understand;
   - **definitionOfDone:** 3–6 checks that can be demonstrated;
   - **demoScript:** the exact steps of the demo;
   - **nonGoals:** what is explicitly out.
   Use `${CLAUDE_PLUGIN_ROOT}/templates/goal.example.json` as the shape.
3. Write it to a file in the session's working directory and run `h1 goal propose --file <file> [--project <id>]`.
4. Print the approve link. If the project already had a goal, tell the human this is a scope change (rule B5): once approved, anyone can contest it during the contest window.
5. After approval, suggest `/h1:plan`.
