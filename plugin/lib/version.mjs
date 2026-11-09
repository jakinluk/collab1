import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cached;
/** The installed plugin version from .claude-plugin/plugin.json (H1_CLIENT_VERSION overrides it, for tests). */
export function clientVersion() {
  if (process.env.H1_CLIENT_VERSION) return process.env.H1_CLIENT_VERSION;
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

export const compareVersions = (a, b) => {
  const pa = String(a).split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
};

/** 'current' | 'behind' | 'blocked' for an installed version against the hub's release record. */
export function updateState(installed, release) {
  if (!release?.latest) return 'current';
  if (release.minimum && compareVersions(installed, release.minimum) < 0) return 'blocked';
  return compareVersions(installed, release.latest) < 0 ? 'behind' : 'current';
}

/**
 * Where Claude Code loads this plugin from. A marketplace install lives in Claude Code's plugin cache and is
 * updated with `claude plugin update`; a plugin loaded in place (local marketplace or --plugin-dir) changes
 * when its folder changes.
 */
export function installKind(root = PLUGIN_ROOT) {
  return /[\\/]\.claude[\\/]plugins[\\/]/.test(root) ? 'cache' : 'in_place';
}
