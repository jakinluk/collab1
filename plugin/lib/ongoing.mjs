import fs from 'node:fs';
import path from 'node:path';
import { ApiError, clientFromConfig, enc } from './api.mjs';
import { loadConfig, readToken, saveConfig, storeToken } from './config.mjs';
import { scanSecrets } from './secrets.mjs';
import { list, table, truncate } from './util.mjs';

const DAY = 86_400_000;
/** Rotate the agent token when less than this much of its life is left. */
export const ROTATE_BEFORE_MS = 7 * DAY;

const fail = (msg, code = 'invalid') => {
  throw new ApiError(0, code, msg);
};
const need = (v, msg) => (v === undefined || v === true || v === '' ? fail(msg) : v);
const many = (v) => (v === undefined || v === true ? [] : Array.isArray(v) ? v.flatMap(list) : list(v));
const readText = (file) => {
  try {
    return fs.readFileSync(need(file, 'a file path is required'), 'utf8');
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail(`cannot read ${file}: ${e.message}`);
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(readText(file));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail(`${file} is not valid JSON: ${e.message}`);
  }
};
const ctx = (flags) => {
  const { cfg, api } = clientFromConfig();
  return { cfg, api, projectId: typeof flags.project === 'string' ? flags.project : cfg.projectId };
};
const needProject = (pid) => pid || fail('no epic: pass --project <id> or pin one with c1 me pin <id>');
const propose = (api, action, payload, summary) => api.post('/proposals', { action, payload, summary: truncate(summary, 300) });
const describeResult = (res) => {
  if (!res || typeof res !== 'object') return '';
  const parts = [];
  const main = res.record ?? res.input ?? res;
  if (main.id) parts.push(`${main.id}${main.status ? ` is ${main.status}` : ''}${res.version && typeof res.version === 'number' ? ` (v${res.version})` : ''}`);
  if (res.status === 'approved' && res.contestUntil) parts.push(`it applies at ${new Date(res.contestUntil).toISOString().slice(11, 16)}Z unless a human rejects it`);
  if (Array.isArray(res.changes)) parts.push(res.changes.length ? `change requests: ${res.changes.join(', ')}` : 'no change request needed');
  if (res.created && typeof res.created === 'object') parts.push(`created ${Object.values(res.created).join(', ')}`);
  return parts.join('; ');
};
const printProposal = (r) =>
  r.executed
    ? `Done: ${describeResult(r.result) || JSON.stringify(r.result ?? {}).slice(0, 300)}`
    : `Proposal ${r.proposal?.id} is waiting for a human${r.needsHuman?.length ? ` because it ${r.needsHuman.join('; ')}` : ''}.\nApprove it in the board: ${r.approveUrl}`;
const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '—');

// ---------- tokens ----------

/** Swaps this Mac's agent token for a new one and stores it. */
export async function rotateToken(api, cfg) {
  const current = readToken(cfg.seatId) ?? fail('no agent token on this Mac: run c1 join');
  const r = await api.post('/tokens/rotate', { token: current });
  storeToken(cfg.seatId, r.token);
  const next = { ...loadConfig(), tokenId: r.tokenId, expiresAt: r.expiresAt };
  saveConfig(next);
  return r;
}

/** Rotates the token when it is close to expiry. Best effort: returns null when nothing was done. */
export async function rotateIfDue(api, cfg, now = Date.now()) {
  if (process.env.C1_TOKEN || !cfg?.expiresAt || cfg.expiresAt - now > ROTATE_BEFORE_MS || cfg.expiresAt < now) return null;
  try {
    return await rotateToken(api, cfg);
  } catch {
    return null;
  }
}

export async function token(pos) {
  const { cfg, api } = clientFromConfig();
  if (pos[0] !== 'rotate') return fail('usage: c1 token rotate');
  const r = await rotateToken(api, cfg);
  return { data: { tokenId: r.tokenId, expiresAt: r.expiresAt, replaced: r.replaced }, text: `Token rotated: ${r.replaced} → ${r.tokenId}, valid until ${day(r.expiresAt)}. The old token stops working in 10 minutes.` };
}

// ---------- repo catalog ----------

