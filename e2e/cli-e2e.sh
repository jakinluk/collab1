#!/usr/bin/env bash
# End-to-end run of the real h1 CLI against the local hub (backend/scripts/local-hub.ts).
# Two seats (ania, bob) on one machine, each with its own H1_HOME and HOME.
# Usage: e2e/cli-e2e.sh            (starts its own hub on PORT, default 8791)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8791}"
B="http://localhost:$PORT"
A="$B/api/v1"
H1="$ROOT/plugin/bin/h1"
WORK="$(mktemp -d)"
PASS=0
FAIL=0
PIDS=()

cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  pkill -f "local-hub.ts --port $PORT" 2>/dev/null
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/       /' | head -20; }
# expect <name> <expected exit> <grep regex or ''> -- command...
expect() {
  local name="$1" code="$2" pat="$3"
  shift 4
  local out rc
  out="$("$@" 2>&1)"
  rc=$?
  if [ "$rc" != "$code" ]; then bad "$name (exit $rc, wanted $code)" "$out"; return 1; fi
  if [ -n "$pat" ] && ! grep -Eq -- "$pat" <<<"$out"; then bad "$name (no match for /$pat/)" "$out"; return 1; fi
  ok "$name"
  LAST="$out"
}
as() { local seat="$1"; shift; H1_HOME="$WORK/$seat/h1" HOME="$WORK/$seat/home" H1_TOKEN_FILE=1 "$H1" "$@"; }
human() { cat "$WORK/$1.jwt"; }
api() { local seat="$1" method="$2" path="$3" body="${4:-}"; curl -s -X "$method" "$A$path" -H "authorization: Bearer $(human "$seat")" ${body:+-H 'content-type: application/json' -d "$body"}; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
watchlog() { cat "$WORK/$1/watch.log"; }
waitfor() { # waitfor <seat> <regex>: wait up to 5 s for a monitor line
  for _ in $(seq 1 50); do grep -Eq -- "$2" "$WORK/$1/watch.log" && return 0; sleep 0.1; done
  return 1
}
seen() { if waitfor "$1" "$2"; then ok "$1 monitor: $3"; else bad "$1 monitor: $3" "$(watchlog "$1" | tail -8)"; fi; }

echo "== local hub on $B (work dir $WORK)"
(cd "$ROOT/backend" && exec npx tsx scripts/local-hub.ts --port "$PORT" --sweep-ms 600000 >"$WORK/hub.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 100); do curl -sf "$A/health" >/dev/null && break; sleep 0.2; done
expect "hub health" 0 '"ok":true' -- curl -sf "$A/health"

for s in ania bob; do
  mkdir -p "$WORK/$s/h1" "$WORK/$s/home"
  curl -s -X POST "$B/_dev/token?email=$s@example.com" | json 'd["idToken"]' >"$WORK/$s.jwt"
done

echo "== seats and join"
expect "ania creates her seat in the board" 0 '"id":"ania"' -- api ania POST /seats/me '{"id":"ania","name":"Ania","plan":"ultra","lanes":["api"]}'
expect "bob creates his seat in the board" 0 '"id":"bob"' -- api bob POST /seats/me '{"id":"bob","name":"Bob","plan":"ultra","lanes":["mobile"]}'
expect "anonymous calls are refused" 0 '^401$' -- curl -s -o /dev/null -w '%{http_code}' "$A/me"
CODE_A="$(api ania POST /join-codes | json 'd["code"]')"
CODE_B="$(api bob POST /join-codes | json 'd["code"]')"
expect "ania joins her Mac" 0 'Joined as ania' -- as ania join --code "$CODE_A" --api "$B"
expect "a join code works only once" 1 'invalid|expired|used' -- as bob join --code "$CODE_A" --api "$B"
expect "bob joins his Mac" 0 'Joined as bob' -- as bob join --code "$CODE_B" --api "$B"
# GitHub and Anthropic reachability depend on this machine's network, so only the hub checks count here.
expect "doctor's hub checks pass (HTTPS + WebSocket)" 0 'PASS +HTTPS to the hub API.*PASS +WebSocket to AppSync Events +acknowledged' -- bash -c "H1_HOME='$WORK/ania/h1' HOME='$WORK/ania/home' H1_TOKEN_FILE=1 '$H1' doctor --api '$B' | tr '\n' ' '; true"
expect "an agent cannot mint join codes" 0 '^403$' -- curl -s -o /dev/null -w '%{http_code}' -X POST "$A/join-codes" -H "authorization: Bearer $(cat "$WORK/ania/h1/token")"

for s in ania bob; do
  (H1_HOME="$WORK/$s/h1" HOME="$WORK/$s/home" H1_TOKEN_FILE=1 H1_MONITOR_MAX_PER_MIN=1000 exec "$H1" watch >"$WORK/$s/watch.log" 2>&1) &
  PIDS+=($!)
done
sleep 1

echo "== project, goal and plan through proposals"
REPO="$WORK/mono"
mkdir -p "$REPO/services/api" "$REPO/apps/mobile" && echo '{}' >"$REPO/package.json"
git -C "$REPO" init -q -b main && git -C "$REPO" add -A && git -C "$REPO" -c user.email=e@x -c user.name=e commit -qm init
expect "ania proposes a project" 0 'Proposal P1 is waiting' -- as ania project propose-new --name "Offline Capture" --repo mono=git@github.com:acme/mono.git --preset nx-monorepo --lane api --lane mobile --link spec=https://example.com/spec
seen bob 'P1 needs a human' "proposal reaches the other seat"
expect "an agent cannot approve a proposal" 0 '^403$' -- curl -s -o /dev/null -w '%{http_code}' -X POST "$A/proposals/P1/approve" -H "authorization: Bearer $(cat "$WORK/bob/h1/token")"
expect "bob approves P1 as a human" 0 '"status":"approved"' -- api bob POST /proposals/P1/approve
expect "project shows the integration branch" 0 'base main → integration hack/offline-capture' -- as ania project show offline-capture
expect "ania pins the project" 0 'pinProject' -- as ania me pin offline-capture
expect "bob pins the project" 0 'pinProject' -- as bob me pin offline-capture
expect "bob picks subagents mode" 0 'workMode' -- as bob me mode subagents
expect "ania links her checkout" 0 'Linked mono' -- as ania repo link mono "$REPO"
cat >"$WORK/goal.json" <<'EOF'
{"statement":"Field techs capture notes offline and sync later","definitionOfDone":["Note saved offline","Sync endpoint accepts batches","Demo runs end to end"],"demoScript":"Airplane mode, capture, reconnect"}
EOF
expect "ania proposes the goal" 0 'Proposal P2' -- as ania goal propose --file "$WORK/goal.json"
expect "bob approves the goal" 0 '"status":"approved"' -- api bob POST /proposals/P2/approve
seen ania 'goal v1' "goal change reaches the proposer"
cat >"$WORK/plan.json" <<'EOF'
{"tickets":[
 {"id":"contracts","repo":"mono","title":"Sync contracts","type":"contract","lanes":["contract"],"pathsOwned":["libs/shared/api-interfaces/src/note-sync/**"],"acceptance":[{"cmd":"npm run type:check","criterion":"types compile"}],"priority":1,"wave":1},
 {"id":"queue","repo":"mono","title":"Offline queue","type":"slice","lanes":["mobile"],"deps":["contracts"],"pathsOwned":["apps/mobile/src/features/offline-queue/**"],"acceptance":[{"criterion":"queue survives restart"}],"priority":2,"wave":2},
 {"id":"sync","repo":"mono","title":"Sync endpoint","type":"slice","lanes":["api"],"deps":["contracts"],"pathsOwned":["services/api/**"],"acceptance":[{"criterion":"accepts batches"}],"priority":2,"wave":2}
]}
EOF
expect "a build ticket on a contract path is refused" 1 'contract' -- as ania plan propose --file <(sed 's/"type":"contract"/"type":"slice"/' "$WORK/plan.json")
expect "ania proposes the plan" 0 'Proposal P3' -- as ania plan propose --file "$WORK/plan.json"
expect "bob approves the plan" 0 '"status":"approved"' -- api bob POST /proposals/P3/approve
expect "only T1 is ready" 0 '^T1 ' -- as ania ticket list --ready

echo "== tickets, guard and review"
expect "ania books T1" 0 'Booked T1' -- as ania ticket next
expect "T1 cannot be booked twice" 2 '' -- as bob ticket book T1
guard() { echo "{\"session_id\":\"s1\",\"cwd\":\"$REPO\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$REPO/$1\"}}" | as ania hook guard; }
expect "guard allows an owned path" 0 '' -- guard libs/shared/api-interfaces/src/note-sync/schema.ts
expect "guard blocks a hot path" 2 'protected shared path' -- guard package.json
expect "guard warns Claude about a path outside the ticket" 0 '"additionalContext":"HackathonOne guard: .*outside T1' -- guard apps/mobile/x.ts
expect "ania starts T1" 0 'in progress' -- as ania ticket start T1
expect "heartbeat extends the lease" 0 'Lease extended' -- as ania ticket heartbeat T1
expect "ania marks T1 ready for review" 0 'ready for review' -- as ania ticket review-ready T1 --pr https://github.com/acme/mono/pull/1
seen bob 'REVIEW T1' "review request"
expect "bob books the review" 0 'Reviewing T1' -- as bob review next
expect "bob merges T1" 0 'T1 → done' -- as bob review done T1 --outcome merged --note lgtm
seen bob 'T2 ready' "dependents become ready"
expect "bob books T2 in his lane" 0 'Booked T2' -- as bob ticket next --worker w1
expect "ania books T3 in her lane" 0 'Booked T3' -- as ania ticket next
expect "nothing else is ready" 2 'no ready ticket' -- as ania ticket next
expect "ania starts T3" 0 'in progress' -- as ania ticket start T3

echo "== blockers, votes, open floor"
expect "ania raises B4" 0 'E1 raised under B4' -- as ania raise blocker --rule B4 --ticket T3 --summary "Accept partial batches?" --option reject --option "accept valid"
expect "ania raises B1 with an agent vote" 0 'E2 raised under B1.*vote D1' -- as ania raise blocker --rule B1 --ticket T3 --summary "Extra field on SyncBatch" --option "add field" --option adapter
expect "ania votes on D1" 0 'Voted "adapter"' -- as ania decide vote D1 2 --why "stable contract"
expect "bob votes on D1" 0 'Voted "adapter"' -- as bob decide vote D1 2 --why agree
expect "an agent cannot resolve a B4" 0 '^403$' -- curl -s -o /dev/null -w '%{http_code}' -X POST "$A/escalations/E1/resolve" -H "authorization: Bearer $(cat "$WORK/bob/h1/token")" -H 'content-type: application/json' -d '{"resolution":"x"}'
expect "bob resolves E1 as a human" 0 'resolved_pending_contest' -- api bob POST /escalations/E1/resolve '{"resolution":"accept valid","reason":"demo path"}'
expect "ania contests it" 0 '"status":"contested"' -- api ania POST /escalations/E1/contest '{"reason":"confuses field techs"}'
expect "bob votes to uphold" 0 'uphold' -- api bob POST /decisions/D2/vote '{"option":"uphold","why":"demo path"}'
expect "ania's vote completes the human vote" 0 '"status":"made"' -- api ania POST /decisions/D2/vote '{"option":"uphold","why":"fine"}'
expect "E1 is closed" 0 '"status":"resolved"' -- api ania GET /escalations/E1
expect "T3 stays parked while E2 is still open" 0 'T3 +blocked' -- as ania ticket list
curl -s -X POST "$B/_dev/advance?ms=660000" >/dev/null
expect "E2 closes when the agent vote ends" 0 '"status":"resolved"' -- api ania GET /escalations/E2
expect "T3 is ready again once both blockers closed" 0 'T3 +ready' -- as ania ticket list
seen ania 'T3 ready again \(E2 closed\)' "unpark after the last blocker"

echo "== help and answers"
expect "ania books T3 again" 0 'Booked T3' -- as ania ticket book T3
expect "ania asks for B3 help" 0 'E3 raised under B3' -- as ania raise help --rule B3 --ticket T3 --summary "simulator will not boot"
seen bob 'HELP\? E3' "help request reaches other agents"
expect "bob answers E3" 0 'E3 → resolved' -- as bob answer E3 --text "xcrun simctl erase all"
seen ania 'E3 answered by bob' "answer reaches the asker"

echo "== knowledge and messages"
expect "ania shares a tip" 0 'Shared tip K1' -- as ania share tip "Use nx affected with the integration branch as base" --tags nx
printf '# Sync debugging\n\nRun the handler with fixtures.\n' >"$WORK/pb.md"
expect "ania shares a playbook" 0 'Shared playbook K2' -- as ania share playbook "$WORK/pb.md" --name "Sync debugging"
mkdir -p "$WORK/skill-dir" && printf -- '---\nname: sync-fixtures\ndescription: Generate sync batch fixtures\n---\n\nUse the fixtures.\n' >"$WORK/skill-dir/SKILL.md"
expect "ania publishes a skill named from SKILL.md" 0 'Published skill sync-fixtures v1' -- as ania share skill "$WORK/skill-dir"
seen bob 'skill sync-fixtures v1 synced' "skill sync"
if [ -f "$WORK/bob/home/.claude/skills/h1--sync-fixtures/SKILL.md" ]; then ok "skill landed in bob's ~/.claude/skills"; else bad "skill landed in bob's ~/.claude/skills" "$(ls -R "$WORK/bob/home/.claude" 2>&1)"; fi
printf 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' >"$WORK/secret.md"
expect "secrets are refused before upload" 1 'possible secrets' -- as ania share playbook "$WORK/secret.md" --name leak
expect "kb search finds the playbook" 0 'Sync debugging' -- as bob kb search sync
expect "ania DMs bob" 0 'Sent' -- as ania say "contract has photos" --to bob
seen bob 'DM ania → bob' "direct message"
expect "event catch-up hides other seats' DMs" 0 '^0$' -- bash -c "curl -s '$A/events?since=0&limit=500' -H 'authorization: Bearer $(cat "$WORK/bob/h1/token")' >/dev/null; curl -s '$A/events?since=0&limit=500' -H 'authorization: Bearer $(human ania)' | python3 -c 'import sys,json; print(sum(1 for e in json.load(sys.stdin)[\"events\"] if e.get(\"to\") not in (None,\"all\",\"humans\",\"ania\")))'"

echo "== hooks and autopilot"
expect "session-start gives Claude the seat and rules" 0 '"hookEventName":"SessionStart".*seat ania' -- bash -c "echo '{\"session_id\":\"sa\",\"cwd\":\"$REPO\",\"source\":\"startup\"}' | H1_HOME='$WORK/ania/h1' HOME='$WORK/ania/home' H1_TOKEN_FILE=1 '$H1' hook session-start"
expect "ania turns autopilot on" 0 'autopilot' -- as ania me autopilot on
expect "the Stop hook keeps an autopilot session working" 0 '"decision":"block"' -- bash -c "echo '{\"session_id\":\"sa\",\"cwd\":\"$REPO\"}' | H1_HOME='$WORK/ania/h1' HOME='$WORK/ania/home' H1_TOKEN_FILE=1 '$H1' hook autopilot-stop"
expect "needs-input tells the humans" 0 '' -- bash -c "echo '{\"session_id\":\"sa\",\"message\":\"Claude needs your permission\",\"notification_type\":\"permission_prompt\"}' | H1_HOME='$WORK/ania/h1' HOME='$WORK/ania/home' H1_TOKEN_FILE=1 '$H1' hook needs-input"
seen bob 'ania session sa is waiting for a human' "needs-input presence"
as ania me autopilot off >/dev/null

echo "== leases"
curl -s -X POST "$B/_dev/advance?ms=2400000" >/dev/null
seen bob 'T2 lease expired' "owner hears about an expired lease"
expect "expired tickets return to ready" 0 'T2 +ready' -- as bob ticket list

echo "== fixing HackathonOne itself: bug queue and releases"
expect "a bug needs the HackathonOne repo URL first" 1 'HackathonOne repo URL' -- as ania bug "monitor is quiet after pin"
expect "a human sets the HackathonOne repo URL" 0 'toolRepoUrl' -- api bob POST /actions '{"action":"settings.set","payload":{"toolRepoUrl":"git@github.com:acme/hakatonOne.git"}}'
expect "ania files an urgent plugin bug" 0 'Filed T[0-9]+ in the HackathonOne fix queue \(plugin, urgent\)' -- as ania bug "monitor is quiet after pin" --area plugin --urgent --detail "h1 watch printed nothing after h1 me pin"
expect "the fix queue project lists it" 0 'Fix: monitor is quiet after pin' -- as bob ticket list --project hackathonone
expect "the fix ticket owns only plugin code" 0 'plugin/lib/\*\*' -- bash -c "H1_HOME='$WORK/bob/h1' HOME='$WORK/bob/home' H1_TOKEN_FILE=1 '$H1' ticket list --project hackathonone --json | python3 -c 'import sys,json; t=json.load(sys.stdin); t=t.get(\"tickets\",t) if isinstance(t,dict) else t; print(t[0][\"pathsOwned\"])'"
expect "secrets are refused in bug reports" 1 'possible secrets' -- as ania bug "token AKIAABCDEFGHIJKLMNOP leaked"
expect "ania proposes release 0.3.1" 0 'Proposal P[0-9]+ is waiting' -- as ania release propose --version 0.3.1 --notes "quieter monitor"
PID_REL="$(grep -oE 'P[0-9]+' <<<"$LAST" | head -1)"
expect "an agent cannot publish a release directly" 0 '^403$' -- curl -s -o /dev/null -w '%{http_code}' -X POST "$A/actions" -H "authorization: Bearer $(cat "$WORK/ania/h1/token")" -H 'content-type: application/json' -d '{"action":"release.publish","payload":{"version":"9.9.9","notes":"x"}}'
expect "bob approves the release" 0 '"status":"approved"' -- api bob POST "/proposals/$PID_REL/approve"
seen bob 'UPDATE HackathonOne 0\.3\.1 released' "release announcement"
expect "h1 version reports the newer release" 0 '0\.3\.1 is out' -- as ania version
expect "a release must be newer than the last" 0 'not newer' -- api bob POST /actions '{"action":"release.publish","payload":{"version":"0.3.0","notes":"older"}}'
expect "bob publishes 0.4.0 with a minimum" 0 '"latest":"0.4.0"' -- api bob POST /actions '{"action":"release.publish","payload":{"version":"0.4.0","notes":"new API","minimum":"0.4.0"}}'
expect "h1 version exits 3 when an update is required" 3 'required' -- as ania version
expect "old agents can still read" 0 'T[0-9]' -- as ania ticket list
expect "old agents cannot change anything" 3 'too old for this hub' -- as ania say "hello"
expect "updated agents work again" 0 'Sent' -- env H1_CLIENT_VERSION=0.4.0 H1_HOME="$WORK/ania/h1" HOME="$WORK/ania/home" H1_TOKEN_FILE=1 "$H1" say "hello"
expect "session start warns the user" 0 '"systemMessage":"HackathonOne 0.4.0 is required' -- bash -c "echo '{\"session_id\":\"sb\",\"cwd\":\"$REPO\"}' | H1_HOME='$WORK/ania/h1' HOME='$WORK/ania/home' H1_TOKEN_FILE=1 '$H1' hook session-start"
expect "h1 update explains an in-place plugin" 0 'loaded in place' -- as ania update

echo
echo "== $PASS passed, $FAIL failed (hub log: $WORK/hub.log)"
[ "$FAIL" -eq 0 ]
