import { createHash } from 'node:crypto';
import type { DodItem, EpicInfo, EpicState, Goal, ImpactEntry, InputSection, Ticket } from '../shared/types';
import { fail } from './errors';
import { ownsProtected } from './repos';
import { pathSetsOverlap } from './paths';

// ---------- definition of done with stable ids ----------

const DOD_ID_RE = /^d(\d+)$/;

/**
 * Gives every definition-of-done item a stable id. Items passed as {id, text} keep their id; plain strings
 * reuse the id of an earlier item with the same text, otherwise get the next free id.
 */
export const assignDodIds = (previous: readonly DodItem[] | undefined, items: readonly (string | DodItem)[]): DodItem[] => {
  const prev = previous ?? [];
  let next = Math.max(0, ...prev.map((d) => Number(DOD_ID_RE.exec(d.id)?.[1] ?? 0)), ...items.map((d) => (typeof d === 'string' ? 0 : Number(DOD_ID_RE.exec(d.id)?.[1] ?? 0))));
  const used = new Set<string>();
  return items.map((item) => {
    if (typeof item !== 'string') {
      if (!DOD_ID_RE.test(item.id)) fail('invalid', `definition-of-done id ${item.id} must look like d1, d2…`);
      if (used.has(item.id)) fail('invalid', `definition-of-done id ${item.id} is used twice`);
      used.add(item.id);
      return { id: item.id, text: item.text };
    }
    const same = prev.find((d) => d.text === item && !used.has(d.id));
    const id = same ? same.id : `d${++next}`;
    used.add(id);
    return { id, text: item };
  });
};

export const dodOf = (goal: Goal | undefined): DodItem[] => goal?.dod ?? (goal?.definitionOfDone ?? []).map((text, i) => ({ id: `d${i + 1}`, text }));

/** Definition-of-done ids whose text changed or that were removed between two scope versions. */
export const changedDod = (before: readonly DodItem[], after: readonly DodItem[]): { changed: string[]; added: string[] } => {
  const now = new Map(after.map((d) => [d.id, d.text]));
  const was = new Map(before.map((d) => [d.id, d.text]));
  return {
    changed: before.filter((d) => now.get(d.id) !== d.text).map((d) => d.id),
    added: after.filter((d) => !was.has(d.id)).map((d) => d.id),
  };
};

// ---------- input sections ----------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const EXPLICIT_ANCHOR_RE = /\s*\{#([a-z0-9][a-z0-9-]{0,60})\}\s*$/;

export const anchorSlug = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'section';

