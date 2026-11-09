import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError, clientFromConfig, createClient, enc, normalizeApiUrl } from './api.mjs';
import { addSessionTickets, currentSessionId, loadConfig, removeSessionTicket, saveConfig, storeToken } from './config.mjs';
import { doctor, formatDoctor } from './doctor.mjs';
import { activeCacheFile } from './hooks.mjs';
import { scanSecrets } from './secrets.mjs';
import { shareSkill, syncSkills } from './skills.mjs';
import { completeRepo, formatProject, formatRepo, gitRemote, gitToplevel, linkRepo, resolveRepoPath, sameRemote, unlinkRepo, withDefaults } from './repos.mjs';
import { ago, list, slug, table, truncate } from './util.mjs';

const fail = (msg, code = 'invalid') => {
  throw new ApiError(0, code, msg);
};
const need = (v, msg) => (v === undefined || v === true || v === '' ? fail(msg) : v);
const readFileJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(need(file, '--file <path> is required'), 'utf8'));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail(`cannot read ${file}: ${e.message}`);
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return fail(`cannot read ${file}: ${e.message}`);
  }
};

function ctx(flags) {
  const { cfg, api } = clientFromConfig();
  const projectId = typeof flags.project === 'string' ? flags.project : cfg.projectId;
  return { cfg, api, projectId };
}
const needProject = (projectId) => projectId || fail('no project: pass --project <id> or pin one with c1 me pin <id>');

const ticketLine = (t) =>
  [t.id, t.status, truncate(t.title, 60), (t.lanes ?? []).join(','), t.booking ? `${t.booking.seatId}${t.booking.workerId ? '/' + t.booking.workerId : ''}` : '', `p${t.priority}${t.wave !== undefined ? ' w' + t.wave : ''}`];

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

// ---------- join / me / status ----------

export async function join(flags) {
  const code = String(need(flags.code, '--code XXXX-XXXX is required (create one in the board: Tokens & Macs)')).trim().toUpperCase();
  const prev = loadConfig();
  const apiUrl = flags.api ? normalizeApiUrl(flags.api) : prev?.apiUrl ?? fail('--api <board URL> is required the first time');
  const res = await createClient({ apiUrl }).post('/join', { code, machine: os.hostname().slice(0, 120), ...(flags.label ? { sessionLabel: String(flags.label) } : {}) }, { noAuth: true });
  const where = storeToken(res.seatId, res.token);
  const cfg = {
    apiUrl: res.apiUrl ? normalizeApiUrl(res.apiUrl) : apiUrl,
    boardUrl: res.boardUrl,
    events: res.events,
    seatId: res.seatId,
    tokenId: res.tokenId,
    expiresAt: res.expiresAt,
    projectId: res.projectId ?? null,
    workMode: prev?.workMode ?? 'solo',
    lanes: prev?.lanes ?? [],
  };
  saveConfig(cfg);
  if (typeof flags.project === 'string') {
    const api = createClient({ apiUrl: cfg.apiUrl, token: res.token });
    await api.patch('/me', { pinProject: flags.project });
    cfg.projectId = flags.project;
    saveConfig(cfg);
  }
  return {
    data: { seatId: cfg.seatId, projectId: cfg.projectId, apiUrl: cfg.apiUrl, boardUrl: cfg.boardUrl, tokenStoredIn: where },
    text: [
      `Joined as ${cfg.seatId}. Agent token stored in the ${where === 'keychain' ? 'macOS Keychain' : `file ${path.join(process.env.C1_HOME || '~/.c1', 'token')} (mode 600)`}.`,
      cfg.projectId ? `Pinned project: ${cfg.projectId}.` : 'No project yet: run c1 project list, then c1 me pin <project>.',
      'Next: c1 doctor, then c1 me mode <solo|subagents|multi_session|factory> and c1 me lanes <a,b>.',
      'Restart Claude Code in the project so the monitor and hooks pick up the new configuration.',
    ].join('\n'),
  };
}

