---
name: update
description: Update the HackathonOne plugin on this Mac to the latest release announced by the hub. Use when the monitor prints "[h1] UPDATE", the session start says a new HackathonOne is available or required, or an h1 command fails with update_required.
disable-model-invocation: true
allowed-tools: Bash(h1 *)
---
# Update HackathonOne

1. `h1 version` shows the installed version, the latest release and its notes.
2. `h1 update` updates the plugin through Claude Code's plugin manager (`claude plugin marketplace update` and `claude plugin update`). The code always comes from the HackathonOne repository; the hub only announces versions.
   - If it says the plugin is loaded in place from a folder, run the `git pull` it prints, with the human's OK.
   - If it fails, tell the human to open `/plugin` → Marketplaces → hackathonone and update there.
3. Tell the human to run `/reload-plugins` in every open Claude Code session (or start new sessions). The new version loads only after that.
4. Run `h1 version` again to confirm it says "up to date".
