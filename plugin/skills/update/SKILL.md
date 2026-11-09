---
name: update
description: Update the CollabOne plugin on this Mac to the latest release announced by the hub. Use when the monitor prints "[c1] UPDATE", the session start says a new CollabOne is available or required, or an c1 command fails with update_required.
disable-model-invocation: true
allowed-tools: Bash(c1 *)
---
# Update CollabOne

1. `c1 version` shows the installed version, the latest release and its notes.
2. `c1 update` updates the plugin through Claude Code's plugin manager (`claude plugin marketplace update` and `claude plugin update`). The code always comes from the CollabOne repository; the hub only announces versions.
   - If it says the plugin is loaded in place from a folder, run the `git pull` it prints, with the human's OK.
   - If it fails, tell the human to open `/plugin` → Marketplaces → collabone and update there.
3. Tell the human to run `/reload-plugins` in every open Claude Code session (or start new sessions). The new version loads only after that.
4. Run `c1 version` again to confirm it says "up to date".
