import { describe, expect, it } from 'vitest';
import type { Decision, Seat, Settings, Ticket } from '../src/shared/types';
import { globPrefix, globsOverlap, lockPrefixes, pathSetsOverlap, prefixesOverlap } from '../src/core/paths';
import { claimable, newlyReadyDependents, pickOrder, readiness, transition, assertSeatUnderLimit, renderCard } from '../src/core/tickets';
import { validatePlan } from '../src/core/plan';
import { globMatches, lanesFromMap, normalizeProject, normalizeRepo, ownsProtected, protectedPathErrors } from '../src/core/repos';
import { DEFAULT_RULES, findRule, mergeRules, rulesDigest } from '../src/core/rules';
import { castVote, effectiveVotes, settle, tally } from '../src/core/quorum';
import { affectedSeats, answerByAgent, applyDecisionOutcome, contest, planEscalation, resolveByHuman, sweepEscalation } from '../src/core/escalations';
import { channelFor, envelope, MAX_DATA_BYTES } from '../src/core/envelope';
import { scanSecrets } from '../src/core/secrets';
import { generateAgentToken, generateJoinCode, hashSecret, isAgentToken, stripBearer } from '../src/core/tokens';
import { slugify, ticketBranch } from '../src/core/ids';
import type { TicketInput } from '../src/shared/schemas';

const MONO = [normalizeRepo({ name: 'mono', url: 'git@x:mono.git' }, 'p1')];

const t = (over: Partial<Ticket> & { id: string }): Ticket => ({
  projectId: 'p1',
  repo: 'mono',
  title: over.id,
  description: '',
  type: 'slice',
  lanes: [],
  deps: [],
  pathsOwned: [`services/${over.id.toLowerCase()}/**`],
  acceptance: [{ criterion: 'works' }],
  priority: 100,
  status: 'ready',
  attempts: 0,
  createdBy: 'a',
  createdByAgent: false,
  log: [],
  updatedAt: 0,
  version: 1,
  ...over,
});

const settings: Settings = { leaseTtlSec: 900, defaultContestMin: 5, rulesVersion: 1 };
const seat: Seat = { id: 'ania', name: 'Ania', lanes: ['mobile'], projects: ['p1'], pinned: true, plan: 'ultra', workMode: 'solo', autopilot: true };

describe('paths', () => {
  it('extracts the non-wildcard prefix', () => {
    expect(globPrefix('services/estimate/**')).toBe('services/estimate');
    expect(globPrefix('./apps/web/src/*.tsx')).toBe('apps/web/src');
    expect(globPrefix('**')).toBe('');
    expect(globPrefix('package.json')).toBe('package.json');
  });
  it('compares prefixes segment by segment', () => {
    expect(globsOverlap('a/b/**', 'a/b/c.ts')).toBe(true);
    expect(globsOverlap('a/b/**', 'a/**')).toBe(true);
    expect(globsOverlap('a/b/**', 'a/c/**')).toBe(false);
    expect(prefixesOverlap('a/bc', 'a/b')).toBe(false);
    expect(globsOverlap('**', 'anything/at/all')).toBe(true);
    expect(pathSetsOverlap(['x/**', 'y/z.ts'], ['y/**'])).toBe(true);
  });
  it('collapses lock prefixes to the widest ancestors', () => {
    expect(lockPrefixes(['a/b/**', 'a/**', 'c/d.ts'])).toEqual(['a', 'c/d.ts']);
  });
});