export async function catalog(pos, flags) {
  const { api } = ctx(flags);
  const [sub, name] = pos;
  switch (sub ?? 'list') {
    case 'list': {
      const { repos } = await api.get('/catalog/repos');
      return { data: repos, text: repos.length ? table(repos.map((r) => [r.name, r.url, r.baseBranch, (r.contractPaths ?? []).join(',')]), ['name', 'url', 'base', 'contract paths']) : 'The catalog is empty. Add a repo with c1 catalog propose --name <n> --url <git url>.' };
    }
    case 'propose': {
      const body = typeof flags.file === 'string' ? readJson(flags.file) : {};
      const repo = {
        ...body,
        ...(typeof flags.name === 'string' ? { name: flags.name } : {}),
        ...(typeof flags.url === 'string' ? { url: flags.url } : {}),
        ...(typeof flags.branch === 'string' ? { baseBranch: flags.branch } : {}),
        ...(flags['contract-path'] ? { contractPaths: many(flags['contract-path']) } : {}),
        ...(flags['hot-path'] ? { hotPaths: many(flags['hot-path']) } : {}),
      };
      need(repo.name, '--name is required');
      need(repo.url, '--url is required');
      const r = await propose(api, 'repo.set', repo, `Catalog repo ${repo.name}: ${repo.url}`);
      return { data: r, text: printProposal(r) };
    }
    case 'remove': {
      const r = await propose(api, 'repo.remove', { name: need(name, 'c1 catalog remove <name>') }, `Remove ${name} from the repo catalog`);
      return { data: r, text: printProposal(r) };
    }
    default:
      return fail(`unknown: c1 catalog ${sub}`);
  }
}

// ---------- epics ----------

const epicLine = (r) => [
  r.projectId,
  r.epic?.state ?? '—',
  truncate(r.name, 40),
  `${r.done}/${r.total}`,
  r.suspect ? `${r.suspect} suspect` : '',
  r.epic?.targetDate ?? '',
  `p${r.epic?.priority ?? '-'}`,
  `v${r.scopeVersion}`,
];

