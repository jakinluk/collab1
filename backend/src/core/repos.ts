import type { Project, Repo, TicketType } from '../shared/types';
import { globPrefix, prefixesOverlap } from './paths';

export type RepoLike = Partial<Repo> & { name: string; url: string };
type ProjectLike = Omit<Project, 'repos' | 'links' | 'tags'> & { repos: RepoLike[]; links?: Project['links']; tags?: Project['tags'] };

export const normalizeRepo = (r: RepoLike, projectId: string): Repo => ({
  name: r.name,
  url: r.url,
  baseBranch: r.baseBranch ?? 'main',
  integrationBranch: r.integrationBranch ?? `hack/${projectId}`,
  hotPaths: r.hotPaths ?? [],
  contractPaths: r.contractPaths ?? [],
  setup: r.setup ?? [],
  verify: r.verify ?? [],
  ...(r.instructionsPath ? { instructionsPath: r.instructionsPath } : {}),
  laneMap: r.laneMap ?? [],
  prLabels: r.prLabels ?? [],
  ...(r.notes ? { notes: r.notes } : {}),
  ...(r.fromCatalog ? { fromCatalog: true } : {}),
});

export const normalizeProject = (p: ProjectLike): Project => ({
  ...p,
  repos: p.repos.map((r) => normalizeRepo(r, p.id)),
  links: p.links ?? [],
  tags: p.tags ?? [],
});

const segs = (p: string): string[] => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').split('/').filter(Boolean);

const segmentRegex = (seg: string): RegExp => {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

const matchSegs = (path: string[], pat: string[]): boolean => {
  if (pat.length === 0) return path.length === 0;
  const [head, ...rest] = pat;
  if (head === '**') {
    for (let i = 0; i <= path.length; i++) if (matchSegs(path.slice(i), rest)) return true;
    return false;
  }
  if (path.length === 0) return false;
  return segmentRegex(head).test(path[0]) && matchSegs(path.slice(1), rest);
};

export const globMatches = (path: string, pattern: string): boolean => matchSegs(segs(path), segs(pattern));

export const ownsProtected = (owned: string, protectedGlob: string): boolean => {
  const pp = globPrefix(protectedGlob);
  if (pp !== '') return prefixesOverlap(globPrefix(owned), pp);
  return globMatches(owned, protectedGlob);
};

export const CONTRACT_TYPES: readonly TicketType[] = ['contract', 'glue'];

export const protectedPathErrors = (
  label: string,
  type: TicketType,
  pathsOwned: readonly string[],
  repo: Repo,
): string[] => {
  if (CONTRACT_TYPES.includes(type)) return [];
  const errors: string[] = [];
  for (const owned of pathsOwned) {
    const hot = repo.hotPaths.find((h) => ownsProtected(owned, h));
    if (hot) errors.push(`${label}: owns ${owned}, which overlaps hot path ${hot} of repo ${repo.name} (only contract or glue tickets may own it)`);
    const contract = repo.contractPaths.find((c) => ownsProtected(owned, c));
    if (contract) errors.push(`${label}: owns ${owned}, which overlaps contract path ${contract} of repo ${repo.name} (only contract or glue tickets may own it)`);
  }
  return errors;
};

export const lanesFromMap = (pathsOwned: readonly string[], repo: Repo): string[] => {
  const lanes: string[] = [];
  for (const hint of repo.laneMap) {
    const hp = segs(globPrefix(hint.glob));
    const hit = pathsOwned.some((owned) => {
      const op = segs(globPrefix(owned));
      if (hp.length === 0) return globMatches(owned, hint.glob);
      return op.length >= hp.length && hp.every((s, i) => s === op[i]);
    });
    if (hit && !lanes.includes(hint.lane)) lanes.push(hint.lane);
  }
  return lanes;
};