describe('tickets', () => {
  it('requires ready status, finished deps and free paths', () => {
    const a = t({ id: 'T1', status: 'done' });
    const b = t({ id: 'T2', deps: ['T1'] });
    const c = t({ id: 'T3', deps: ['T2'] });
    const all = [a, b, c];
    expect(readiness(b, all).ok).toBe(true);
    expect(readiness(c, all)).toMatchObject({ ok: false, code: 'not_ready' });
    const busy = t({ id: 'T4', status: 'in_progress', pathsOwned: ['services/**'], booking: { seatId: 'x', leaseExpiresAt: 1 } });
    expect(readiness(b, [...all, busy])).toMatchObject({ ok: false, code: 'path_conflict', conflictsWith: 'T4' });
    const otherRepo = { ...busy, repo: 'mobile-app' };
    expect(readiness(b, [...all, otherRepo]).ok).toBe(true);
  });

  it('orders candidates by lane match, wave, priority then id — never input order', () => {
    const list = [
      t({ id: 'T9', priority: 1, wave: 2 }),
      t({ id: 'T3', priority: 50, wave: 1, lanes: ['api'] }),
      t({ id: 'T2', priority: 50, wave: 1, lanes: ['mobile'] }),
      t({ id: 'T10', priority: 10, wave: 1, lanes: ['mobile'] }),
    ];
    expect(pickOrder(list, ['mobile']).map((x) => x.id)).toEqual(['T10', 'T2', 'T9', 'T3']);
    expect(pickOrder([...list].reverse(), ['mobile']).map((x) => x.id)).toEqual(['T10', 'T2', 'T9', 'T3']);
    expect(pickOrder(list, []).map((x) => x.id)).toEqual(['T10', 'T2', 'T3', 'T9']);
  });

  it('lists claimable tickets of a project only', () => {
    const all = [t({ id: 'T1' }), t({ id: 'T2', projectId: 'p2' }), t({ id: 'T3', status: 'planned' })];
    expect(claimable(all, 'p1', []).map((x) => x.id)).toEqual(['T1']);
  });

  it('finds dependents unblocked by a merge', () => {
    const all = [t({ id: 'T1', status: 'done' }), t({ id: 'T2', deps: ['T1'] }), t({ id: 'T3', deps: ['T1', 'T4'] }), t({ id: 'T4' })];
    expect(newlyReadyDependents('T1', all).map((x) => x.id)).toEqual(['T2']);
  });

  it('enforces state transitions', () => {
    expect(transition(t({ id: 'T1' }), 'book')).toBe('booked');
    expect(() => transition(t({ id: 'T1', status: 'done' }), 'book')).toThrow(/cannot book/);
    expect(transition(t({ id: 'T1', status: 'review' }), 'merged')).toBe('done');
    expect(() => transition(t({ id: 'T1', status: 'in_progress' }), 'merged')).toThrow();
  });

  it('enforces seat limits from the seat and the hub setting', () => {
    expect(() => assertSeatUnderLimit({ ...seat, maxConcurrentBookings: 2 }, settings, 2)).toThrow(/limit 2/);
    expect(() => assertSeatUnderLimit(seat, { ...settings, maxBookingsPerSeat: 1 }, 1)).toThrow(/limit 1/);
    expect(() => assertSeatUnderLimit(seat, settings, 99)).not.toThrow();
  });

  it('renders a ticket card and branch names', () => {
    const card = renderCard(t({ id: 'T7', acceptance: [{ criterion: 'unit green', cmd: 'npx nx run x:unit' }] }));
    expect(card).toContain('# T7');
    expect(card).toContain('`npx nx run x:unit`');
    expect(ticketBranch('offline-capture', 'T7', 'Create Quote!')).toBe('hack/offline-capture/T7-create-quote');
    expect(slugify('Ąśń Offline Capture')).toBe('asn-offline-capture');
  });
});

