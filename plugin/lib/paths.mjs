
const norm = (p) =>
  String(p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');

export function globToRegExp(glob) {
  const g = norm(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export const staticPrefix = (glob) => {
  const segs = norm(glob).split('/');
  const out = [];
  for (const s of segs) {
    if (/[*?[]/.test(s)) break;
    out.push(s);
  }
  return out.join('/');
};

export function matchesGlob(file, glob) {
  const f = norm(file);
  const g = norm(glob);
  if (!/[*?[]/.test(g)) return f === g || f.startsWith(g + '/');
  if (g.endsWith('/**') && f === g.slice(0, -3)) return true;
  return globToRegExp(g).test(f);
}

export const matchesAny = (file, globs) => (globs ?? []).find((g) => matchesGlob(file, g));

export function relativeToRoot(filePath, root) {
  const f = norm(filePath);
  const r = norm(root);
  if (!f.startsWith('/')) return f;
  if (r && (f === r || f.startsWith(r + '/'))) return f.slice(r.length + 1);
  return null;
}

export function overlaps(a, b) {
  const pa = staticPrefix(a).split('/').filter(Boolean);
  const pb = staticPrefix(b).split('/').filter(Boolean);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

const CONTRACT_TYPES = new Set(['contract', 'glue']);

/**
 * Decide what the PreToolUse guard does with an edit.
 * mine: tickets booked by this seat/session (in this repo); others: other active tickets (in this repo);
 * protect: the repo's { hotPaths, contractPaths } (an array is treated as hotPaths).
 * Contract paths are open to contract/glue tickets; hot paths only to a ticket that owns them explicitly.
 */
export function guardDecision(relPath, mine, others, protect = {}) {
  const { hotPaths = [], contractPaths = [] } = Array.isArray(protect) ? { hotPaths: protect } : protect;
  if (relPath === null) return { action: 'allow', reason: 'outside the repository' };
  if (!mine.length) return { action: 'allow', reason: 'no booked ticket' };
  const own = mine.find((t) => matchesAny(relPath, t.pathsOwned));
  if (own) return { action: 'allow', reason: `owned by your ticket ${own.id}` };
  const ids = mine.map((t) => t.id).join(', ');
  const hotHit = matchesAny(relPath, hotPaths);
  if (hotHit)
    return {
      action: 'block',
      rule: 'B2',
      reason: `${relPath} is a protected shared path of this repo (${hotHit}). Do not edit it from ${ids}. Raise it: c1 raise blocker --rule B2 --ticket ${mine[0].id} --summary "Need change to ${relPath}"`,
    };
  const contractHit = mine.some((t) => CONTRACT_TYPES.has(t.type)) ? undefined : matchesAny(relPath, contractPaths);
  if (contractHit)
    return {
      action: 'block',
      rule: 'B1',
      reason: `${relPath} is a shared contract path (${contractHit}); only contract or glue tickets change contracts. Raise it: c1 raise blocker --rule B1 --ticket ${mine[0].id} --summary "Contract change needed in ${relPath}" --option "<proposed change>"`,
    };
  const other = others.find((t) => matchesAny(relPath, t.pathsOwned));
  if (other)
    return {
      action: 'block',
      rule: 'B2',
      reason: `${relPath} is owned by ${other.id} (${other.booking?.seatId ?? 'another seat'}). Raise it: c1 raise blocker --rule B2 --ticket ${mine[0].id} --summary "Need change to ${relPath} owned by ${other.id}"`,
    };
  return { action: 'warn', reason: `${relPath} is outside ${ids} pathsOwned; keep the change minimal or raise B2` };
}