export async function me(pos, flags) {
  const { cfg, api } = clientFromConfig();
  const [sub, value] = pos;
  if (!sub) {
    const r = await api.get('/me');
    const s = r.seat;
    return {
      data: r,
      text: [
        `${s.name} (${s.id}) · ${s.workMode} · autopilot ${s.autopilot ? 'on' : 'off'} · plan ${s.plan}`,
        `Project: ${r.projectId ?? '—'} · lanes: ${(s.lanes ?? []).join(', ') || 'any'} · limit: ${s.maxConcurrentBookings ?? 'none'}`,
        `Rules v${r.rules?.version}`,
      ].join('\n'),
    };
  }
  let patch;
  if (sub === 'mode') patch = { workMode: need(value, 'c1 me mode <solo|subagents|multi_session|factory>') };
  else if (sub === 'autopilot') patch = { autopilot: /^(on|true|1|yes)$/i.test(need(value, 'c1 me autopilot on|off')) };
  else if (sub === 'lanes') patch = { lanes: list(value ?? '') };
  else if (sub === 'limit') patch = { maxConcurrentBookings: /^(none|off|0)$/i.test(need(value, 'c1 me limit <n|none>')) ? null : Number(value) };
  else if (sub === 'pin') {
    const pid = need(value, 'c1 me pin <project>');
    if (cfg.projectId && cfg.projectId !== pid) {
      const { tickets } = await api.get(`/projects/${enc(cfg.projectId)}/tickets`);
      for (const t of (tickets ?? []).filter((x) => x.booking?.seatId === cfg.seatId && ['booked', 'in_progress'].includes(x.status)))
        await api.post(`/tickets/${enc(t.id)}/release`, { reason: `seat re-pinned to ${pid}`, failed: false });
    }
    patch = { pinProject: pid };
  } else return fail(`unknown: c1 me ${sub}`);
  const seat = await api.patch('/me', patch);
  saveConfig({ ...cfg, projectId: seat.projects?.[0] ?? cfg.projectId, workMode: seat.workMode, lanes: seat.lanes ?? [] });
  return { data: seat, text: `Updated: ${Object.keys(patch).join(', ')}.` };
}