describe('plan validation', () => {
  const inp = (over: Partial<TicketInput>): TicketInput => ({
    repo: 'mono',
    title: 'x',
    description: '',
    type: 'slice',
    lanes: [],
    deps: [],
    pathsOwned: ['a/**'],
    acceptance: [{ criterion: 'ok' }],
    priority: 100,
    ...over,
  });
  const alloc = () => {
    let n = 100;
    return () => `T${++n}`;
  };

  it('maps local keys to new ids and resolves deps', () => {
    const r = validatePlan([inp({ id: 'c1', pathsOwned: ['libs/**'] }), inp({ id: 'c2', deps: ['c1'], pathsOwned: ['svc/**'] })], [], MONO, alloc());
    expect(r.errors).toEqual([]);
    expect(r.tickets.map((x) => [x.id, x.deps])).toEqual([
      ['T101', []],
      ['T102', ['T101']],
    ]);
  });

  it('reports cycles, unknown deps, unknown repos and duplicate keys', () => {
    const r = validatePlan(
      [inp({ id: 'a', deps: ['b'] }), inp({ id: 'b', deps: ['a'], pathsOwned: ['z/**'] }), inp({ id: 'c', deps: ['nope'], repo: 'x', pathsOwned: ['q/**'] })],
      [],
      MONO,
      alloc(),
    );
    expect(r.errors.join('\n')).toMatch(/cycle/);
    expect(r.errors.join('\n')).toMatch(/unknown dependency nope/);
    expect(r.errors.join('\n')).toMatch(/unknown repo "x"/);
  });

  it('reports duplicate keys', () => {
    const r = validatePlan([inp({ id: 'a' }), inp({ id: 'a', pathsOwned: ['w/**'] })], [], MONO, alloc());
    expect(r.errors.join('\n')).toMatch(/duplicate ticket key a/);
  });

  it('rejects same-wave overlaps without a dependency', () => {
    const r = validatePlan([inp({ id: 'a', wave: 1 }), inp({ id: 'b', wave: 1, pathsOwned: ['a/x/**'] })], [], MONO, alloc());
    expect(r.errors[0]).toMatch(/overlapping pathsOwned/);
    const ok = validatePlan([inp({ id: 'a', wave: 1 }), inp({ id: 'b', wave: 1, deps: ['a'], pathsOwned: ['a/x/**'] })], [], MONO, alloc());
    expect(ok.errors).toEqual([]);
  });

  it('updates existing tickets in place', () => {
    const r = validatePlan([inp({ id: 'T5', deps: [] })], [t({ id: 'T5' })], MONO, alloc());
    expect(r.tickets[0]).toMatchObject({ id: 'T5', isNew: false });
  });
});

describe('rules', () => {
  it('ships the D10-adjusted defaults', () => {
    const r = (c: string) => findRule(DEFAULT_RULES, c);
    expect(DEFAULT_RULES.map((x) => x.code)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'U1']);
    expect(r('B3')?.resolver).toBe('any_agent');
    expect(r('B4')).toMatchObject({ resolver: 'any_human', contestMin: 5 });
    expect(r('B5')).toMatchObject({ resolver: 'any_human', contestMin: 10 });
    expect(r('B6')?.resolver).toBe('any_human');
    expect(r('B7')).toMatchObject({ resolver: 'any_human', contestMin: 5 });
  });
  it('layers hub and project overrides', () => {
    const merged = mergeRules(
      [{ code: 'B3', patch: { maxAttempts: 1 }, version: 4 }],
      [{ code: 'B1', patch: { resolver: 'human_quorum' }, version: 5 }],
    );
    expect(findRule(merged, 'B3')).toMatchObject({ maxAttempts: 1, version: 4 });
    expect(findRule(merged, 'B1')).toMatchObject({ resolver: 'human_quorum', version: 5 });
    expect(findRule(merged, 'B2')?.version).toBe(1);
    expect(rulesDigest(merged, 5)).toContain('B1 Contract change');
  });
  it('accepts brand-new complete rules and ignores incomplete ones', () => {
    const merged = mergeRules(
      [
        { code: 'C1', patch: { name: 'n', trigger: 't', severity: 'P3', resolver: 'self', defaultOnTimeout: 'd', stopScope: 'none', notify: 'all' }, version: 2 },
        { code: 'C2', patch: { name: 'partial' }, version: 3 },
      ],
      [],
    );
    expect(findRule(merged, 'C1')).toBeDefined();
    expect(findRule(merged, 'C2')).toBeUndefined();
  });
});

