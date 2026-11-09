import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BOOLEAN_FLAGS = new Set(['json', 'ready', 'failed', 'help', 'all', 'quiet', 'no-sync', 'force', 'urgent', 'dry-run']);
export const ARRAY_FLAGS = new Set(['option', 'repo', 'lane', 'set', 'tag', 'link']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      let key = a.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (BOOLEAN_FLAGS.has(key)) {
        value = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[++i];
      } else {
        value = true;
      }
      if (BOOLEAN_FLAGS.has(key) && typeof value === 'string') value = !/^(false|0|no)$/i.test(value);
      if (ARRAY_FLAGS.has(key)) (flags[key] ??= []).push(value);
      else flags[key] = value;
    } else if (a === '-h') {
      flags.help = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export const list = (v) =>
  (Array.isArray(v) ? v : v === undefined || v === true ? [] : [v])
    .flatMap((x) => String(x).split(','))
    .map((x) => x.trim())
    .filter(Boolean);

export const c1Home = () => process.env.C1_HOME || path.join(os.homedir(), '.c1');
export const skillsDir = () => process.env.C1_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

export const truncate = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…';
};

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export async function readStdin(timeoutMs = 1500) {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.resume();
  });
}

export function parseJsonSafe(s, fallback = {}) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

export function table(rows, headers) {
  const all = headers ? [headers, ...rows] : rows;
  const widths = [];
  for (const r of all) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, String(c ?? '').length)));
  const line = (r) => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  const out = all.map(line);
  if (headers) out.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
  return out.join('\n');
}

export const ago = (ts, now = Date.now()) => {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const jitteredBackoff = (attempt, baseMs = 500, maxMs = 30000) => {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
  return ceiling / 2 + Math.random() * (ceiling / 2);
};
