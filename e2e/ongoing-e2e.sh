#!/usr/bin/env bash
# End-to-end run of ongoing mode with the real c1 CLI against the local hub (--mode ongoing).
# One person (lukasz) working alone: his agent does almost everything, he steps in where the hub asks for a human.
# Usage: e2e/ongoing-e2e.sh            (starts its own hub on PORT, default 8793)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8793}"
B="http://localhost:$PORT"
A="$B/api/v1"
C1="$ROOT/plugin/bin/c1"
WORK="$(mktemp -d)"
PASS=0
FAIL=0
PIDS=()
export C1_CLIENT_VERSION=1.0.0

cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  pkill -f "local-hub.ts --port $PORT" 2>/dev/null
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/       /' | head -20; }
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
c1() { C1_HOME="$WORK/l/c1" HOME="$WORK/l/home" C1_TOKEN_FILE=1 "$C1" "$@"; }
api() { local method="$1" path="$2" body="${3:-}"; curl -s -X "$method" "$A$path" -H "authorization: Bearer $(cat "$WORK/l.jwt")" ${body:+-H 'content-type: application/json' -d "$body"}; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
waitfor() { for _ in $(seq 1 50); do grep -Eq -- "$1" "$WORK/l/watch.log" && return 0; sleep 0.1; done; return 1; }
seen() { if waitfor "$1"; then ok "monitor: $2"; else bad "monitor: $2" "$(tail -8 "$WORK/l/watch.log")"; fi; }
approve_pending() { for p in $(api GET '/proposals?status=pending' | json '" ".join(x["id"] for x in d["proposals"])'); do api POST "/proposals/$p/approve" >/dev/null; done; }

echo "== local hub, ongoing mode, on $B (work dir $WORK)"
(cd "$ROOT/backend" && exec npx tsx scripts/local-hub.ts --port "$PORT" --mode ongoing --sweep-ms 600000 >"$WORK/hub.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 100); do curl -sf "$A/health" >/dev/null && break; sleep 0.2; done
expect "hub health" 0 '"ok":true' -- curl -sf "$A/health"
grep -q 'ongoing mode' "$WORK/hub.log" && ok "hub started in ongoing mode" || bad "hub started in ongoing mode" "$(head -3 "$WORK/hub.log")"

mkdir -p "$WORK/l/c1" "$WORK/l/home"
curl -s -X POST "$B/_dev/token?email=lukasz@example.com" | json 'd["idToken"]' >"$WORK/l.jwt"
expect "seat created in the board" 0 '"id":"lukasz"' -- api POST /seats/me '{"id":"lukasz","name":"Lukasz","plan":"ultra"}'
CODE="$(api POST /join-codes | json 'd["code"]')"
expect "the Mac joins" 0 'Joined as lukasz' -- c1 join --code "$CODE" --api "$B"
EXP="$(python3 -c "import json; print(json.load(open('$WORK/l/c1/config.json'))['expiresAt'])")"
python3 -c "import time,sys; d=($EXP/1000-time.time())/86400; sys.exit(0 if 29 < d < 31 else 1)" && ok "agent token lives 30 days, not until an event ends" || bad "agent token lifetime" "$EXP"
(C1_HOME="$WORK/l/c1" HOME="$WORK/l/home" C1_TOKEN_FILE=1 C1_MONITOR_MAX_PER_MIN=1000 exec "$C1" watch >"$WORK/l/watch.log" 2>&1) &
PIDS+=($!)
sleep 1

echo "== repo catalog and epic (the agent does it; hub administration still needs a human)"
expect "agent proposes a catalog repo: a human must approve" 0 'waiting for a human' -- c1 catalog propose --name app --url git@github.com:acme/app.git --contract-path 'libs/contracts/**'
approve_pending
expect "catalog lists the repo" 0 'app +git@github.com:acme/app.git' -- c1 catalog list
expect "agent creates the epic itself" 0 '^Done' -- c1 epic propose-new --name "Customer notifications" --repo app --target 2027-02-01
expect "agent pins the epic" 0 'pinProject' -- c1 me pin customer-notifications
expect "epic list shows it planned" 0 'customer-notifications +planned' -- c1 epic list

echo "== ingest a PRD: re-plan ticket, assessment, agent approval with a contest window"
cat >"$WORK/prd1.md" <<'MD'
# Customer notifications

## Status email {#status-email}
Email the customer whenever a job's status changes.

## Templates
Use the brand template.
MD
expect "agent adds the PRD" 0 'I1 added as a draft with 3 sections' -- c1 input add "$WORK/prd1.md" --kind prd --title "Notifications PRD"
expect "agent approves it (ongoing: no human needed)" 0 '^Done.*CR1' -- c1 input approve I1
seen 'CHANGE CR1 opened.*re-plan ticket T1' "the ingest opens a change request with a re-plan ticket"
expect "any agent picks up the re-plan ticket" 0 'Booked T1: Re-plan' -- c1 ticket next
expect "change show lists what to assess" 0 'CR1 \[assessing\].*Next: assess it' -- bash -c "C1_HOME='$WORK/l/c1' HOME='$WORK/l/home' C1_TOKEN_FILE=1 '$C1' change show CR1 | tr '\n' ' '"
cat >"$WORK/a1.json" <<'JSON'
{ "impact": [],
  "newTickets": [
    { "key": "send", "repo": "app", "title": "Send status email", "pathsOwned": ["services/notify/send/**"], "acceptance": [{ "criterion": "email sent on status change" }], "refs": ["input:I1#status-email"] },
    { "key": "render", "repo": "app", "title": "Render brand template", "pathsOwned": ["services/notify/render/**"], "acceptance": [{ "criterion": "brand template used" }], "refs": ["input:I1#templates"] },
    { "key": "queue", "repo": "app", "title": "Email queue", "pathsOwned": ["services/notify/queue/**"], "acceptance": [{ "criterion": "queued" }], "refs": ["input:I1#status-email"], "deps": ["send"] }
  ],
  "scope": { "statement": "Customers hear about their jobs", "definitionOfDone": ["status emails go out", "templates use the brand"] },
  "summary": "First plan from the PRD: three tickets, goal set." }
JSON
expect "agent submits the assessment" 0 'CR1 is proposed' -- c1 change assess CR1 --file "$WORK/a1.json"
expect "the re-plan ticket closed itself" 0 'T1 +done' -- c1 ticket list
expect "agent approves: it waits for the contest window" 0 '^Done: CR1 is approved; it applies at' -- c1 change approve CR1
seen 'CHANGE CR1 approved by agent lukasz; it applies at' "agent approval announces the contest window"
curl -s -X POST "$B/_dev/advance?ms=360000" >/dev/null
expect "after the window the change is applied" 0 'applied' -- bash -c "C1_HOME='$WORK/l/c1' HOME='$WORK/l/home' C1_TOKEN_FILE=1 '$C1' change list --all | grep CR1"
expect "the plan's tickets exist and cite the PRD" 0 'Implements: input:I1#status-email' -- c1 ticket show T2
expect "the goal has stable definition-of-done ids" 0 'd1: status emails go out' -- c1 epic show

echo "== build: agent books, opens a PR, a second session of the same person merges"
expect "agent books the first ticket on a c1/ branch" 0 'branch c1/customer-notifications/T2-' -- c1 ticket next
expect "epic moved to in progress on the first booking" 0 'in_progress' -- c1 epic list
expect "PR ready" 0 'review' -- c1 ticket review-ready T2 --pr https://github.com/acme/app/pull/1
expect "same person, other session, reviews (allowed in ongoing mode)" 0 'Reviewing T2' -- c1 review next
expect "merge recorded with sha and files" 0 'T2 → done' -- c1 review done T2 --outcome merged --sha abc1234 --files services/notify/send/index.ts,services/notify/send/mail.ts

echo "== PRD v2 changes merged behaviour"
cat >"$WORK/prd2.md" <<'MD'
# Customer notifications

## Status email {#status-email}
Send one daily digest instead of an email per status change.

## Templates
Use the brand template.

## SMS
Text the customer when the technician is on the way.
MD
expect "agent drafts v2: the diff names the sections" 0 'changed #status-email · added #sms' -- c1 input version I1 "$WORK/prd2.md" --note digest
expect "approving v2 opens CR2" 0 'change requests: CR2' -- c1 input approve I1
expect "a ticket citing the changed section is suspect" 2 'suspect' -- c1 ticket book T4
expect "CR2 shows the before/after text and the merged ticket" 0 'daily digest.*T2 \[done\]' -- bash -c "C1_HOME='$WORK/l/c1' HOME='$WORK/l/home' C1_TOKEN_FILE=1 '$C1' change show CR2 | tr '\n' ' '"
RP="$(c1 change show CR2 --json | json 'd["change"]["replanTicket"]')"
expect "the re-plan ticket comes first" 0 "Booked $RP" -- c1 ticket next
cat >"$WORK/a2.json" <<'JSON'
{ "impact": [
    { "ticketId": "T2", "verdict": "rework", "group": "digest", "acceptance": [{ "criterion": "one digest per customer per day" }] },
    { "ticketId": "T4", "verdict": "supersede" }
  ],
  "newTickets": [
    { "key": "digest", "repo": "app", "title": "Daily digest job", "pathsOwned": ["services/notify/digest/**"], "acceptance": [{ "criterion": "digest sent" }], "refs": ["input:I1#status-email"], "supersedes": ["T4"] },
    { "key": "sms", "repo": "app", "title": "SMS on the way", "pathsOwned": ["services/notify/sms/**"], "acceptance": [{ "criterion": "sms sent" }], "refs": ["input:I1#sms"] }
  ],
  "summary": "Per-change emails become a daily digest: the merged sender is reworked, the queue is replaced, SMS is new." }
JSON
expect "agent assesses CR2" 0 'CR2 is proposed' -- c1 change assess CR2 --file "$WORK/a2.json"
expect "rework of merged code needs a human: it becomes a proposal" 0 'waiting for a human' -- c1 change approve CR2
seen 'needs a human: CR2|a human decides because it reworks merged code' "the human is told why"
approve_pending
expect "CR2 applied" 0 'CR2 +applied' -- c1 change list --all
expect "T4 is dropped and replaced" 0 'T4 +dropped' -- c1 ticket list
RW="$(c1 change show CR2 --json | json 'd["change"]["created"]["rework:digest"]')"
expect "a rework ticket targets the merged files" 0 'Reworks merged code of: T2.*merged as abc1234.*files: services/notify/send/index.ts' -- bash -c "C1_HOME='$WORK/l/c1' HOME='$WORK/l/home' C1_TOKEN_FILE=1 '$C1' ticket show $RW | tr '\n' ' '"

echo "== business decisions: one re-plan for several, a human can stop it"
expect "agent ingests a decision" 0 '^Done: R[0-9]+ is accepted; change requests: CR3' -- c1 decision propose --title "Channels" --choice "Customers can opt out of email"
expect "a second decision folds into the same re-plan" 0 '^Done: R[0-9]+ is accepted; change requests: CR3' -- c1 decision propose --title "Tone" --choice "Friendly, short"
expect "CR3 covers both decisions" 0 'Added: decision:R[0-9]+, decision:R[0-9]+' -- c1 change show CR3
api POST /actions '{"action":"change.reject","payload":{"changeId":"CR3","reason":"legal review first"}}' >/dev/null
expect "the human rejected CR3" 0 'CR3 +rejected' -- c1 change list --all
expect "the decision log lists the decisions and the applied changes" 0 'Channels.*Tone|Tone.*Channels' -- bash -c "C1_HOME='$WORK/l/c1' HOME='$WORK/l/home' C1_TOKEN_FILE=1 '$C1' decision list | tr '\n' ' '"
expect "the change log tells the story" 0 'change.rejected.*change.applied.*change.applied' -- bash -c "C1_HOME='$WORK/l/c1' HOME='$WORK/l/home' C1_TOKEN_FILE=1 '$C1' epic log | tr '\n' ' '"

echo "== steering: a moved target date needs a human"
expect "agent moving the date becomes a proposal" 0 'waiting for a human' -- c1 epic update --target 2027-03-01 --reason "sales event moved"
approve_pending
expect "the date moved and was recorded as a decision" 0 'Move the target date from 2027-02-01 to 2027-03-01' -- c1 decision list

echo "== tokens and export"
expect "token rotates" 0 'Token rotated' -- c1 token rotate
expect "the new token works" 0 'lukasz' -- c1 status
expect "export writes the hub to files" 0 'Exported 1 epics, 1 inputs' -- c1 export --out "$WORK/export"
[ -f "$WORK/export/customer-notifications.md" ] && [ -f "$WORK/export/inputs/I1-v2.md" ] && ok "export has the epic and both PRD versions" || bad "export files" "$(ls -R "$WORK/export")"

echo "== board data"
expect "the board reports ongoing mode with a roadmap" 0 '"mode": "ongoing"' -- bash -c "curl -s '$A/board' -H 'authorization: Bearer $(cat "$WORK/l.jwt")' | python3 -m json.tool | head -3"

echo
echo "ongoing e2e: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