export async function epic(pos, flags) {
  const { cfg, api, projectId } = ctx(flags);
  const [sub, id] = pos;
  switch (sub ?? 'list') {
    case 'list': {
      const b = await api.get('/board');
      const rows = b.roadmap ?? [];
      const followed = new Set((await api.get('/me')).seat?.projects ?? []);
      return {
        data: rows,
        text: rows.length ? table(rows.map((r) => [...epicLine(r), followed.has(r.projectId) ? 'following' : '']), ['epic', 'state', 'name', 'done', 'suspect', 'target', 'prio', 'scope', '']) : 'No epics yet: c1 epic propose-new --name "…" --repo <catalog repo>.',
      };
    }
    case 'show': {
      const pid = id ?? needProject(projectId);
      const b = await api.get(`/board?projectId=${enc(pid)}`);
      const r = (b.roadmap ?? []).find((x) => x.projectId === pid) ?? fail(`epic ${pid} not found`);
      const changes = (b.changes ?? []).filter((c) => c.projectId === pid && ['assessing', 'proposed', 'applying'].includes(c.status));
      const e = r.epic ?? {};
      return {
        data: { ...r, goal: b.goal, changes },
        text: [
          `${pid} · ${r.name} · ${e.state} · scope v${r.scopeVersion} · priority ${e.priority}`,
          `Dates: ${e.startDate ?? '—'} → ${e.targetDate ?? '—'} · owners ${(e.owners ?? []).join(', ')} · decisions by ${e.decisionMode}`,
          `Progress: ${r.done}/${r.total} done${r.suspect ? ` · ${r.suspect} suspect` : ''}${r.deferred ? ` · ${r.deferred} deferred` : ''}`,
          ...(r.milestones ?? []).map((m) => `  ${m.id} ${m.name}${m.targetDate ? ` (${m.targetDate})` : ''}: ${m.done}/${m.total}${m.done === m.total && m.total ? ' ✓' : ''}`),
          b.goal ? `Goal: ${b.goal.statement}\nDefinition of done:\n${(b.goal.dod ?? b.goal.definitionOfDone.map((t, i) => ({ id: `d${i + 1}`, text: t }))).map((d) => `  ${d.id}: ${d.text}`).join('\n')}` : 'No goal yet (c1 goal propose).',
          changes.length ? `Open change requests: ${changes.map((c) => `${c.id} [${c.status}] ${truncate(c.title, 50)}`).join('; ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }
    case 'propose-new': {
      const name = need(flags.name, '--name is required');
      const repoRefs = many(flags.repo);
      if (!repoRefs.length) fail('--repo <catalog repo> is required (see c1 catalog list)');
      const payload = {
        name,
        repoRefs,
        ...(typeof flags.id === 'string' ? { id: flags.id } : {}),
        ...(typeof flags.description === 'string' ? { description: flags.description } : {}),
        epic: {
          ...(typeof flags.state === 'string' ? { state: flags.state } : {}),
          ...(typeof flags.start === 'string' ? { startDate: flags.start } : {}),
          ...(typeof flags.target === 'string' ? { targetDate: flags.target } : {}),
          ...(flags.priority ? { priority: Number(flags.priority) } : {}),
          owners: flags.owner ? many(flags.owner) : [cfg.seatId],
        },
      };
      const r = await propose(api, 'project.create', payload, `New epic ${name} on ${repoRefs.join(', ')}`);
      return { data: r, text: printProposal(r) };
    }
    case 'update': {
      const pid = id ?? needProject(projectId);
      const payload = { projectId: pid };
      if (typeof flags.state === 'string') payload.state = flags.state;
      if (typeof flags.start === 'string') payload.startDate = flags.start === 'none' ? null : flags.start;
      if (typeof flags.target === 'string') payload.targetDate = flags.target === 'none' ? null : flags.target;
      if (flags.priority) payload.priority = Number(flags.priority);
      if (flags.owner) payload.owners = many(flags.owner);
      if (typeof flags.mode === 'string') payload.decisionMode = flags.mode;
      if (typeof flags.reason === 'string') payload.reason = flags.reason;
      if (typeof flags.file === 'string') Object.assign(payload, readJson(flags.file), { projectId: pid });
      if (flags.milestone) {
        const b = await api.get(`/board?projectId=${enc(pid)}`);
        const existing = (b.roadmap ?? []).find((x) => x.projectId === pid)?.epic?.milestones ?? [];
        const added = many(flags.milestone).map((spec) => {
          const [mname, date] = spec.split('@');
          return { name: mname.trim(), ...(date ? { targetDate: date.trim() } : {}) };
        });
        payload.milestones = [...existing.map(({ id: mid, name: n, targetDate, done }) => ({ id: mid, name: n, targetDate, done })), ...added];
      }
      if (Object.keys(payload).length === 1) fail('nothing to change: pass --state, --start, --target, --priority, --owner, --mode, --milestone "name@date" or --file');
      const r = await propose(api, 'epic.update', payload, `Update epic ${pid}: ${Object.keys(payload).filter((k) => k !== 'projectId').join(', ')}`);
      return { data: r, text: printProposal(r) };
    }
    case 'log': {
      const pid = id ?? needProject(projectId);
      const { entries } = await api.get(`/projects/${enc(pid)}/log`);
      const limit = flags.limit ? Number(flags.limit) : 40;
      return { data: entries, text: entries.length ? entries.slice(0, limit).map((e) => `${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')}  ${e.kind.padEnd(15)} ${e.text}${e.by ? `  — ${e.by}` : ''}`).join('\n') : `${pid} has no changes or decisions yet.` };
    }
    case 'follow':
    case 'unfollow': {
      const pid = need(id, `c1 epic ${sub} <id>`);
      const seat = await api.patch('/me', { [sub]: [pid] });
      return { data: seat, text: `${sub === 'follow' ? 'Following' : 'No longer following'} ${pid}. You pick work from: ${seat.projects.join(', ') || 'nothing'}.` };
    }
    default:
      return fail(`unknown: c1 epic ${sub}`);
  }
}

// ---------- inputs ----------

export async function input(pos, flags) {
  const { api, projectId } = ctx(flags);
  const [sub, a, b] = pos;
  switch (sub ?? 'list') {
    case 'list': {
      const { inputs } = await api.get(`/inputs${typeof flags.project === 'string' ? `?projectId=${enc(flags.project)}` : ''}`);
      return { data: inputs, text: inputs.length ? table(inputs.map((i) => [i.id, i.kind, truncate(i.title, 50), i.status, `v${i.approvedVersion ?? '-'}/${i.latestVersion}`, i.projectIds.join(','), i.owner]), ['id', 'kind', 'title', 'status', 'approved/latest', 'epics', 'owner']) : 'No inputs yet: c1 input add <file.md> --kind prd --title "…".' };
    }
    case 'show': {
      const q = flags.version ? `?version=${Number(flags.version)}` : '';
      const r = await api.get(`/inputs/${enc(need(a, 'c1 input show <id>'))}${q}`);
      const head = `${r.input.id} ${r.input.kind} "${r.input.title}" v${r.version.version} (${r.version.status}) · cite sections as input:${r.input.id}#<anchor>`;
      const anchors = r.version.sections.map((s) => `  #${s.anchor}  ${'  '.repeat(Math.max(0, s.level - 1))}${s.title}`).join('\n');
      return { data: r, text: flags.sections ? `${head}\n${anchors}` : `${head}\nSections:\n${anchors}\n\n${r.version.body}` };
    }
    case 'add': {
      const file = need(a, 'c1 input add <file.md> --kind prd|feedback|research|note --title "…" [--project <epic>]');
      const body = readText(file);
      const findings = scanSecrets(body);
      if (findings.length) fail(`${file} looks like it contains secrets (${findings.map((f) => f.type).join(', ')}); remove them first`);
      const projectIds = flags.project === undefined ? (projectId ? [projectId] : []) : many(flags.project);
      const r = await api.post('/inputs', {
        kind: typeof flags.kind === 'string' ? flags.kind : 'prd',
        title: typeof flags.title === 'string' ? flags.title : path.basename(file).replace(/\.[^.]+$/, ''),
        body,
        projectIds,
        ...(typeof flags.note === 'string' ? { note: flags.note } : {}),
      });
      return { data: r, text: `${r.input.id} added as a draft with ${r.version.sections.length} sections: ${r.version.sections.map((s) => `#${s.anchor}`).join(' ')}\nA human approves it with c1 input approve ${r.input.id} (or in the board).` };
    }
    case 'version': {
      const id = need(a, 'c1 input version <id> <file.md> [--note "…"]');
      const body = readText(need(b, 'the new version file is required'));
      const r = await api.post(`/inputs/${enc(id)}/versions`, { body, ...(typeof flags.note === 'string' ? { note: flags.note } : {}) });
      const d = r.diff;
      return { data: r, text: `${id} v${r.version.version} drafted: changed ${d.changed.map((x) => '#' + x).join(' ') || '—'} · added ${d.added.map((x) => '#' + x).join(' ') || '—'} · removed ${d.removed.map((x) => '#' + x).join(' ') || '—'}\nApproving it opens change requests for tickets that cite changed or removed sections.` };
    }
    case 'approve': {
      const id = need(a, 'c1 input approve <id> [--version n]');
      const r = await propose(api, 'input.approve', { inputId: id, ...(flags.version ? { version: Number(flags.version) } : {}) }, `Approve input ${id}${flags.version ? ` v${flags.version}` : ''}`);
      return { data: r, text: printProposal(r) };
    }
    default:
      return fail(`unknown: c1 input ${sub}`);
  }
}

// ---------- decision records ----------

export async function decision(pos, flags) {
  const { api, projectId } = ctx(flags);
  const [sub, id] = pos;
  switch (sub ?? 'list') {
    case 'list': {
      const { records } = await api.get(`/decision-records${typeof flags.project === 'string' ? `?projectId=${enc(flags.project)}` : ''}`);
      return { data: records, text: records.length ? table(records.map((r) => [r.id, r.status, r.projectId ?? 'hub', truncate(r.title, 40), truncate(r.choice, 50), r.source, day(r.at)]), ['id', 'status', 'epic', 'question', 'choice', 'source', 'date']) : 'No decisions recorded yet.' };
    }
    case 'show': {
      const r = await api.get(`/decision-records/${enc(need(id, 'c1 decision show <R1>'))}`);
      return {
        data: r,
        text: [`${r.id} (${r.status}${r.supersededBy ? ` by ${r.supersededBy}` : ''}) ${r.title}`, `Choice: ${r.choice}`, r.reason ? `Why: ${r.reason}` : '', r.supersedes ? `Supersedes ${r.supersedes}` : '', r.contractPaths?.length ? `Contract: ${r.repo} ${r.contractPaths.join(', ')}` : '', `By ${r.by} on ${day(r.at)} (${r.source}${r.sourceId ? ` ${r.sourceId}` : ''})`]
          .filter(Boolean)
          .join('\n'),
      };
    }
    case 'propose': {
      const payload = {
        ...(flags.hub ? {} : { projectId: needProject(projectId) }),
        title: need(flags.title, '--title "the question" is required'),
        choice: need(flags.choice, '--choice "what was decided" is required'),
        ...(typeof flags.reason === 'string' ? { reason: flags.reason } : {}),
        ...(flags.ref ? { refs: many(flags.ref) } : {}),
        ...(typeof flags.supersedes === 'string' ? { supersedes: flags.supersedes } : {}),
        ...(typeof flags['contract-repo'] === 'string' ? { repo: flags['contract-repo'], contractPaths: many(flags['contract-path']) } : {}),
      };
      const r = await propose(api, 'decision.record', payload, `Decision: ${payload.title} → ${payload.choice}`);
      return { data: r, text: printProposal(r) };
    }
    default:
      return fail(`unknown: c1 decision ${sub}`);
  }
}

// ---------- change requests ----------

const verdictText = (e) => `${e.ticketId} [${e.statusAtOpen}] ${truncate(e.title, 50)} — ${e.verdict ?? 'needs a verdict'}${e.group ? ` (group ${e.group})` : ''}${e.applied ? ' ✓' : ''}\n      why: ${e.why.join('; ')}`;

export async function change(pos, flags) {
  const { api, projectId } = ctx(flags);
  const [sub, id] = pos;
  switch (sub ?? 'list') {
    case 'list': {
      const q = new URLSearchParams();
      if (typeof flags.project === 'string') q.set('projectId', flags.project);
      q.set('status', typeof flags.status === 'string' ? flags.status : 'open');
      if (flags.all) q.delete('status');
      const { changes } = await api.get(`/changes?${q}`);
      return { data: changes, text: changes.length ? table(changes.map((c) => [c.id, c.status, c.projectId, truncate(c.title, 50), `${c.impact.length} tickets`, c.trigger.kind, day(c.createdAt)]), ['id', 'status', 'epic', 'title', 'impact', 'trigger', 'opened']) : 'No change requests (use --all to include closed ones).' };
    }
    case 'show': {
      const r = await api.get(`/changes/${enc(need(id, 'c1 change show <CR1>'))}`);
      const c = r.change;
      return {
        data: r,
        text: [
          `${c.id} [${c.status}] ${c.title} · epic ${c.projectId} · assessed on scope v${c.baseScopeVersion} (now v${r.scopeVersion})${c.baseScopeVersion !== r.scopeVersion && ['assessing', 'proposed'].includes(c.status) ? ' → STALE: c1 change rebase ' + c.id : ''}`,
          `Why: ${c.reason}`,
          c.changedRefs.length ? `Changed: ${c.changedRefs.join(', ')}` : '',
          c.addedRefs.length ? `Added: ${c.addedRefs.join(', ')}` : '',
          ...(r.diffs ?? []).map((d) => `\n--- ${d.ref} before\n${d.before}\n+++ ${d.ref} after\n${d.after}`),
          `\nImpacted tickets (${c.impact.length}):`,
          ...c.impact.map((e) => `  ${verdictText(e)}`),
          c.newTickets.length ? `\nNew tickets: ${c.newTickets.map((t) => `${t.key}${c.created?.[t.key] ? `=${c.created[t.key]}` : ''} "${truncate(t.title, 40)}"${t.supersedes?.length ? ` replaces ${t.supersedes.join(',')}` : ''}`).join('; ')}` : '',
          c.scope ? `Scope patch: ${JSON.stringify(c.scope)}` : '',
          c.status === 'assessing' ? `\nNext: assess it (/c1:assess ${c.id}, or c1 change assess ${c.id} --file assessment.json).` : c.status === 'proposed' ? `\nNext: a human approves it (c1 change approve ${c.id}, or in the board).` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }
    case 'open': {
      const payload = {
        projectId: needProject(projectId),
        title: need(flags.title, '--title is required'),
        reason: need(flags.reason, '--reason is required'),
        ...(flags.ref ? { changedRefs: many(flags.ref) } : {}),
        ...(flags.ticket ? { ticketIds: many(flags.ticket) } : {}),
        ...(flags.milestone ? { milestone: many(flags.milestone)[0] } : {}),
        ...(typeof flags['contract-repo'] === 'string' ? { repo: flags['contract-repo'], contractPaths: many(flags['contract-path']) } : {}),
        ...(typeof flags.scope === 'string' ? { scope: readJson(flags.scope) } : {}),
      };
      const c = await api.post('/changes', payload);
      return { data: c, text: `${c.id} opened: ${c.impact.length} ticket${c.impact.length === 1 ? '' : 's'} affected${c.impact.length ? ' (open ones are now suspect)' : ''}.\n${c.impact.map((e) => `  ${e.ticketId} ${truncate(e.title, 50)} — ${e.why.join('; ')}`).join('\n')}\nNext: /c1:assess ${c.id}` };
    }
    case 'assess': {
      const c = await api.post(`/changes/${enc(need(id, 'c1 change assess <CR1> --file assessment.json'))}/assessment`, readJson(flags.file));
      return { data: c, text: `${c.id} is ${c.status}.\n${c.impact.map((e) => `  ${verdictText(e)}`).join('\n')}${c.status === 'proposed' ? `\nA human approves it: c1 change approve ${c.id} (or in the board).` : ''}` };
    }
    case 'rebase': {
      const c = await api.post(`/changes/${enc(need(id, 'c1 change rebase <CR1>'))}/rebase`, {});
      return { data: c, text: `${c.id} rebased on scope v${c.baseScopeVersion}; status ${c.status}.${c.status === 'assessing' ? ' Some tickets need a fresh verdict: c1 change show ' + c.id : ''}` };
    }
    case 'approve': {
      const r = await propose(api, 'change.approve', { changeId: need(id, 'c1 change approve <CR1>') }, `Apply change request ${id}`);
      return { data: r, text: printProposal(r) };
    }
    case 'reject': {
      const r = await propose(api, 'change.reject', { changeId: need(id, 'c1 change reject <CR1> --reason "…"'), reason: typeof flags.reason === 'string' ? flags.reason : '' }, `Reject change request ${id}`);
      return { data: r, text: printProposal(r) };
    }
    default:
      return fail(`unknown: c1 change ${sub}`);
  }
}

// ---------- retention ----------

export async function retention(pos) {
  const { api } = clientFromConfig();
  if (pos[0] !== 'apply') return fail('usage: c1 retention apply');
  const r = await propose(api, 'retention.apply', {}, 'Apply the ongoing-mode retention to every stored record');
  return { data: r, text: printProposal(r) };
}

// ---------- export ----------

const md = (e) => {
  const p = e.project;
  const goal = e.goals.at(-1);
  return [
    `# ${p.name} (${p.id})`,
    '',
    `State: ${p.epic?.state ?? p.status} · scope v${p.goalVersion} · ${p.epic?.startDate ?? '—'} → ${p.epic?.targetDate ?? '—'}`,
    '',
    goal ? `## Goal\n\n${goal.statement}\n\n${(goal.dod ?? []).map((d) => `- ${d.id}: ${d.text}`).join('\n')}` : '',
    '',
    '## Tickets',
    '',
    '| id | status | title | refs |',
    '| --- | --- | --- | --- |',
    ...e.tickets.map((t) => `| ${t.id} | ${t.status}${t.deferred ? ' (deferred)' : ''} | ${t.title.replace(/\|/g, '\\|')} | ${(t.refs ?? []).join(' ')} |`),
    '',
    '## Change requests',
    '',
    ...e.changes.map((c) => `- ${c.id} [${c.status}] ${c.title}: ${c.reason.replace(/\n/g, ' ')}`),
  ].join('\n');
};

export async function exportHub(pos, flags) {
  const { api } = clientFromConfig();
  const out = path.resolve(typeof flags.out === 'string' ? flags.out : `c1-export-${new Date().toISOString().slice(0, 10)}`);
  const data = await api.get('/export');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'hub.json'), JSON.stringify(data, null, 2));
  for (const e of data.epics ?? []) fs.writeFileSync(path.join(out, `${e.project.id}.md`), md(e));
  fs.mkdirSync(path.join(out, 'inputs'), { recursive: true });
  for (const i of data.inputs ?? []) for (const v of i.versions ?? []) fs.writeFileSync(path.join(out, 'inputs', `${i.id}-v${v.version}.md`), v.body);
  fs.writeFileSync(path.join(out, 'decisions.md'), ['# Decisions', '', ...(data.decisions ?? []).map((r) => `## ${r.id} ${r.title}\n\n${r.choice}\n\n${r.reason ?? ''}\n\nStatus: ${r.status}${r.supersededBy ? ` (by ${r.supersededBy})` : ''} · ${r.by} · ${day(r.at)}\n`)].join('\n'));
  return { data: { out, epics: (data.epics ?? []).length, inputs: (data.inputs ?? []).length, decisions: (data.decisions ?? []).length }, text: `Exported ${(data.epics ?? []).length} epics, ${(data.inputs ?? []).length} inputs and ${(data.decisions ?? []).length} decisions to ${out}` };
}
