import { ApiError, CONFLICT_CODES, UPDATE_EXIT } from './api.mjs';
import * as C from './commands.mjs';
import { runHook } from './hooks.mjs';
import { parseArgs } from './util.mjs';
import { watch } from './watch.mjs';
import * as T from './tooling.mjs';
import * as O from './ongoing.mjs';
import { clientVersion } from './version.mjs';

export const HELP = `c1 — CollabOne CLI (talks to the CollabOne hub with this Mac's agent token)

Setup
  c1 join --code XXXX-XXXX [--api <board URL>] [--project <id>]   connect this Mac (code from the board: Tokens & Macs)
  c1 doctor [--api <board URL>]                                   connectivity checks (DNS, HTTPS, WebSocket, GitHub, Anthropic)
  c1 status                                                       hub, seat and project summary
  c1 me [mode <solo|subagents|multi_session|factory>] [pin <project>] [lanes <a,b>] [autopilot on|off] [limit <n|none>]

Projects, goals, plans, rules (human actions: these create proposals a human approves in the board)
  c1 project list | show [<id>]
  c1 project propose-new --name <n> --repo name=url[@branch] [--preset nx-monorepo|node-app|expo-app] [--id <id>] [--lane l]
                         [--description "…"] [--link label=https://…] [--demo-url https://…] [--stage s] [--tag t] [--file project.json]
  c1 project propose-update <id> --file project.json | [--description …] [--link …] [--tag …] [--repo …]
  c1 project freeze|archive|activate|demo <id> | phase <id> <plan|build|freeze|demo>
  c1 goal show [--project <id>] | c1 goal propose --file goal.json [--project <id>]
  c1 plan propose --file tasks.json [--project <id>]
  c1 rules show [--project <id>] | c1 rules propose --code B3 --set maxAttempts=2 [--file patch.json] [--project <id>]

Repos (local checkouts on this Mac; stored in ~/.c1/repos.json, never sent to the hub)
  c1 repo list | show <name> | link <name> [path] | unlink <name> | path <name>   (path: exit 2 if not linked)

Tickets
  c1 ticket list [--status s] [--ready] | show <id> | add --file t.json
  c1 ticket next [--n 3] [--lanes a,b] [--worker id] [--session id]
  c1 ticket book <id> | heartbeat <id> | start <id> | review-ready <id> --pr <url> | block <id> --note "…"
  c1 ticket release <id> --reason "…" [--failed]
  c1 review next | c1 review done <id> --outcome merged|changes_requested [--note "…"] [--sha <merge sha> --files "a,b"]

Blockers and votes
  c1 raise blocker|issue|urgent|help --rule B3 --summary "…" [--detail "…" | --detail-file f] [--ticket T1] [--option "…"]
  c1 answer <eid> --text "…"
  c1 decide list | show <did> | vote <did> <option|number> --why "…"

Knowledge
  c1 share tip "…" [--name n] [--tags a,b] [--project id]
  c1 share playbook <file.md> --name "…" | c1 share skill <dir> [--name n] | c1 retire <kid>
  c1 kb search <words> | c1 sync

Ongoing mode (day-to-day work: epics, inputs, decisions, change requests)
  c1 catalog list | propose --name n --url <git url> [--branch main] [--contract-path p] [--file repo.json] | remove <name>
  c1 epic list | show [<id>] | log [<id>] | follow <id> | unfollow <id>
  c1 epic propose-new --name "…" --repo <catalog repo> [--target YYYY-MM-DD] [--priority n] [--owner seat]
  c1 epic update [<id>] [--state planned|in_progress|release|done|paused|archived] [--target date --reason "…"]
                 [--milestone "name@date"] [--priority n] [--owner seat] [--mode owners|open] [--file patch.json]
  c1 input list | show <I1> [--version n] [--sections] | add <file.md> --kind prd|feedback|research|note --title "…"
  c1 input version <I1> <file.md> [--note "…"] | approve <I1> [--version n]
  c1 decision list | show <R1> | propose --title "…" --choice "…" [--reason "…"] [--supersedes R1] [--ref r]
                     [--contract-repo app --contract-path libs/contracts/**] [--hub]
  c1 change list [--status s|--all] | show <CR1> | open --title "…" --reason "…" [--ref r] [--ticket T1,T2] [--milestone m1]
  c1 change assess <CR1> --file assessment.json | rebase <CR1> | approve <CR1> | reject <CR1> --reason "…"
  c1 token rotate | c1 export [--out dir] | c1 retention apply   (after switching a hub from event to ongoing)
  Refs on tickets: dod:d1, input:I1#anchor, input:I1, decision:R1 (field "refs" in ticket JSON).

CollabOne itself
  c1 bug "what went wrong" [--detail "…"] [--area plugin|board|backend|docs] [--urgent]   report a problem with CollabOne
  c1 version                        installed version against the hub's latest release (exit 3 if an update is required)
  c1 update [--marketplace name]    update the plugin through Claude Code (then /reload-plugins)
  c1 release show | propose --version x.y.z --notes "…" [--minimum x.y.z]   publish a plugin release (a human approves)

Other
  c1 say "…" [--to <seat>] | c1 board [--project id] | c1 events [--since n] [--limit n]
  c1 watch                          the plugin monitor (subscribes to hub events)
  c1 hook <session-start|guard|heartbeat|needs-input|autopilot-stop|session-end>   used by plugin hooks

Global: --json for machine-readable output, --project <id> to target another project.
Exit codes: 0 ok · 1 error · 2 conflict / nothing ready · 3 update required.`;