describe('quorum', () => {
  const base: Decision = {
    id: 'D1',
    question: 'q',
    options: ['a', 'b'],
    context: '',
    electorate: 'affected_seats',
    eligible: ['s1', 's2', 's3'],
    rule: 'majority',
    quorum: 2,
    deadline: 1000,
    defaultOption: 'b',
    votes: [],
    status: 'open',
  };

  it('lets a human override their own seat\'s agent vote', () => {
    let d = castVote(base, 's1', 'agent', 'a', 'x', 1);
    d = castVote(d, 's1', 'human', 'b', 'no', 2);
    expect(effectiveVotes(d)).toEqual([expect.objectContaining({ seat: 's1', option: 'b', by: 'human' })]);
  });

  it('decides majority at the deadline and keeps the override window open before it', () => {
    let d = castVote(base, 's1', 'agent', 'a', '', 1);
    d = castVote(d, 's2', 'agent', 'a', '', 2);
    d = castVote(d, 's3', 'agent', 'b', '', 3);
    expect(settle(d, 500).status).toBe('open');
    expect(settle(d, 1000)).toMatchObject({ status: 'made', outcome: 'a' });
  });

  it('closes early once every eligible human has voted', () => {
    let d: Decision = { ...base, electorate: 'humans' };
    for (const s of ['s1', 's2', 's3']) d = castVote(d, s, 'human', 'a', '', 1);
    expect(settle(d, 10)).toMatchObject({ status: 'made', outcome: 'a' });
  });

  it('defaults without quorum, on ties and for failed unanimity', () => {
    expect(settle(castVote(base, 's1', 'agent', 'a', '', 1), 1000)).toMatchObject({ status: 'defaulted', outcome: 'b' });
    let tie = castVote({ ...base, eligible: ['s1', 's2'] }, 's1', 'agent', 'a', '', 1);
    tie = castVote(tie, 's2', 'agent', 'b', '', 1);
    expect(settle(tie, 1000).status).toBe('defaulted');
    let u: Decision = { ...base, rule: 'unanimous' };
    u = castVote(u, 's1', 'agent', 'a', '', 1);
    u = castVote(u, 's2', 'agent', 'b', '', 1);
    expect(settle(u, 1000).status).toBe('defaulted');
  });

  it('supports two-thirds and consent', () => {
    let d: Decision = { ...base, rule: 'two_thirds' };
    d = castVote(d, 's1', 'agent', 'a', '', 1);
    d = castVote(d, 's2', 'agent', 'a', '', 1);
    d = castVote(d, 's3', 'agent', 'b', '', 1);
    expect(tally(d)).toMatchObject({ passed: true, outcome: 'a' });
    const consent = { ...base, rule: 'consent' as const };
    expect(settle(consent, 1000)).toMatchObject({ status: 'made', outcome: 'a' });
    expect(settle(castVote(consent, 's2', 'agent', 'b', 'object', 1), 1000)).toMatchObject({ status: 'defaulted' });
  });

  it('rejects invalid votes', () => {
    expect(() => castVote(base, 's9', 'agent', 'a', '', 1)).toThrow(/not eligible/);
    expect(() => castVote(base, 's1', 'agent', 'zzz', '', 1)).toThrow(/option must be/);
    expect(() => castVote({ ...base, electorate: 'humans' }, 's1', 'agent', 'a', '', 1)).toThrow(/humans only/);
    expect(() => castVote(base, 's1', 'agent', 'a', '', 2000)).toThrow(/deadline/);
  });
});

