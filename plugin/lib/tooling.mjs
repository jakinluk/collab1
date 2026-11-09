import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, clientFromConfig } from './api.mjs';
import { readSession, currentSessionId } from './config.mjs';
import { scanSecrets } from './secrets.mjs';
import { clientVersion, compareVersions, installKind, PLUGIN_ROOT, updateState } from './version.mjs';
import { truncate } from './util.mjs';

const fail = (msg, code = 'invalid') => {
  throw new ApiError(0, code, msg);
};
const need = (v, msg) => (v === undefined || v === true || v === '' ? fail(msg) : v);
const AREAS = ['plugin', 'board', 'backend', 'docs'];
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** h1 bug "summary" [--detail …] [--area plugin|board|backend|docs] [--urgent] [--ticket T4] */
export async function bug(pos, flags) {
  const summary = need(pos.join(' ').trim(), 'h1 bug "what went wrong" [--detail "…"] [--area plugin|board|backend|docs] [--urgent]');
  const area = typeof flags.area === 'string' ? flags.area : 'plugin';
  if (!AREAS.includes(area)) fail(`--area must be one of ${AREAS.join(', ')}`);
  const detail = typeof flags.detail === 'string' ? flags.detail : typeof flags['detail-file'] === 'string' ? fs.readFileSync(flags['detail-file'], 'utf8') : '';
  const hits = scanSecrets(`${summary}\n${detail}`);
  if (hits.length) fail(`refusing to report: possible secrets (${hits.map((h) => h.type).join(', ')})`);
  let ticketId = typeof flags.ticket === 'string' ? flags.ticket : undefined;
  if (!ticketId) {
    try {
      ticketId = readSession(currentSessionId())?.ticketIds?.[0];
    } catch {
      /* no session context */
    }
  }
  const { api } = clientFromConfig();
  const body = { summary: truncate(summary, 160), detail: `${detail}${detail ? '\n\n' : ''}HackathonOne ${clientVersion()} on ${process.platform}.`.slice(0, 4000), area, urgent: Boolean(flags.urgent), ...(ticketId ? { ticketId } : {}) };
  const t = await api.post('/tool/bugs', body);
  return { data: t, text: `Filed ${t.id} in the HackathonOne fix queue (${area}${flags.urgent ? ', urgent' : ''}): ${t.title}\nWhoever is pinned to project hackathonone picks it up. Keep working; use a workaround if you have one.` };
}

/** h1 version: installed version against the hub's latest release. */
export async function version() {
  const installed = clientVersion();
  let release = null;
  try {
    ({ release } = await clientFromConfig({ timeoutMs: 5000 }).api.get('/release'));
  } catch {
    /* offline or not joined: show the local version only */
  }
  const state = updateState(installed, release);
  const line = !release
    ? `HackathonOne ${installed} (no release published on the hub)`
    : state === 'current'
      ? `HackathonOne ${installed} — up to date (latest ${release.latest})`
      : `HackathonOne ${installed} — ${release.latest} is out${state === 'blocked' ? `; ${release.minimum} or newer is required before you can change anything on the hub` : ''}. Run /h1:update.\n  ${release.notes}`;
  return { data: { installed, release, state, install: installKind(), root: PLUGIN_ROOT }, text: line, exit: state === 'blocked' ? 3 : 0 };
}

const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }).trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message ?? e) };
  }
};

/**
 * h1 update: pulls the newest plugin through Claude Code's own plugin manager. The hub only announces versions;
 * the code always comes from the marketplace repository.
 */
export async function update(pos, flags) {
  const marketplace = typeof flags.marketplace === 'string' ? flags.marketplace : process.env.H1_MARKETPLACE || 'hackathonone';
  const before = clientVersion();
  if (installKind() === 'in_place') {
    const repoRoot = path.resolve(PLUGIN_ROOT, '..');
    const isGit = fs.existsSync(path.join(repoRoot, '.git'));
    return {
      data: { install: 'in_place', root: PLUGIN_ROOT, before },
      text: [
        `This plugin is loaded in place from ${PLUGIN_ROOT}, so Claude Code reads that folder directly.`,
        isGit ? `Update it with: git -C "${repoRoot}" pull --ff-only` : `Copy the new version into ${repoRoot}.`,
        'Then run /reload-plugins in each open session.',
      ].join('\n'),
    };
  }
  if (flags['dry-run']) return { data: { marketplace }, text: `Would run: claude plugin marketplace update ${marketplace} && claude plugin update h1@${marketplace}` };
  const steps = [run('claude', ['plugin', 'marketplace', 'update', marketplace]), run('claude', ['plugin', 'update', `h1@${marketplace}`])];
  const failed = steps.find((s) => !s.ok);
  if (failed) return { data: { steps }, text: `Update failed:\n${failed.out}\nRun /plugin, open Marketplaces → ${marketplace} and update it there.`, exit: 1 };
  return {
    data: { steps, before },
    text: `${steps.map((s) => s.out).filter(Boolean).join('\n')}\nRun /reload-plugins in each open Claude Code session (or start a new one) to load it.`,
  };
}

/** h1 release show | propose --version 0.3.1 --notes "…" [--minimum 0.3.0] */
export async function release(pos, flags) {
  const sub = pos[0] ?? 'show';
  const { api } = clientFromConfig();
  if (sub === 'show') {
    const { release: r } = await api.get('/release');
    return { data: r, text: r ? `Latest ${r.latest}${r.minimum ? ` · minimum ${r.minimum}` : ''} · by ${r.by} · ${new Date(r.publishedAt).toLocaleString()}\n${r.notes}` : 'No release published yet.' };
  }
  if (sub !== 'propose') fail('usage: h1 release show | h1 release propose --version x.y.z --notes "…" [--minimum x.y.z]');
  const v = String(need(flags.version, '--version is required'));
  if (!SEMVER.test(v)) fail('--version must look like 0.3.1');
  const minimum = typeof flags.minimum === 'string' ? flags.minimum : undefined;
  if (minimum && (!SEMVER.test(minimum) || compareVersions(minimum, v) > 0)) fail('--minimum must look like 0.3.0 and not be newer than --version');
  if (compareVersions(clientVersion(), v) !== 0) process.stderr.write(`h1: note: this plugin is ${clientVersion()}, the release says ${v}. Bump plugin/.claude-plugin/plugin.json so Claude Code ships it.\n`);
  const notes = String(need(flags.notes, '--notes is required'));
  const r = await api.post('/proposals', { action: 'release.publish', payload: { version: v, notes, ...(minimum ? { minimum } : {}) }, summary: truncate(`Release HackathonOne ${v}: ${notes}`, 300) });
  return { data: r, text: `Proposal ${r.proposal?.id} is waiting for a human.\nApprove it in the board: ${r.approveUrl}` };
}