const COMMANDS = {
  join: (p, f) => C.join(f),
  me: C.me,
  status: () => C.status(),
  doctor: (p, f) => C.runDoctor(f),
  project: C.project,
  repo: C.repo,
  goal: C.goal,
  plan: C.plan,
  rules: C.rules,
  ticket: C.ticket,
  review: C.review,
  raise: C.raise,
  answer: C.answer,
  decide: C.decide,
  share: C.share,
  retire: (p) => C.retire(p),
  kb: (p) => C.kb(p),
  sync: () => C.sync(),
  say: C.say,
  board: C.board,
  events: C.events,
  bug: T.bug,
  update: T.update,
  release: T.release,
  catalog: O.catalog,
  epic: O.epic,
  input: O.input,
  decision: O.decision,
  change: O.change,
  token: (p) => O.token(p),
  export: O.exportHub,
  retention: (p) => O.retention(p),
};

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  if (!cmd && flags.version === true) {
    process.stdout.write(`c1 ${clientVersion()}\n`);
    return 0;
  }
  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (cmd === 'version') {
    const r = await T.version();
    process.stdout.write((flags.json ? JSON.stringify(r.data, null, 2) : r.text) + '\n');
    return r.exit;
  }
  if (cmd === 'hook') return runHook(rest[0]);
  if (cmd === 'watch') {
    await watch();
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    process.stderr.write(`c1: unknown command "${cmd}". Run c1 --help.\n`);
    return 1;
  }
  try {
    const r = await fn(rest, flags);
    if (flags.json) process.stdout.write(JSON.stringify(r?.data ?? null, null, 2) + '\n');
    else if (r?.text) process.stdout.write(r.text + '\n');
    return r?.exit ?? 0;
  } catch (e) {
    if (e instanceof ApiError) {
      if (flags.json) process.stdout.write(JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, details: e.details } }, null, 2) + '\n');
      else process.stderr.write(`c1: ${e.message}${e.code && !['invalid', 'error'].includes(e.code) ? ` (${e.code})` : ''}\n`);
      if (e.code === 'update_required') return UPDATE_EXIT;
      return CONFLICT_CODES.has(e.code) || e.status === 409 ? 2 : 1;
    }
    process.stderr.write(`c1: ${e?.message ?? e}\n`);
    return 1;
  }
}