describe('escalations and the open floor', () => {
  const rule = (c: string) => findRule(DEFAULT_RULES, c)!;
  const actor = { seatId: 'ania', kind: 'agent' as const };
  const human = { seatId: 'bob', kind: 'human' as const };
  const ticket = t({ id: 'T1', status: 'in_progress', booking: { seatId: 'ania', leaseExpiresAt: 0 } });

  it('opens an affected-seat vote for B1 and parks the ticket', () => {
    const dep = t({ id: 'T2', deps: ['T1'], status: 'booked', booking: { seatId: 'cyril', leaseExpiresAt: 0 } });
    const plan = planEscalation({
      kind: 'blocker', projectId: 'p1', ticket, rule: rule('B1'), rulesVersion: 3, summary: 'change DTO', detail: 'd',
      proposed: ['add field'], actor, allTickets: [ticket, dep], members: ['ania', 'cyril', 'dan'], humanSeats: ['ania', 'cyril', 'dan'], now: 0,
    });
    expect(plan.parkTicket).toBe(true);
    expect(plan.decision).toMatchObject({ electorate: 'affected_seats', eligible: ['ania', 'cyril'], quorum: 1 });
    expect(plan.decision?.options).toContain(rule('B1').defaultOnTimeout);
    expect(plan.escalation).toMatchObject({ status: 'open', ruleVersion: 3, deadline: 600_000 });
  });

  it('adds a neutral seat for B9', () => {
    expect(affectedSeats(ticket, [ticket], 'ania', ['ania', 'cyril', 'dan'], true)).toEqual(['ania', 'cyril', 'dan']);
  });

  it('resolves, then finalizes after the contest window', () => {
    const plan = planEscalation({
      kind: 'blocker', projectId: 'p1', ticket, rule: rule('B4'), rulesVersion: 1, summary: 's', detail: '', actor,
      allTickets: [ticket], members: [], humanSeats: ['bob'], now: 0,
    });
    const esc = { ...plan.escalation, id: 'E1' };
    expect(() => resolveByHuman(esc, rule('B4'), actor, 'x', 1, 5)).toThrow(/only a human/);
    const resolved = resolveByHuman(esc, rule('B4'), human, 'use option A', 1000, 5);
    expect(resolved.status).toBe('resolved_pending_contest');
    expect(resolved.resolution?.contestUntil).toBe(1000 + 5 * 60_000);
    expect(sweepEscalation(resolved, rule('B4'), 2000).kind).toBe('none');
    expect(sweepEscalation(resolved, rule('B4'), 1000 + 5 * 60_000)).toMatchObject({ kind: 'finalized', escalation: { status: 'resolved' } });
  });

  it('turns a contest into a human vote and applies uphold / overturn', () => {
    const esc = resolveByHuman({ ...planEscalation({
      kind: 'blocker', projectId: 'p1', ticket, rule: rule('B5'), rulesVersion: 1, summary: 's', detail: '', actor,
      allTickets: [ticket], members: [], humanSeats: ['bob', 'cyril'], now: 0,
    }).escalation, id: 'E2' }, rule('B5'), human, 'cut it', 0, 5);
    const { escalation, decision } = contest(esc, rule('B5'), { seatId: 'cyril', kind: 'human' }, 'we need it', ['bob', 'cyril'], 1);
    expect(escalation.status).toBe('contested');
    expect(decision).toMatchObject({ electorate: 'humans', options: ['uphold', 'overturn'], defaultOption: 'uphold' });
    const overturned = applyDecisionOutcome(escalation, { ...decision, id: 'D1', status: 'made', outcome: 'overturn' }, 5);
    expect(overturned).toMatchObject({ status: 'open', resolution: undefined });
    const upheld = applyDecisionOutcome(escalation, { ...decision, id: 'D1', status: 'defaulted', outcome: 'uphold' }, 5);
    expect(upheld.status).toBe('resolved');
    expect(() => contest(esc, rule('B5'), { seatId: 'cyril', kind: 'human' }, 'late', [], 10 * 60_000 + 1)).toThrow(/closed/);
  });

  it('hands any_agent escalations to humans at timeout and defaults the rest', () => {
    const b3 = { ...planEscalation({
      kind: 'help', projectId: 'p1', ticket, rule: rule('B3'), rulesVersion: 1, summary: 'sim broken', detail: '', actor,
      allTickets: [ticket], members: [], humanSeats: [], now: 0,
    }).escalation, id: 'E3' };
    expect(sweepEscalation(b3, rule('B3'), 10 * 60_000)).toMatchObject({ kind: 'to_humans', escalation: { status: 'open', deadline: undefined } });
    const b4 = { ...b3, ruleCode: 'B4', deadline: 100 };
    expect(sweepEscalation(b4, rule('B4'), 100)).toMatchObject({ kind: 'defaulted', escalation: { status: 'defaulted' } });
    expect(answerByAgent(b3, rule('B3'), actor, 'run xcode-select', 5).status).toBe('resolved');
    expect(() => answerByAgent(b4, rule('B4'), actor, 'x', 5)).toThrow(/cannot answer/);
  });
});

