import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { c1Home, readJson, writeJson } from './util.mjs';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const PRESET_FIELDS = ['baseBranch', 'hotPaths', 'contractPaths', 'setup', 'verify', 'instructionsPath', 'laneMap', 'prLabels', 'notes'];
const LIST_FIELDS = ['hotPaths', 'contractPaths', 'setup', 'verify', 'laneMap', 'prLabels'];

export const reposFile = () => path.join(c1Home(), 'repos.json');

export function loadPresets() {
  return readJson(path.join(TEMPLATES, 'repo-presets.json'), {}) ?? {};
}

export function preset(name) {
  const p = loadPresets()[name];
  if (!p) throw new Error(`unknown preset "${name}" (known: ${Object.keys(loadPresets()).join(', ')})`);
  const out = {};
  for (const k of PRESET_FIELDS) if (p[k] !== undefined) out[k] = structuredClone(p[k]);
  return out;
}

/** Fill a repo from a preset (only fields the repo leaves unset or empty) and apply contract defaults. */
export function completeRepo(repo, projectId, presetName) {
  const r = { ...repo };
  const name = presetName ?? r.preset;
  delete r.preset;
  if (name) {
    const p = preset(name);
    for (const [k, v] of Object.entries(p)) {
      const cur = r[k];
      if (cur === undefined || cur === null || (Array.isArray(cur) && !cur.length) || cur === '') r[k] = v;
    }
  }
  return withDefaults(r, projectId);
}

export function withDefaults(repo, projectId) {
  const r = { ...repo };
  r.baseBranch ||= 'main';
  r.integrationBranch ||= `hack/${projectId}`;
  for (const k of LIST_FIELDS) if (!Array.isArray(r[k])) r[k] = [];
  return r;
}

/** host/org/repo, host lower-cased, no scheme, user, port, .git or trailing slash. */
export function normalizeRemote(url) {
  if (!url) return '';
  let u = String(url).trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  let host;
  let rest;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
    if (!m) return u.toLowerCase();
    [, host, rest] = m;
  } else if (scp) {
    [, host, rest] = scp;
  } else {
    return u.replace(/^\/+/, '');
  }
  return `${host.toLowerCase()}/${rest.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')}`;
}

export const sameRemote = (a, b) => {
  const na = normalizeRemote(a);
  return !!na && na.toLowerCase() === normalizeRemote(b).toLowerCase();
};

const git = (dir, args) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
};
export function existingDir(dir) {
  let d = path.resolve(dir || process.cwd());
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}
export const gitToplevel = (dir) => git(existingDir(dir), ['rev-parse', '--show-toplevel']);
export const gitRemote = (dir) => git(dir || process.cwd(), ['remote', 'get-url', 'origin']);

export const loadLinks = () => readJson(reposFile(), {}) ?? {};
export const linksFor = (projectId) => loadLinks()[projectId] ?? {};
export const linkedPath = (projectId, name) => linksFor(projectId)[name] ?? null;

export function linkRepo(projectId, name, dir) {
  const all = loadLinks();
  all[projectId] = { ...(all[projectId] ?? {}), [name]: path.resolve(dir) };
  writeJson(reposFile(), all);
  return all[projectId][name];
}

export function unlinkRepo(projectId, name) {
  const all = loadLinks();
  if (!all[projectId]?.[name]) return false;
  delete all[projectId][name];
  if (!Object.keys(all[projectId]).length) delete all[projectId];
  writeJson(reposFile(), all);
  return true;
}

const inside = (child, parent) => {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
};

/**
 * Which project repo does `dir` belong to? Local links first (a worktree inside a linked checkout counts),
 * then origin remote URL matching. Returns { repo, root, via } or null.
 */
export function identifyRepo(dir, projectId, repos = []) {
  const target = path.resolve(dir || process.cwd());
  const top = gitToplevel(target);
  const links = linksFor(projectId);
  for (const r of repos) {
    const p = links[r.name];
    if (p && (inside(target, p) || (top && inside(top, p)))) return { repo: r, root: top && inside(top, p) ? top : p, via: 'link' };
  }
  const remote = top && gitRemote(top);
  if (remote) {
    const r = repos.find((x) => sameRemote(x.url, remote));
    if (r) return { repo: r, root: top, via: 'remote' };
  }
  return null;
}

/** Resolve a repo's local checkout: linked path, or `dir` (default cwd) when its origin matches. */
export function resolveRepoPath(projectId, repo, dir) {
  const linked = linkedPath(projectId, repo.name);
  if (linked) return { path: linked, via: 'link', exists: fs.existsSync(linked) };
  const root = gitToplevel(dir);
  if (root && sameRemote(repo.url, gitRemote(root))) return { path: root, via: 'remote', exists: true };
  return null;
}

const listOr = (xs, empty = '—') => (xs?.length ? xs.join(', ') : empty);

export function formatRepo(repo, local) {
  const r = withDefaults(repo, '<project>');
  const lines = [
    `repo ${r.name}  ${r.url}`,
    `  branches: base ${r.baseBranch} → integration ${r.integrationBranch}`,
    `  local:    ${local ? `${local.path}${local.exists === false ? ' (missing!)' : ''}${local.via === 'remote' ? ' (matched by remote)' : ''}` : `not linked (c1 repo link ${r.name} <path>)`}`,
    `  hot paths:      ${listOr(r.hotPaths)}`,
    `  contract paths: ${listOr(r.contractPaths)}`,
    `  setup:  ${listOr(r.setup)}`,
    `  verify: ${r.verify?.length ? r.verify.map((v) => `${v.name}: ${v.cmd}`).join(' · ') : '—'}`,
  ];
  if (r.instructionsPath) lines.push(`  instructions: ${r.instructionsPath}`);
  if (r.laneMap?.length) lines.push(`  lanes: ${r.laneMap.map((l) => `${l.glob} → ${l.lane}`).join(', ')}`);
  if (r.prLabels?.length) lines.push(`  PR labels: ${r.prLabels.join(', ')}`);
  if (r.notes) lines.push(`  notes: ${r.notes}`);
  return lines.join('\n');
}

export function formatProject(p, localFor = () => null) {
  const lines = [`${p.name} (${p.id})  status ${p.status ?? '?'} · phase ${p.phase ?? '?'}${p.goalVersion ? ` · goal v${p.goalVersion}` : ''}`];
  if (p.description) lines.push(p.description);
  if (p.lanes?.length) lines.push(`lanes: ${p.lanes.join(', ')}`);
  if (p.tags?.length) lines.push(`tags: ${p.tags.join(', ')}`);
  if (p.demo && (p.demo.url || p.demo.stage || p.demo.notes)) lines.push(`demo: ${[p.demo.url, p.demo.stage && `stage ${p.demo.stage}`, p.demo.notes].filter(Boolean).join(' · ')}`);
  for (const l of p.links ?? []) lines.push(`link: ${l.label} ${l.url}`);
  for (const r of p.repos ?? []) lines.push('', formatRepo({ ...r, integrationBranch: r.integrationBranch || `hack/${p.id}` }, localFor(r)));
  return lines.join('\n');
}
