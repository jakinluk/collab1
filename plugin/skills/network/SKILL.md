---
name: network
description: Check this Mac can reach the HackathonOne hub before joining or when the board, monitor or tickets stop updating. Use for "check connectivity", "the board isn't updating", "h1 doctor", Wi-Fi or hotspot problems.
argument-hint: "[board URL]"
allowed-tools: Bash(h1 *)
---
# Connectivity check

HackathonOne needs only internet: every Mac talks to the cloud hub, never to each other. Venue Wi-Fi is fine even if it isolates laptops.

1. Run `h1 doctor` (add `--api <board URL>/api/v1` if this Mac has not joined yet). It checks DNS, HTTPS to the API, a WebSocket to AppSync Events, GitHub, and the Anthropic API.
2. Read the table and act on the first failure:
   - **Everything fails, or HTTPS returns an HTML login page:** captive portal. Ask the human to open any website in a browser and accept the Wi-Fi terms, then rerun.
   - **HTTPS passes, WebSocket fails:** the network blocks WebSockets or long connections. Ask the human to switch to an iPhone Personal Hotspot (Settings → Personal Hotspot → Allow Others to Join) and rerun.
   - **Corporate proxy or VPN in the way:** use the hotspot, or disconnect the VPN for the event.
   - **Only GitHub or Anthropic fails:** the hub works, but Claude Code or git won't. Same fixes as above.
3. When everything passes, tell the human, and if they haven't joined yet, continue with `/h1:join`.

Never ask for or print tokens, and never change system network settings yourself.