describe('envelopes', () => {
  it('truncates summaries, shrinks data and picks the stream and channel', () => {
    const e = envelope({ type: 'ticket.booked', from: 'ania', fromKind: 'agent', summary: 'x'.repeat(500), projectId: 'p1', data: { big: 'y'.repeat(5000) } });
    expect(e.summary.length).toBe(200);
    expect(e.stream).toBe('tasks');
    expect(Buffer.byteLength(JSON.stringify(e.data))).toBeLessThanOrEqual(MAX_DATA_BYTES);
    expect(channelFor({ projectId: 'p1' })).toBe('/h1/p/p1');
    expect(channelFor({ to: 'ania', projectId: 'p1' })).toBe('/h1/s/ania');
    expect(channelFor({ to: 'humans' })).toBe('/h1/all');
    expect(envelope({ type: 'goal.set', from: 'a', fromKind: 'human', summary: 's' }).stream).toBe('broadcast');
    expect(envelope({ type: 'message', from: 'a', fromKind: 'human', summary: 's' }).stream).toBe('dm');
  });
});

describe('secrets', () => {
  it('flags common credentials and high-entropy assignments', () => {
    const types = scanSecrets(
      [
        'AKIAIOSFODNN7EXAMPLE',
        'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'password = "Zx9!qL2#vB7@nM4$"',
        'h1a_' + 'A'.repeat(43),
      ].join('\n'),
    ).map((f) => f.type);
    expect(types).toEqual(expect.arrayContaining(['aws-access-key-id', 'github-token', 'anthropic-api-key', 'private-key-block', 'generic-password', 'h1-agent-token']));
  });
  it('ignores placeholders and low-entropy values', () => {
    expect(scanSecrets('API_KEY=${API_KEY}\npassword: xxxxxxxxxxxxxxx\ntoken = <your-token-here>\nRun xcode-select first.')).toEqual([]);
  });
});

