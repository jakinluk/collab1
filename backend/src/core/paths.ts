const GLOB_CHARS = /[*?[\]{}!]/;

export const globPrefix = (glob: string): string => {
  const parts = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || GLOB_CHARS.test(part)) break;
    out.push(part);
  }
  return out.join('/');
};

const segments = (prefix: string): string[] => (prefix === '' ? [] : prefix.split('/'));

export const prefixesOverlap = (a: string, b: string): boolean => {
  const sa = segments(a);
  const sb = segments(b);
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return false;
  return true;
};

export const globsOverlap = (a: string, b: string): boolean => prefixesOverlap(globPrefix(a), globPrefix(b));

export const pathSetsOverlap = (a: readonly string[], b: readonly string[]): boolean =>
  a.some((x) => b.some((y) => globsOverlap(x, y)));

export const lockPrefixes = (paths: readonly string[]): string[] => {
  const prefixes = [...new Set(paths.map(globPrefix))].sort((x, y) => x.length - y.length);
  const kept: string[] = [];
  for (const p of prefixes) if (!kept.some((k) => prefixesOverlap(k, p) && segments(k).length <= segments(p).length)) kept.push(p);
  return kept;
};
