import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { enc } from './api.mjs';
import { loadState, saveState } from './config.mjs';
import { scanSecrets } from './secrets.mjs';
import { ensureDir, skillsDir } from './util.mjs';

export const MAX_SKILL_BYTES = 2 * 1024 * 1024;
export const skillFolderName = (name) => `h1--${String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}`;

/** Returns a list of problems with archive entry names (absolute paths, `..`, links outside). */
export function unsafeEntries(entries) {
  const bad = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const n = e.replace(/\\/g, '/');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) bad.push(`${e}: absolute path`);
    else if (n.split('/').includes('..')) bad.push(`${e}: parent directory reference`);
  }
  return bad;
}

const tar = (args, opts = {}) => execFileSync('tar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, ...opts });

export function extractSkill(archivePath, name) {
  const entries = tar(['-tzf', archivePath]).split('\n');
  const bad = unsafeEntries(entries);
  if (bad.length) throw new Error(`refusing skill archive ${name}: ${bad.slice(0, 3).join('; ')}`);
  const target = path.join(ensureDir(skillsDir(), 0o755), skillFolderName(name));
  const staging = `${target}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  tar(['-xzf', archivePath, '-C', staging, '--no-same-owner']);
  if (!fs.existsSync(path.join(staging, 'SKILL.md'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`skill archive ${name} has no SKILL.md at its root`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  return target;
}

export function removeSkill(name) {
  const target = path.join(skillsDir(), skillFolderName(name));
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

const inScope = (item, projectId) => item.scope === 'global' || !item.scope || item.scope?.projectId === projectId;

/** Downloads new or updated skills and removes retired ones. Returns { added:[], updated:[], removed:[] }. */
export async function syncSkills(api, cfg, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const state = loadState();
  const synced = { ...(state.syncedSkills ?? {}) };
  const result = { added: [], updated: [], removed: [], errors: [] };
  const active = (await api.get('/knowledge?status=active')).items ?? [];
  const latest = new Map();
  for (const k of active) {
    if (k.kind !== 'skill' || !inScope(k, cfg.projectId)) continue;
    const prev = latest.get(k.name);
    if (!prev || k.version > prev.version) latest.set(k.name, k);
  }
  for (const k of latest.values()) {
    const have = synced[k.name];
    if (have && have.version >= k.version && fs.existsSync(path.join(skillsDir(), skillFolderName(k.name), 'SKILL.md'))) continue;
    try {
      const { url } = await api.get(`/knowledge/${enc(k.id)}/download-url`);
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_SKILL_BYTES) throw new Error('archive larger than 2 MB');
      const tmp = path.join(os.tmpdir(), `h1-skill-${process.pid}-${k.id}.tgz`);
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      try {
        extractSkill(tmp, k.name);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      (have ? result.updated : result.added).push(`${k.name} v${k.version}`);
      synced[k.name] = { id: k.id, version: k.version };
    } catch (e) {
      result.errors.push(`${k.name}: ${e.message}`);
      log(`skill ${k.name}: ${e.message}`);
    }
  }
  for (const name of Object.keys(synced)) {
    if (latest.has(name)) continue;
    if (removeSkill(name)) result.removed.push(name);
    delete synced[name];
  }
  saveState({ syncedSkills: synced });
  return result;
}

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`${p} is a symlink; shared skills cannot contain links`);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function scanDir(dir) {
  const findings = [];
  for (const f of walkFiles(dir)) {
    const st = fs.statSync(f);
    if (st.size > 1024 * 1024) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const s of scanSecrets(text)) findings.push({ file: path.relative(dir, f), ...s });
  }
  return findings;
}

export function packSkill(dir) {
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`${dir} has no SKILL.md`);
  const findings = scanDir(dir);
  if (findings.length) {
    const e = new Error(`refusing to share: possible secrets found (${findings.map((f) => `${f.file}: ${f.type} ${f.preview}`).join('; ')})`);
    e.code = 'invalid';
    throw e;
  }
  const out = path.join(os.tmpdir(), `h1-share-${process.pid}-${Date.now()}.tgz`);
  tar(['-czf', out, '-C', dir, '.']);
  const size = fs.statSync(out).size;
  if (size > MAX_SKILL_BYTES) {
    fs.rmSync(out, { force: true });
    throw new Error(`skill archive is ${Math.round(size / 1024)} KB; the limit is 2 MB`);
  }
  return out;
}

export async function shareSkill(api, dir, { name, tags = [], scope = 'global', fetchImpl = globalThis.fetch }) {
  const archive = packSkill(dir);
  try {
    const { uploadUrl, s3Key } = await api.post('/knowledge/skills/upload-url', { name });
    const res = await fetchImpl(uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: fs.readFileSync(archive) });
    if (!res.ok) throw new Error(`upload failed with HTTP ${res.status}`);
    return await api.post('/knowledge', { kind: 'skill', name, tags, scope, s3Key });
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

export { enc };