describe('tokens', () => {
  it('generates and recognises agent tokens and join codes', () => {
    const tok = generateAgentToken();
    expect(tok).toMatch(/^h1a_[A-Za-z0-9_-]{43}$/);
    expect(isAgentToken(tok)).toBe(true);
    expect(isAgentToken('eyJhbGciOi...')).toBe(false);
    expect(generateJoinCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(hashSecret('p', tok)).toHaveLength(64);
    expect(hashSecret('p', tok)).not.toBe(hashSecret('q', tok));
    expect(stripBearer('Bearer abc')).toBe('abc');
    expect(stripBearer(undefined)).toBeUndefined();
  });
});

describe('repo metadata', () => {
  const repo = normalizeRepo(
    {
      name: 'platform',
      url: 'git@github.com:org/platform.git',
      hotPaths: ['package.json', 'nx.json', '**/project.json', '**/serverless*.yml', '.github/**'],
      contractPaths: ['libs/shared/**'],
      laneMap: [
        { glob: 'apps/mobile/**', lane: 'mobile' },
        { glob: 'services/**', lane: 'api' },
      ],
    },
    'offline-capture',
  );
  const inp = (over: Partial<TicketInput>): TicketInput => ({
    repo: 'platform',
    title: 'x',
    description: '',
    type: 'slice',
    lanes: [],
    deps: [],
    pathsOwned: ['apps/mobile/src/queue/**'],
    acceptance: [{ criterion: 'ok' }],
    priority: 100,
    ...over,
  });
  const alloc = () => {
    let n = 0;
    return () => `T${++n}`;
  };

  it('fills defaults for new and old records', () => {
    expect(repo).toMatchObject({ baseBranch: 'main', integrationBranch: 'hack/offline-capture', setup: [], verify: [], prLabels: [] });
    const old = normalizeProject({
      id: 'p', name: 'P', repos: [{ name: 'r', url: 'u', integrationBranch: 'hack/p' } as never], lanes: [], status: 'active', phase: 'plan', goalVersion: 0, createdBy: 'a', createdAt: 0,
    });
    expect(old.links).toEqual([]);
    expect(old.tags).toEqual([]);
    expect(old.repos[0]).toMatchObject({ baseBranch: 'main', hotPaths: [], contractPaths: [], laneMap: [] });
  });

  it('matches protected globs by prefix or by pattern', () => {
    expect(globMatches('services/x/serverless.yml', '**/serverless*.yml')).toBe(true);
    expect(globMatches('apps/mobile/project.json', '**/project.json')).toBe(true);
    expect(globMatches('apps/mobile/**', '**/project.json')).toBe(false);
    expect(ownsProtected('libs/shared/api/**', 'libs/shared/**')).toBe(true);
    expect(ownsProtected('libs/**', 'libs/shared/**')).toBe(true);
    expect(ownsProtected('apps/mobile/**', 'package.json')).toBe(false);
    expect(ownsProtected('**', 'package.json')).toBe(true);
  });

  it('rejects build tickets owning hot or contract paths and allows contract tickets', () => {
    expect(protectedPathErrors('T1', 'slice', ['libs/shared/note/**'], repo)[0]).toMatch(/contract path libs\/shared\/\*\*/);
    expect(protectedPathErrors('T1', 'slice', ['package.json'], repo)[0]).toMatch(/hot path package.json/);
    expect(protectedPathErrors('T1', 'contract', ['libs/shared/note/**', 'package.json'], repo)).toEqual([]);
    expect(protectedPathErrors('T1', 'glue', ['nx.json'], repo)).toEqual([]);
    const r = validatePlan([inp({ id: 'bad', pathsOwned: ['libs/shared/x/**'] }), inp({ id: 'ok', type: 'contract', pathsOwned: ['libs/shared/y/**'] })], [], [repo], alloc());
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^bad: owns libs\/shared\/x/);
  });

  it('fills empty lanes from the lane map', () => {
    expect(lanesFromMap(['apps/mobile/src/**', 'services/note/**'], repo)).toEqual(['mobile', 'api']);
    const r = validatePlan([inp({ id: 'a' }), inp({ id: 'b', lanes: ['web'], pathsOwned: ['services/x/**'] })], [], [repo], alloc());
    expect(r.tickets[0].input.lanes).toEqual(['mobile']);
    expect(r.tickets[1].input.lanes).toEqual(['web']);
  });

  it('adds the repo section to the ticket card', () => {
    const card = renderCard(t({ id: 'T9' }), normalizeRepo({ name: 'mono', url: 'git@x:mono.git', setup: ['npm ci'], verify: [{ name: 'typecheck', cmd: 'npm run type:check' }], notes: 'Never run builds' }, 'p1'));
    expect(card).toMatch(/## Repo mono/);
    expect(card).toMatch(/typecheck: `npm run type:check`/);
    expect(card).toMatch(/Never run builds/);
  });
});
