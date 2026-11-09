import type { Repo, Seat, Settings, Ticket, TicketStatus } from '../shared/types';
import { fail } from './errors';
import { numericPart } from './ids';
import { pathSetsOverlap } from './paths';

export const ACTIVE_STATUSES: readonly TicketStatus[] = ['booked', 'in_progress', 'review', 'blocked'];
export const isActive = (t: Ticket): boolean => ACTIVE_STATUSES.includes(t.status);

export const depsDone = (ticket: Ticket, all: readonly Ticket[]): boolean => {
  const byId = new Map(all.map((t) => [t.id, t]));
  return ticket.deps.every((d) => byId.get(d)?.status === 'done');
};

export const conflictingTicket = (ticket: Ticket, all: readonly Ticket[]): Ticket | undefined =>
  all.find(
    (o) =>
      o.id !== ticket.id &&
      isActive(o) &&
      o.projectId === ticket.projectId &&
      o.repo === ticket.repo &&
      pathSetsOverlap(o.pathsOwned, ticket.pathsOwned),
  );

export type Readiness = { ok: true } | { ok: false; code: 'not_ready' | 'path_conflict'; reason: string; conflictsWith?: string };

export const readiness = (ticket: Ticket, all: readonly Ticket[]): Readiness => {
  if (ticket.status !== 'ready') return { ok: false, code: 'not_ready', reason: `status is ${ticket.status}` };
  if (!depsDone(ticket, all)) {
    const pending = ticket.deps.filter((d) => all.find((t) => t.id === d)?.status !== 'done');
    return { ok: false, code: 'not_ready', reason: `waiting for ${pending.join(', ')}` };
  }
  const c = conflictingTicket(ticket, all);
  if (c) return { ok: false, code: 'path_conflict', reason: `paths overlap with ${c.id}`, conflictsWith: c.id };
  return { ok: true };
};

export const activeBookingsOf = (seatId: string, all: readonly Ticket[]): number =>
  all.filter((t) => (t.status === 'booked' || t.status === 'in_progress') && t.booking?.seatId === seatId).length;

export const seatLimit = (seat: Seat, settings: Settings): number | undefined => {
  const limits = [seat.maxConcurrentBookings, settings.maxBookingsPerSeat].filter((x): x is number => typeof x === 'number');
  return limits.length ? Math.min(...limits) : undefined;
};

export const assertSeatUnderLimit = (seat: Seat, settings: Settings, bookedNow: number): void => {
  const limit = seatLimit(seat, settings);
  if (limit !== undefined && bookedNow >= limit) fail('conflict', `seat ${seat.id} already holds ${bookedNow} bookings (limit ${limit})`);
};

export const pickOrder = (candidates: readonly Ticket[], lanes: readonly string[]): Ticket[] => {
  const laneMatch = (t: Ticket): number => (lanes.length === 0 || t.lanes.length === 0 || t.lanes.some((l) => lanes.includes(l)) ? 0 : 1);
  return [...candidates].sort(
    (a, b) =>
      laneMatch(a) - laneMatch(b) ||
      (a.wave ?? Number.MAX_SAFE_INTEGER) - (b.wave ?? Number.MAX_SAFE_INTEGER) ||
      a.priority - b.priority ||
      numericPart(a.id) - numericPart(b.id),
  );
};

export const claimable = (all: readonly Ticket[], projectId: string, lanes: readonly string[]): Ticket[] =>
  pickOrder(
    all.filter((t) => t.projectId === projectId && readiness(t, all).ok),
    lanes,
  );

export const newlyReadyDependents = (doneId: string, all: readonly Ticket[]): Ticket[] =>
  all.filter((t) => t.status === 'ready' && t.deps.includes(doneId) && depsDone(t, all));

type Transition = { from: readonly TicketStatus[]; to: TicketStatus };

const TRANSITIONS: Record<string, Transition> = {
  book: { from: ['ready'], to: 'booked' },
  start: { from: ['booked', 'in_progress', 'blocked'], to: 'in_progress' },
  review: { from: ['booked', 'in_progress'], to: 'review' },
  block: { from: ['booked', 'in_progress'], to: 'blocked' },
  release: { from: ['booked', 'in_progress', 'blocked', 'review'], to: 'ready' },
  merged: { from: ['review'], to: 'done' },
  changes: { from: ['review'], to: 'in_progress' },
  park: { from: ['booked', 'in_progress', 'blocked', 'ready', 'review'], to: 'blocked' },
  unpark: { from: ['blocked'], to: 'ready' },
  drop: { from: ['planned', 'ready', 'blocked'], to: 'dropped' },
  triage: { from: ['planned'], to: 'ready' },
};

export type TransitionName = keyof typeof TRANSITIONS;

export const transition = (ticket: Ticket, name: TransitionName): TicketStatus => {
  const t = TRANSITIONS[name];
  if (!t.from.includes(ticket.status)) fail('conflict', `cannot ${name} ${ticket.id} while it is ${ticket.status}`);
  return t.to;
};

export const statusTransitionFor = (status: 'in_progress' | 'review' | 'blocked'): TransitionName =>
  status === 'in_progress' ? 'start' : status === 'review' ? 'review' : 'block';

export const renderCard = (t: Ticket, repo?: Repo): string => {
  const lines = [
    `# ${t.id} · ${t.title}`,
    '',
    `Project: ${t.projectId} · Repo: ${t.repo} · Type: ${t.type} · Status: ${t.status}${t.wave !== undefined ? ` · Wave ${t.wave}` : ''} · Priority ${t.priority}`,
    t.lanes.length ? `Lanes: ${t.lanes.join(', ')}` : '',
    t.branch ? `Branch: ${t.branch}` : '',
    t.prUrl ? `PR: ${t.prUrl}` : '',
    t.deps.length ? `Depends on: ${t.deps.join(', ')}` : '',
    '',
    t.description,
    '',
    '## Owned paths (you may edit only these)',
    ...t.pathsOwned.map((p) => `- ${p}`),
    ...(t.pathsRead?.length ? ['', '## Read-only paths', ...t.pathsRead.map((p) => `- ${p}`)] : []),
    '',
    '## Acceptance',
    ...t.acceptance.map((a) => `- ${a.criterion}${a.cmd ? `\n  \`${a.cmd}\`` : ''}`),
    ...(repo ? repoCardLines(repo) : []),
  ];
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n').trim();
};

const repoCardLines = (r: Repo): string[] => [
  '',
  `## Repo ${r.name}`,
  `Remote: ${r.url} · Base: ${r.baseBranch} · Integration branch: ${r.integrationBranch}`,
  ...(r.instructionsPath ? [`Read first: ${r.instructionsPath}`] : []),
  ...(r.setup.length ? ['Setup:', ...r.setup.map((c) => `- \`${c}\``)] : []),
  ...(r.verify.length ? ['Verify:', ...r.verify.map((v) => `- ${v.name}: \`${v.cmd}\``)] : []),
  ...(r.hotPaths.length ? [`Hot paths (never edit from a build ticket): ${r.hotPaths.join(', ')}`] : []),
  ...(r.contractPaths.length ? [`Contract paths (contract/glue tickets only): ${r.contractPaths.join(', ')}`] : []),
  ...(r.prLabels.length ? [`PR labels: ${r.prLabels.join(', ')}`] : []),
  ...(r.notes ? ['', r.notes] : []),
];