export async function status() {
  const cfg = loadConfig();
  if (!cfg) return { data: { joined: false }, text: 'Not joined. Run /c1:join.' };
  const { api } = clientFromConfig();
  const health = await api.get('/health', { noAuth: true }).catch((e) => ({ ok: false, error: e.message }));
  const r = await api.get('/me');
  let board = null;
  if (r.projectId) board = await api.get(`/board?projectId=${enc(r.projectId)}`).catch(() => null);
  const counts = {};
  for (const t of board?.tickets ?? []) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return {
    data: { health, me: r, counts },
    text: [
      `Hub: ${health.ok ? 'reachable' : 'NOT reachable'} (${cfg.apiUrl})`,
      `Seat: ${r.seat.id} · ${r.seat.workMode} · autopilot ${r.seat.autopilot ? 'on' : 'off'} · project ${r.projectId ?? '—'}`,
      board ? `Tickets: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}` : '',
      `Board: ${cfg.boardUrl ?? ''}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

// ---------- projects / goals / plans / rules (human actions go through proposals) ----------

async function propose(api, action, payload, summary) {
  return api.post('/proposals', { action, payload, summary: truncate(summary, 300) });
}

const unwrapProject = (res) => res?.project ?? res;

export async function fetchProject(api, pid) {
  const p = unwrapProject(await api.get(`/projects/${enc(pid)}`));
  return { ...p, repos: (p?.repos ?? []).map((r) => withDefaults(r, p.id ?? pid)) };
}

const parseLink = (spec) => {
  const m = /^([^=]+)=(https:\/\/\S+)$/.exec(String(spec)) ?? fail(`--link must look like "label=https://…", got ${spec}`);
  return { label: m[1].trim(), url: m[2] };
};

/** name=url[@integration-branch]; an "@" only starts a branch when what follows looks like a branch, not a host. */
export function parseRepoSpec(spec) {
  const m = /^([A-Za-z0-9._-]+)=(.+)$/.exec(String(spec)) ?? fail(`--repo must look like name=url[@integration-branch], got ${spec}`);
  let url = m[2].trim();
  let integrationBranch;
  const at = url.lastIndexOf('@');
  if (at > 0) {
    const cand = url.slice(at + 1);
    if (/^[A-Za-z0-9._\/-]+$/.test(cand) && !cand.split('/')[0].includes('.')) {
      integrationBranch = cand;
      url = url.slice(0, at);
    }
  }
  return { name: m[1], url, ...(integrationBranch ? { integrationBranch } : {}) };
}

/** Build a project.create / project.update payload from --file and flags. */
export function buildProjectPayload(flags, { forUpdate = false, projectId } = {}) {
  const file = typeof flags.file === 'string' ? readFileJson(flags.file) : {};
  const name = typeof flags.name === 'string' ? flags.name : file.name;
  const pid = projectId ?? (typeof flags.id === 'string' ? flags.id : file.id ?? (name ? slug(name) : undefined));
  if (!forUpdate && !name) fail('--name (or "name" in --file) is required');
  if (!pid) fail('cannot work out the project id: pass --id');
  const presetName = typeof flags.preset === 'string' ? flags.preset : undefined;
  const fromFlags = list(flags.repo).map(parseRepoSpec);
  const byName = new Map();
  for (const r of [...(file.repos ?? []), ...fromFlags]) byName.set(r.name, { ...(byName.get(r.name) ?? {}), ...r });
  let repos;
  try {
    repos = [...byName.values()].map((r) => completeRepo(r, pid, r.preset ? undefined : presetName));
  } catch (e) {
    fail(e.message);
  }
  if (!forUpdate && !repos.length) fail('at least one repo is required (--repo name=url or "repos" in --file)');
  const links = [...(file.links ?? []), ...(Array.isArray(flags.link) ? flags.link : []).filter((x) => typeof x === "string").map(parseLink)];
  for (const l of links) if (!/^https:\/\//.test(l.url ?? '')) fail(`link "${l.label}" must be an https:// URL`);
  const demo = { ...(file.demo ?? {}) };
  if (typeof flags['demo-url'] === 'string') demo.url = flags['demo-url'];
  if (typeof flags.stage === 'string') demo.stage = flags.stage;
  if (demo.url && !/^https:\/\//.test(demo.url)) fail('the demo URL must be https://');
  const lanes = [...new Set([...(file.lanes ?? []), ...list(flags.lane)])];
  const tags = [...new Set([...(file.tags ?? []), ...list(flags.tag)])];
  const description = typeof flags.description === 'string' ? flags.description : file.description;
  const payload = forUpdate ? { projectId: pid } : { id: pid, name };
  if (forUpdate && name) payload.name = name;
  if (repos.length) payload.repos = repos;
  if (!forUpdate || lanes.length) payload.lanes = lanes;
  if (description) payload.description = description;
  if (Object.keys(demo).length) payload.demo = demo;
  if (!forUpdate || links.length) payload.links = links;
  if (!forUpdate || tags.length) payload.tags = tags;
  return payload;
}

export async function project(pos, flags) {
  const { api, cfg } = clientFromConfig();
  const [sub, id] = pos;
  if (!sub || sub === 'list') {
    const { projects } = await api.get('/projects');
    return { data: projects, text: table((projects ?? []).map((p) => [p.id, p.name, p.status, p.phase, (p.repos ?? []).map((r) => r.name).join(',')]), ['id', 'name', 'status', 'phase', 'repos']) };
  }
  if (sub === 'show') {
    const pid = typeof id === 'string' ? id : cfg.projectId ?? fail('c1 project show <id>');
    const p = await fetchProject(api, pid);
    return { data: p, text: formatProject(p, (r) => resolveRepoPath(pid, r)) };
  }
  if (sub === 'propose-new' || sub === 'new') {
    const payload = buildProjectPayload(flags);
    const r = await propose(api, 'project.create', payload, `Create project ${payload.name} (${payload.id}) with repos ${payload.repos.map((x) => x.name).join(', ')}`);
    return { data: r, text: printProposal(r) };
  }
  if (sub === 'propose-update' || sub === 'update') {
    const pid = need(id, 'c1 project propose-update <id> --file project.json');
    const payload = buildProjectPayload(flags, { forUpdate: true, projectId: pid });
    if (Object.keys(payload).length <= 1) fail('nothing to update: pass --file, --description, --link, --tag, --lane, --repo or --name');
    const r = await propose(api, 'project.update', payload, `Update project ${pid}: ${Object.keys(payload).filter((k) => k !== 'projectId').join(', ')}`);
    return { data: r, text: printProposal(r) };
  }
  if (['freeze', 'archive', 'activate', 'demo'].includes(sub)) {
    const statusMap = { freeze: 'frozen', archive: 'archived', activate: 'active', demo: 'demo' };
    const pid = need(id, `c1 project ${sub} <id>`);
    const r = await propose(api, 'project.status', { projectId: pid, status: statusMap[sub] }, `Set ${pid} to ${statusMap[sub]}`);
    return { data: r, text: printProposal(r) };
  }
  if (sub === 'phase') {
    const [, pid, phase] = pos;
    const r = await propose(api, 'project.phase', { projectId: need(pid, 'c1 project phase <id> <plan|build|freeze|demo>'), phase: need(phase, 'phase required') }, `${pid} phase → ${phase}`);
    return { data: r, text: printProposal(r) };
  }
  return fail(`unknown: c1 project ${sub}`);
}

// ---------- repos (local checkouts, never sent to the hub) ----------

export async function repo(pos, flags) {
  const { api, projectId } = ctx(flags);
  const pid = needProject(projectId);
  const [sub = 'list', name, dir] = pos;
  const p = await fetchProject(api, pid);
  const find = (n) => p.repos.find((r) => r.name === n) ?? fail(`project ${pid} has no repo "${n}" (repos: ${p.repos.map((r) => r.name).join(', ') || 'none'})`, 'not_found');
  switch (sub) {
    case 'list': {
      const rows = p.repos.map((r) => {
        const local = resolveRepoPath(pid, r);
        return [r.name, r.url, `${r.baseBranch} → ${r.integrationBranch}`, local ? `${local.path}${local.exists === false ? ' (missing)' : ''}` : 'not linked'];
      });
      return { data: p.repos.map((r) => ({ ...r, local: resolveRepoPath(pid, r) })), text: rows.length ? table(rows, ['repo', 'url', 'branches', 'local']) : `Project ${pid} has no repos.` };
    }
    case 'show': {
      const r = find(need(name, 'c1 repo show <name>'));
      return { data: { ...r, local: resolveRepoPath(pid, r) }, text: formatRepo(r, resolveRepoPath(pid, r)) };
    }
    case 'link': {
      const r = find(need(name, 'c1 repo link <name> [path]'));
      const target = path.resolve(typeof dir === 'string' ? dir : process.cwd());
      if (!fs.existsSync(target)) fail(`${target} does not exist`);
      const top = gitToplevel(target) ?? fail(`${target} is not inside a git checkout`);
      const remote = gitRemote(top);
      const saved = linkRepo(pid, r.name, top);
      const warn = remote && !sameRemote(remote, r.url) ? `\nWarning: origin of ${top} is ${remote}, but the project lists ${r.url}.` : '';
      return { data: { project: pid, repo: r.name, path: saved, remote }, text: `Linked ${r.name} → ${saved}${warn}` };
    }
    case 'unlink': {
      const n = need(name, 'c1 repo unlink <name>');
      const removed = unlinkRepo(pid, n);
      return { data: { removed }, text: removed ? `Unlinked ${n}.` : `${n} was not linked.` };
    }
    case 'path': {
      const r = find(need(name, 'c1 repo path <name>'));
      const local = resolveRepoPath(pid, r);
      if (!local) return { data: null, text: `${r.name} is not linked on this Mac. Run: c1 repo link ${r.name} <path to your checkout of ${r.url}>`, exit: 2 };
      if (local.via === 'remote') linkRepo(pid, r.name, local.path);
      return { data: local, text: local.path, exit: local.exists === false ? 2 : 0 };
    }
    default:
      return fail(`unknown: c1 repo ${sub} (list | show <name> | link <name> [path] | unlink <name> | path <name>)`);
  }
}

export async function goal(pos, flags) {
  const { api, projectId } = ctx(flags);
  const pid = needProject(projectId);
  if (!pos[0] || pos[0] === 'show') {
    const { goal: g } = await api.get(`/projects/${enc(pid)}/goal`);
    if (!g) return { data: null, text: `${pid} has no goal yet. Draft one and run c1 goal propose --file goal.json.` };
    return {
      data: g,
      text: [`Goal v${g.version} (${pid}): ${g.statement}`, 'Definition of done:', ...g.definitionOfDone.map((d, i) => `  ${i}. ${d}`), g.demoScript ? `Demo script:\n${g.demoScript}` : '', g.nonGoals?.length ? `Non-goals: ${g.nonGoals.join('; ')}` : '']
        .filter(Boolean)
        .join('\n'),
    };
  }
  if (pos[0] === 'propose') {
    const body = readFileJson(flags.file);
    const r = await propose(api, 'goal.set', { ...body, projectId: pid }, `Goal for ${pid}: ${body.statement ?? ''}`);
    return { data: r, text: printProposal(r) };
  }
  return fail(`unknown: c1 goal ${pos[0]}`);
}

export async function plan(pos, flags) {
  const { api, projectId } = ctx(flags);
  const pid = needProject(projectId);
  if (pos[0] !== 'propose') return fail('usage: c1 plan propose --file tasks.json [--project <id>]');
  const body = readFileJson(flags.file);
  const tickets = Array.isArray(body) ? body : body.tickets ?? fail('the file must be an array of tickets or { "tickets": [...] }');
  const r = await propose(api, 'plan.load', { projectId: pid, tickets }, `Plan for ${pid}: ${tickets.length} tickets`);
  return { data: r, text: printProposal(r) };
}

export async function rules(pos, flags) {
  const { api, projectId } = ctx(flags);
  if (!pos[0] || pos[0] === 'show') {
    const r = await api.get(`/rules${projectId ? `?projectId=${enc(projectId)}` : ''}`);
    return {
      data: r,
      text: `Rules v${r.version}${projectId ? ` (merged for ${projectId})` : ''}\n${table(
        (r.rules ?? []).map((x) => [x.code, x.name, x.severity, x.resolver, x.timeoutMin ? `${x.timeoutMin}m` : '—', x.stopScope, x.maxAttempts ?? '—']),
        ['code', 'name', 'sev', 'resolver', 'timeout', 'stop', 'attempts'],
      )}`,
    };
  }
  if (pos[0] === 'propose') {
    const code = need(flags.code, '--code B3 is required');
    let patch = {};
    if (flags.file) patch = readFileJson(flags.file);
    for (const kv of list(flags.set)) {
      const i = kv.indexOf('=');
      if (i < 0) fail(`--set expects key=value, got ${kv}`);
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      patch[k] = /^\d+$/.test(v) ? Number(v) : v;
    }
    const scoped = typeof flags.project === 'string';
    const r = scoped
      ? await propose(api, 'rules.override', { projectId: flags.project, code, patch }, `Override ${code} for ${flags.project}`)
      : await propose(api, 'rules.set', { code, patch }, `Change rule ${code}: ${Object.keys(patch).join(', ')}`);
    return { data: r, text: printProposal(r) };
  }
  return fail(`unknown: c1 rules ${pos[0]}`);
}

// ---------- tickets ----------

export async function ticket(pos, flags) {
  const { api, projectId } = ctx(flags);
  const [sub, tid] = pos;
  const sessionId = currentSessionId(flags);
  if (['next', 'book', 'release', 'review-ready', 'block', 'start'].includes(sub) && projectId) fs.rmSync(activeCacheFile(projectId), { force: true });
  switch (sub ?? 'list') {
    case 'list': {
      const pid = needProject(projectId);
      const q = new URLSearchParams();
      if (typeof flags.status === 'string') q.set('status', flags.status);
      if (flags.ready) q.set('ready', 'true');
      const { tickets } = await api.get(`/projects/${enc(pid)}/tickets${q.size ? `?${q}` : ''}`);
      return { data: tickets, text: table((tickets ?? []).map(ticketLine), ['id', 'status', 'title', 'lanes', 'owner', 'prio']) };
    }
    case 'show': {
      const r = await api.get(`/tickets/${enc(need(tid, 'c1 ticket show <id>'))}`);
      const t = r.ticket ?? {};
      let rp = r.repo;
      if (!rp && t.repo && t.projectId) rp = (await fetchProject(api, t.projectId).catch(() => ({ repos: [] }))).repos.find((x) => x.name === t.repo);
      const repoText = rp ? `\n\n${formatRepo(withDefaults(rp, t.projectId), resolveRepoPath(t.projectId, rp))}` : '';
      return { data: rp ? { ...r, repo: rp } : r, text: (r.card ?? JSON.stringify(t, null, 2)) + repoText };
    }
    case 'add': {
      const pid = needProject(projectId);
      const t = await api.post(`/projects/${enc(pid)}/tickets`, readFileJson(flags.file));
      return { data: t, text: `${t.id} added (${t.status}): ${t.title}` };
    }
    case 'next': {
      const body = { n: flags.n ? Number(flags.n) : 1 };
      if (projectId) body.projectId = projectId;
      if (flags.lanes) body.lanes = list(flags.lanes);
      if (typeof flags.worker === 'string') body.workerId = flags.worker;
      if (sessionId) body.sessionId = sessionId;
      const { booked } = await api.post('/tickets/next', body);
      if (!booked?.length) throw new ApiError(409, 'not_ready', 'no ready ticket for you right now (check c1 review next, open help requests, or wait for the monitor)');
      addSessionTickets(sessionId, booked.map((t) => t.id));
      return { data: booked, text: booked.map((t) => `Booked ${t.id}: ${t.title}\n  branch ${t.branch ?? '—'} · repo ${t.repo} · owns ${(t.pathsOwned ?? []).join(', ')}\n  next: /c1:work ${t.id}`).join('\n') };
    }
    case 'book': {
      const body = {};
      if (typeof flags.worker === 'string') body.workerId = flags.worker;
      if (sessionId) body.sessionId = sessionId;
      const t = await api.post(`/tickets/${enc(need(tid, 'c1 ticket book <id>'))}/book`, body);
      addSessionTickets(sessionId, [t.id]);
      return { data: t, text: `Booked ${t.id}: ${t.title} (branch ${t.branch ?? '—'})` };
    }
    case 'heartbeat': {
      const r = await api.post(`/tickets/${enc(need(tid, 'c1 ticket heartbeat <id>'))}/heartbeat`, sessionId ? { sessionId } : {});
      return { data: r, text: `Lease extended until ${new Date(r.leaseExpiresAt).toLocaleTimeString()}` };
    }
    case 'start': {
      const t = await api.post(`/tickets/${enc(need(tid, 'c1 ticket start <id>'))}/status`, { status: 'in_progress', ...(flags.note ? { note: String(flags.note) } : {}) });
      return { data: t, text: `${t.id} in progress` };
    }
    case 'review-ready': {
      const t = await api.post(`/tickets/${enc(need(tid, 'c1 ticket review-ready <id> --pr <url>'))}/status`, { status: 'review', prUrl: need(flags.pr, '--pr <url> is required'), ...(flags.note ? { note: String(flags.note) } : {}) });
      return { data: t, text: `${t.id} ready for review (${t.prUrl})` };
    }
    case 'block': {
      const t = await api.post(`/tickets/${enc(need(tid, 'c1 ticket block <id> --note'))}/status`, { status: 'blocked', note: String(need(flags.note, '--note is required')) });
      return { data: t, text: `${t.id} blocked. Raise the blocker too: c1 raise blocker --rule <code> --ticket ${t.id} --summary ...` };
    }
    case 'release': {
      const id = need(tid, 'c1 ticket release <id> --reason');
      const t = await api.post(`/tickets/${enc(id)}/release`, { reason: String(need(flags.reason, '--reason is required')), failed: !!flags.failed });
      removeSessionTicket(sessionId, id);
      return { data: t, text: `${t.id} released (attempts ${t.attempts})` };
    }
    default:
      return fail(`unknown: c1 ticket ${sub}`);
  }
}

export async function review(pos, flags) {
  const { cfg, api, projectId } = ctx(flags);
  const [sub, tid] = pos;
  if (sub === 'next' || !sub) {
    const pid = needProject(projectId);
    const { tickets } = await api.get(`/projects/${enc(pid)}/tickets?status=review`);
    const now = Date.now();
    const own = (t) => (t.booking?.seatId === cfg.seatId ? 1 : 0);
    const cands = (tickets ?? [])
      .filter((t) => !t.review || t.review.leaseExpiresAt < now)
      .sort((a, b) => own(a) - own(b) || a.priority - b.priority);
    for (const t of cands) {
      try {
        const r = await api.post(`/tickets/${enc(t.id)}/review/book`, typeof flags.worker === 'string' ? { workerId: flags.worker } : {});
        return { data: r, text: `Reviewing ${r.id}: ${r.title}\n  PR ${r.prUrl ?? '—'}\n  next: /c1:review ${r.id}` };
      } catch (e) {
        // 403: a hackathon hub refuses reviews of your own seat's work; 409: someone else took it.
        if (!(e instanceof ApiError) || (e.status !== 409 && e.status !== 403)) throw e;
      }
    }
    throw new ApiError(409, 'not_ready', 'no review waiting for you');
  }
  if (sub === 'done') {
    const outcome = need(flags.outcome, '--outcome merged|changes_requested is required');
    const files = typeof flags.files === 'string' ? flags.files.split(/[\s,]+/).filter(Boolean).slice(0, 300) : undefined;
    const t = await api.post(`/tickets/${enc(need(tid, 'c1 review done <id> --outcome'))}/review/done`, {
      outcome,
      ...(flags.note ? { note: String(flags.note) } : {}),
      ...(flags.pr ? { prUrl: String(flags.pr) } : {}),
      ...(typeof flags.sha === 'string' ? { mergeSha: flags.sha } : {}),
      ...(files?.length ? { files } : {}),
    });
    return { data: t, text: `${t.id} → ${t.status}` };
  }
  return fail(`unknown: c1 review ${sub}`);
}

// ---------- escalations / decisions ----------

export async function raise(pos, flags) {
  const { api, projectId } = ctx(flags);
  const kind = need(pos[0], 'c1 raise blocker|issue|urgent|help --rule <code> --summary ...');
  if (!['blocker', 'issue', 'urgent', 'help'].includes(kind)) fail(`kind must be blocker, issue, urgent or help`);
  const detail = flags['detail-file'] ? readText(flags['detail-file']) : typeof flags.detail === 'string' ? flags.detail : '';
  const body = {
    kind,
    projectId: needProject(projectId),
    ruleCode: String(need(flags.rule, '--rule <code> is required (classify against c1 rules show)')).toUpperCase(),
    summary: String(need(flags.summary, '--summary is required')),
    detail,
    ...(typeof flags.ticket === 'string' ? { ticketId: flags.ticket } : {}),
    ...(flags.option ? { proposed: list(flags.option) } : {}),
  };
  const r = await api.post('/escalations', body);
  const e = r.escalation;
  return {
    data: r,
    text: `${e.id} raised under ${e.ruleCode} (${e.status})${r.decision ? `; vote ${r.decision.id} opened, closes ${new Date(r.decision.deadline).toLocaleTimeString()}` : ''}${e.deadline ? `; default applies at ${new Date(e.deadline).toLocaleTimeString()}` : ''}`,
  };
}

export async function answer(pos, flags) {
  const { api } = clientFromConfig();
  const e = await api.post(`/escalations/${enc(need(pos[0], 'c1 answer <eid> --text ...'))}/answer`, { text: String(need(flags.text, '--text is required')) });
  return { data: e, text: `${e.id} → ${e.status}` };
}

export async function decide(pos, flags) {
  const { cfg, api } = clientFromConfig();
  const [sub, did, option] = pos;
  if (!sub || sub === 'list') {
    const { decisions } = await api.get('/decisions?status=open');
    return {
      data: decisions,
      text: table(
        (decisions ?? []).map((d) => [d.id, d.projectId ?? 'hub', truncate(d.question, 60), d.electorate, `${d.votes?.length ?? 0} votes`, new Date(d.deadline).toLocaleTimeString(), (d.eligible ?? []).includes(cfg.seatId) ? 'you vote' : '']),
        ['id', 'project', 'question', 'electorate', 'votes', 'deadline', ''],
      ),
    };
  }
  if (sub === 'show') {
    const d = await api.get(`/decisions/${enc(need(did, 'c1 decide show <id>'))}`);
    return {
      data: d,
      text: [`${d.id}: ${d.question}`, `Options: ${d.options.map((o, i) => `${i + 1}) ${o}`).join('  ')}`, `Rule ${d.rule}, quorum ${d.quorum}, default "${d.defaultOption}", deadline ${new Date(d.deadline).toLocaleTimeString()}`, d.context ? `Context: ${d.context}` : '', ...(d.votes ?? []).map((v) => `  ${v.seat} (${v.by}): ${v.option} — ${v.why}`)]
        .filter(Boolean)
        .join('\n'),
    };
  }
  if (sub === 'vote') {
    let opt = need(option, 'c1 decide vote <id> <option> --why ...');
    const d0 = await api.get(`/decisions/${enc(need(did, 'decision id required'))}`);
    if (/^\d+$/.test(opt) && d0.options[Number(opt) - 1]) opt = d0.options[Number(opt) - 1];
    const d = await api.post(`/decisions/${enc(did)}/vote`, { option: opt, why: typeof flags.why === 'string' ? flags.why : '' });
    return { data: d, text: `Voted "${opt}" on ${d.id} (${d.votes?.length ?? 0} votes so far)` };
  }
  return fail(`unknown: c1 decide ${sub}`);
}

// ---------- knowledge ----------

const scopeOf = (flags) => (typeof flags.project === 'string' ? { projectId: flags.project } : 'global');

export async function share(pos, flags) {
  const { api } = clientFromConfig();
  const [kind, arg] = pos;
  const tags = list(flags.tags ?? flags.tag);
  if (kind === 'tip') {
    const body = String(need(arg, 'c1 share tip "text"'));
    const hits = scanSecrets(body);
    if (hits.length) fail(`refusing to share: possible secrets (${hits.map((h) => h.type).join(', ')})`);
    const item = await api.post('/knowledge', { kind: 'tip', name: typeof flags.name === 'string' ? flags.name : truncate(body, 60), tags, scope: scopeOf(flags), body });
    return { data: item, text: `Shared tip ${item.id}` };
  }
  if (kind === 'playbook') {
    const body = readText(need(arg, 'c1 share playbook <file.md> --name ...'));
    const hits = scanSecrets(body);
    if (hits.length) fail(`refusing to share: possible secrets (${hits.map((h) => `${h.type} ${h.preview}`).join(', ')})`);
    const item = await api.post('/knowledge', { kind: 'playbook', name: String(need(flags.name, '--name is required')), tags, scope: scopeOf(flags), body });
    return { data: item, text: `Shared playbook ${item.id} v${item.version}` };
  }
  if (kind === 'skill') {
    const dir = path.resolve(need(arg, 'c1 share skill <dir>'));
    const fmName = /^---\s*\n[\s\S]*?^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fs.existsSync(path.join(dir, 'SKILL.md')) ? fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') : '')?.[1];
    const name = (typeof flags.name === 'string' ? flags.name : fmName ?? path.basename(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) fail(`skill name ${name} must match [a-z0-9-]`);
    const item = await shareSkill(api, dir, { name, tags, scope: scopeOf(flags) });
    return { data: item, text: `Published skill ${name} v${item.version} (${item.id}); every Mac syncs it to ~/.claude/skills/c1--${name}/` };
  }
  if (kind === 'retire') return retire([arg]);
  return fail('usage: c1 share tip "text" | playbook <file> --name ... | skill <dir> [--name] | retire <kid>');
}

export async function retire(pos) {
  const { api } = clientFromConfig();
  const k = await api.post(`/knowledge/${enc(need(pos[0], 'c1 retire <kid>'))}/retire`, {});
  return { data: k, text: `${k.id} (${k.name}) retired` };
}

export async function kb(pos) {
  const { api } = clientFromConfig();
  if (pos[0] !== 'search') return fail('usage: c1 kb search <words>');
  const words = pos.slice(1).map((w) => w.toLowerCase());
  const { items } = await api.get('/knowledge?status=active');
  const hits = (items ?? []).filter((k) => {
    const hay = `${k.name} ${(k.tags ?? []).join(' ')} ${k.body ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return {
    data: hits,
    text: hits.length ? hits.map((k) => `${k.id} [${k.kind}] ${k.name} v${k.version} by ${k.author}${k.body ? `\n  ${truncate(k.body, 300)}` : ''}`).join('\n') : 'Nothing found.',
  };
}

export async function sync() {
  const { cfg, api } = clientFromConfig();
  const r = await syncSkills(api, cfg);
  const parts = [r.added.length && `added ${r.added.join(', ')}`, r.updated.length && `updated ${r.updated.join(', ')}`, r.removed.length && `removed ${r.removed.join(', ')}`, r.errors.length && `errors: ${r.errors.join('; ')}`].filter(Boolean);
  return { data: r, text: parts.length ? `Skills: ${parts.join(' · ')}` : 'Skills are up to date.' };
}

// ---------- messages, board, events ----------

export async function say(pos, flags) {
  const { api } = clientFromConfig();
  const text = need(pos.join(' '), 'c1 say "text" [--to seat]');
  await api.post('/messages', { to: typeof flags.to === 'string' ? flags.to : 'all', text, ...(typeof flags.project === 'string' ? { projectId: flags.project } : {}) });
  return { data: { ok: true }, text: 'Sent.' };
}

export async function board(pos, flags) {
  const { cfg, api, projectId } = ctx(flags);
  const b = await api.get(`/board${projectId ? `?projectId=${enc(projectId)}` : ''}`);
  const cols = ['ready', 'booked', 'in_progress', 'review', 'blocked', 'done'];
  const by = Object.fromEntries(cols.map((c) => [c, []]));
  for (const t of b.tickets ?? []) (by[t.status] ??= []).push(t);
  const lines = [];
  lines.push(`CollabOne · ${b.project?.name ?? projectId ?? 'no project'} · phase ${b.project?.phase ?? '—'} · seq ${b.lastSeq}`);
  if (b.goal) lines.push(`Goal v${b.goal.version}: ${truncate(b.goal.statement, 160)}`);
  lines.push('');
  for (const c of cols) {
    const ts = by[c] ?? [];
    if (!ts.length && c === 'done') continue;
    lines.push(`${c.toUpperCase()} (${ts.length})${ts.length ? ': ' + ts.slice(0, 8).map((t) => `${t.id}${t.booking ? '@' + t.booking.seatId : ''} ${truncate(t.title, 40)}`).join(' | ') : ''}`);
  }
  if (b.escalations?.length) lines.push('', `Open escalations: ${b.escalations.map((e) => `${e.id} ${e.ruleCode} ${truncate(e.summary, 50)}`).join(' | ')}`);
  if (b.decisions?.length) lines.push(`Open votes: ${b.decisions.map((d) => `${d.id} ${truncate(d.question, 50)}`).join(' | ')}`);
  if (b.proposals?.length) lines.push(`Waiting for a human: ${b.proposals.map((p) => `${p.id} ${truncate(p.summary, 50)}`).join(' | ')}`);
  lines.push('', `Board: ${cfg.boardUrl ?? ''}`);
  return { data: b, text: lines.join('\n') };
}

export async function events(pos, flags) {
  const { api } = clientFromConfig();
  const since = Number(flags.since ?? 0);
  const r = await api.get(`/events?since=${since}&limit=${Number(flags.limit ?? 50)}`);
  return { data: r, text: (r.events ?? []).map((e) => `${String(e.seq).padStart(5)} ${new Date(e.ts).toLocaleTimeString()} ${e.type.padEnd(22)} ${truncate(e.summary, 140)}`).join('\n') || 'No events.' };
}

export async function runDoctor(flags) {
  const r = await doctor({ api: typeof flags.api === 'string' ? flags.api : undefined });
  return { data: r, text: formatDoctor(r), exit: r.ok ? 0 : 1 };
}

export { ago };
