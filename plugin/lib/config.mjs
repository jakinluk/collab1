import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureDir, c1Home, readJson, writeJson } from './util.mjs';

const SERVICE = 'c1-agent-token';

export const configPath = () => path.join(c1Home(), 'config.json');
export const statePath = () => path.join(c1Home(), 'state.json');
export const tokenFilePath = () => path.join(c1Home(), 'token');
export const cacheDir = () => ensureDir(path.join(c1Home(), 'cache'));
export const sessionsDir = () => ensureDir(path.join(c1Home(), 'sessions'));

export const loadConfig = () => readJson(configPath(), null);
export const saveConfig = (cfg) => writeJson(configPath(), cfg);

export const loadState = () => readJson(statePath(), { lastSeq: 0, syncedSkills: {} }) ?? { lastSeq: 0, syncedSkills: {} };
export function saveState(patch) {
  const next = { ...loadState(), ...patch };
  writeJson(statePath(), next);
  return next;
}

const useKeychain = () => {
  if (process.env.C1_TOKEN_FILE === '1' || process.platform !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/which', ['security'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export function storeToken(seatId, token) {
  if (useKeychain()) {
    try {
      execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', seatId, '-w', token], { stdio: 'ignore' });
      try {
        fs.rmSync(tokenFilePath(), { force: true });
      } catch {
        /* nothing to clean */
      }
      return 'keychain';
    } catch {
      /* fall through to file */
    }
  }
  ensureDir(c1Home());
  fs.writeFileSync(tokenFilePath(), token + '\n', { mode: 0o600 });
  fs.chmodSync(tokenFilePath(), 0o600);
  return 'file';
}

export function readToken(seatId) {
  if (process.env.C1_TOKEN) return process.env.C1_TOKEN;
  if (useKeychain() && seatId) {
    try {
      return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', seatId, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      /* fall back to file */
    }
  }
  try {
    return fs.readFileSync(tokenFilePath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function sessionFile(sessionId) {
  return path.join(sessionsDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

export function readSession(sessionId) {
  if (!sessionId) return { ticketIds: [] };
  return readJson(sessionFile(sessionId), { ticketIds: [] }) ?? { ticketIds: [] };
}

export function addSessionTickets(sessionId, ids) {
  if (!sessionId || !ids.length) return;
  const s = readSession(sessionId);
  s.ticketIds = [...new Set([...(s.ticketIds ?? []), ...ids])];
  s.updatedAt = Date.now();
  writeJson(sessionFile(sessionId), s);
}

export function removeSessionTicket(sessionId, id) {
  if (!sessionId) return;
  const s = readSession(sessionId);
  s.ticketIds = (s.ticketIds ?? []).filter((t) => t !== id);
  writeJson(sessionFile(sessionId), s);
}

export const currentSessionId = (flags = {}) =>
  (typeof flags.session === 'string' && flags.session) || process.env.C1_SESSION_ID || process.env.CLAUDE_SESSION_ID || undefined;