const hashText = (s: string): string => createHash('sha256').update(s.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/**
 * Splits a markdown document into sections by heading. Each section's anchor comes from an explicit {#anchor}
 * after the heading, or from the heading text. Text before the first heading is the "intro" section.
 */
export const parseSections = (body: string): (InputSection & { text: string })[] => {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: (InputSection & { text: string; lines: string[] })[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  let current: (InputSection & { text: string; lines: string[] }) | undefined;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : HEADING_RE.exec(line);
    if (m) {
      const explicit = EXPLICIT_ANCHOR_RE.exec(m[2]);
      const title = m[2].replace(EXPLICIT_ANCHOR_RE, '').trim();
      let anchor = explicit ? explicit[1] : anchorSlug(title);
      const n = (seen.get(anchor) ?? 0) + 1;
      seen.set(anchor, n);
      if (n > 1) anchor = `${anchor}-${n}`;
      current = { anchor, title, level: m[1].length, hash: '', text: '', lines: [] };
      out.push(current);
      continue;
    }
    if (!current) {
      if (!line.trim()) continue;
      current = { anchor: 'intro', title: 'Introduction', level: 0, hash: '', text: '', lines: [] };
      seen.set('intro', 1);
      out.push(current);
    }
    current.lines.push(line);
  }
  return out.map(({ lines: ls, ...s }) => {
    const text = ls.join('\n').trim();
    return { ...s, text, hash: hashText(`${s.title}\n${text}`) };
  });
};

export const diffSections = (
  before: readonly InputSection[],
  after: readonly InputSection[],
): { added: string[]; changed: string[]; removed: string[]; unchanged: string[] } => {
  const was = new Map(before.map((s) => [s.anchor, s.hash]));
  const now = new Map(after.map((s) => [s.anchor, s.hash]));
  return {
    added: after.filter((s) => !was.has(s.anchor)).map((s) => s.anchor),
    changed: after.filter((s) => was.has(s.anchor) && was.get(s.anchor) !== s.hash).map((s) => s.anchor),
    removed: before.filter((s) => !now.has(s.anchor)).map((s) => s.anchor),
    unchanged: after.filter((s) => was.get(s.anchor) === s.hash).map((s) => s.anchor),
  };
};

// ---------- refs ----------

export const REF_RE = /^(dod:d\d+|input:I\d+(#[a-z0-9][a-z0-9-]{0,60})?|decision:R\d+)$/;

export type Ref =
  | { kind: 'dod'; id: string }
  | { kind: 'input'; id: string; anchor?: string }
  | { kind: 'decision'; id: string };

export const parseRef = (ref: string): Ref => {
  if (!REF_RE.test(ref)) fail('invalid', `bad ref "${ref}": use dod:d1, input:I1#anchor, input:I1 or decision:R1`);
  const [kind, rest] = ref.split(':') as [Ref['kind'], string];
  if (kind === 'input') {
    const [id, anchor] = rest.split('#');
    return { kind, id, ...(anchor ? { anchor } : {}) };
  }
  return { kind, id: rest } as Ref;
};

/** True when a ticket citing `cited` is affected by a change to `changed`. A whole-input ref covers its sections. */
export const refCovers = (cited: string, changed: string): boolean => {
  if (cited === changed) return true;
  const c = parseRef(cited);
  const x = parseRef(changed);
  if (c.kind !== 'input' || x.kind !== 'input' || c.id !== x.id) return false;
  return !c.anchor || !x.anchor;
};

// ---------- impact candidates ----------

const OPEN_FOR_IMPACT: readonly Ticket['status'][] = ['planned', 'ready', 'booked', 'in_progress', 'review', 'blocked', 'done'];

export interface CandidateQuery {
  changedRefs: readonly string[];
  /** Tickets that own or read these paths in this repo are affected (a contract change from another epic). */
  paths?: { repo: string; globs: readonly string[] };
  ticketIds?: readonly string[];
  milestone?: string;
}

/** The tickets a change touches, worked out mechanically: cited refs, owned or read paths, explicit picks, and their dependents. */
export const impactCandidates = (tickets: readonly Ticket[], q: CandidateQuery): ImpactEntry[] => {
  const why = new Map<string, string[]>();
  const add = (t: Ticket, reason: string): void => {
    why.set(t.id, [...(why.get(t.id) ?? []), reason]);
  };
  for (const t of tickets) {
    if (!OPEN_FOR_IMPACT.includes(t.status)) continue;
    for (const c of q.changedRefs) {
      const hit = (t.refs ?? []).find((r) => refCovers(r, c));
      if (hit) add(t, `cites ${hit} (changed: ${c})`);
    }
    if (q.paths && t.repo === q.paths.repo) {
      const mine = [...t.pathsOwned, ...(t.pathsRead ?? []), ...(t.files ?? [])];
      const hit = q.paths.globs.find((g) => mine.some((p) => ownsProtected(p, g) || pathSetsOverlap([p], [g])));
      if (hit) add(t, `uses contract path ${hit}`);
    }
    if (q.ticketIds?.includes(t.id)) add(t, 'picked for this change');
    if (q.milestone && t.milestone === q.milestone) add(t, `in milestone ${q.milestone}`);
  }
  const direct = new Set(why.keys());
  for (const t of tickets) {
    if (direct.has(t.id) || !OPEN_FOR_IMPACT.includes(t.status) || t.status === 'done') continue;
    const dep = t.deps.find((d) => direct.has(d));
    if (dep) add(t, `depends on ${dep}`);
  }
  return tickets
    .filter((t) => why.has(t.id))
    .map((t) => ({ ticketId: t.id, title: t.title, statusAtOpen: t.status, ticketVersion: t.version, why: why.get(t.id) as string[] }));
};

export const isSuspect = (t: Pick<Ticket, 'suspectBy'>): boolean => (t.suspectBy?.length ?? 0) > 0;

// ---------- epics ----------

export const CLAIMABLE_EPIC_STATES: readonly EpicState[] = ['planned', 'in_progress', 'release'];

const EPIC_MOVES: Record<EpicState, readonly EpicState[]> = {
  proposed: ['planned', 'archived'],
  planned: ['in_progress', 'paused', 'archived', 'proposed'],
  in_progress: ['release', 'paused', 'done', 'planned'],
  release: ['done', 'in_progress', 'paused'],
  done: ['archived', 'in_progress'],
  paused: ['planned', 'in_progress', 'archived'],
  archived: ['planned'],
};

export const assertEpicMove = (from: EpicState, to: EpicState): void => {
  if (from === to) return;
  if (!EPIC_MOVES[from].includes(to)) fail('conflict', `an epic cannot move from ${from} to ${to} (allowed: ${EPIC_MOVES[from].join(', ')})`);
};

export const defaultEpic = (owner: string): EpicInfo => ({ state: 'planned', milestones: [], owners: [owner], priority: 100, decisionMode: 'owners' });

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
