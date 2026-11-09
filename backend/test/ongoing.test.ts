import { beforeEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/app/hub';
import { Store } from '../src/adapters/store';
import { K } from '../src/adapters/keys';
import type { SkillFiles } from '../src/adapters/s3';
import type { Actor, ChangeRequest, DecisionRecord, Envelope, Input, Project, Ticket } from '../src/shared/types';
import { assignDodIds, diffSections, impactCandidates, parseSections, refCovers } from '../src/core/ongoing';
import { FakeDynamo } from './fake-dynamo';

const DAY = 86_400_000;

const setup = (mode: 'event' | 'ongoing' = 'ongoing') => {
  const db = new FakeDynamo();
  let clock = Date.parse('2026-11-20T09:00:00Z');
  const now = () => clock;
  const store = new Store('c1', { mode, dataTtlDays: 21, eventDays: 90 }, db.asClient(), now);
  const hub = new Hub({
    store,
    files: {} as SkillFiles,
    pepper: async () => 'pepper',
    runtime: async () => ({
      boardUrl: 'https://board.example',
      apiUrl: 'https://board.example/api/v1',
      userPoolId: 'pool',
      clientId: 'client',
      region: 'us-east-1',
      events: { httpHost: 'x', realtimeUrl: 'wss://x', namespace: 'c1' },
    }),
    mode,
    eventEndsAt: mode === 'event' ? Date.parse('2026-12-01T00:00:00Z') : undefined,
    tokenTtlDays: 30,
    now,
  });
  const events = async (): Promise<Envelope[]> => (await store.events(0, 1000)) as Envelope[];
  return { db, hub, store, events, advance: (ms: number) => (clock += ms), now };
};

const human = (seatId: string): Actor => ({ seatId, kind: 'human' });
const agent = (seatId: string): Actor => ({ seatId, kind: 'agent' });

const PRD_V1 = `# Customer notifications

Intro text.

## Status email {#status-email}
Email the customer whenever a job's status changes.

## Templates
Use the brand template.
`;

const PRD_V2 = `# Customer notifications

Intro text.

## Status email {#status-email}
Send one daily digest instead of an email per status change.

## Templates
Use the brand template.

## SMS
Text the customer when the technician is on the way.
`;

const ticket = (o: Partial<Record<string, unknown>> & { title: string; pathsOwned: string[] }) => ({
  repo: 'app',
  acceptance: [{ criterion: `${o.title} works` }],
  ...o,
});

const boot = async (env: ReturnType<typeof setup>) => {
  const { hub } = env;
  await hub.createSeatForHuman('s-l', 'l@x', { id: 'lukasz', name: 'Lukasz' });
  await hub.execute(human('lukasz'), 'repo.set', { name: 'app', url: 'git@github.com:acme/app.git', baseBranch: 'main', contractPaths: ['libs/contracts/**'] });
  await hub.execute(human('lukasz'), 'project.create', { name: 'Customer notifications', repoRefs: ['app'], epic: { targetDate: '2027-02-01' } });
  await hub.patchMe(agent('lukasz'), { pinProject: 'customer-notifications' });
  const { input } = await hub.ongoing.createInput(agent('lukasz'), { kind: 'prd', title: 'Notifications PRD', body: PRD_V1, projectIds: [] });
  await hub.execute(human('lukasz'), 'input.approve', { inputId: input.id });
  await hub.execute(human('lukasz'), 'goal.set', { projectId: 'customer-notifications', statement: 'Customers hear about their jobs', definitionOfDone: ['status emails go out', 'templates use the brand'] });
  const t = async (o: Parameters<typeof ticket>[0]) => (await hub.createTicket(human('lukasz'), 'customer-notifications', ticket(o))).id;
  const ids = {
    send: await t({ title: 'Send status email', pathsOwned: ['services/notify/send/**'], refs: ['input:I1#status-email', 'dod:d1'] }),
    render: await t({ title: 'Render template', pathsOwned: ['services/notify/render/**'], refs: ['input:I1#templates', 'dod:d2'] }),
    queue: await t({ title: 'Email queue', pathsOwned: ['services/notify/queue/**'], refs: ['input:I1#status-email'] }),
    retry: await t({ title: 'Retry failed emails', pathsOwned: ['services/notify/retry/**'], refs: ['input:I1#status-email'] }),
    prefs: await t({ title: 'Preferences page', pathsOwned: ['apps/web/prefs/**'], refs: ['input:I1'] }),
    unrelated: await t({ title: 'Docs', pathsOwned: ['docs/**'] }),
  };
  return { input: input.id, ...ids };
};

const merge = async (hub: Hub, id: string, files?: string[]) => {
  await hub.book(agent('lukasz'), id, {});
  await hub.setStatus(agent('lukasz'), id, { status: 'review', prUrl: `https://github.com/acme/app/pull/${id.slice(1)}` });
  await hub.createSeatForHuman(`s-r-${id}`, 'r@x', { id: `rev-${id.toLowerCase()}`, name: 'Reviewer' });
  await hub.reviewDone(human(`rev-${id.toLowerCase()}`), id, { outcome: 'merged', mergeSha: 'abc1234', ...(files ? { files } : {}) });
};

const get = async (hub: Hub, id: string): Promise<Ticket> => (await hub.requireTicket(id)).value;

describe('ongoing core', () => {
  it('keeps definition-of-done ids stable when the list changes', () => {
    const v1 = assignDodIds(undefined, ['a', 'b', 'c']);
    expect(v1.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    const v2 = assignDodIds(v1, ['c', 'new', 'a']);
    expect(v2).toEqual([{ id: 'd3', text: 'c' }, { id: 'd4', text: 'new' }, { id: 'd1', text: 'a' }]);
    expect(assignDodIds(v2, [{ id: 'd4', text: 'new, reworded' }])).toEqual([{ id: 'd4', text: 'new, reworded' }]);
  });

  it('splits inputs into anchored sections and diffs them', () => {
    const a = parseSections(PRD_V1);
    expect(a.map((s) => s.anchor)).toEqual(['customer-notifications', 'status-email', 'templates']);
    const d = diffSections(a, parseSections(PRD_V2));
    expect(d).toMatchObject({ changed: ['status-email'], added: ['sms'], removed: [] });
    expect(parseSections('```\n# not a heading\n```\n# A\n# A').map((s) => s.anchor)).toEqual(['intro', 'a', 'a-2']);
  });

  it('matches refs: a whole-input ref covers its sections', () => {
    expect(refCovers('input:I1', 'input:I1#x')).toBe(true);
    expect(refCovers('input:I1#x', 'input:I1#y')).toBe(false);
    expect(refCovers('decision:R1', 'decision:R1')).toBe(true);
  });

  it('finds impacted tickets by refs, paths and dependencies', () => {
    const base = { projectId: 'p', repo: 'app', description: '', type: 'slice', lanes: [], acceptance: [], priority: 1, attempts: 0, createdBy: 'x', createdByAgent: false, log: [], updatedAt: 0, version: 1 } as const;
    const tickets = [
      { ...base, id: 'T1', title: 'a', deps: [], pathsOwned: ['a/**'], status: 'done', refs: ['input:I1#x'] },
      { ...base, id: 'T2', title: 'b', deps: ['T1'], pathsOwned: ['b/**'], status: 'ready' },
      { ...base, id: 'T3', title: 'c', deps: [], pathsOwned: ['c/**'], pathsRead: ['libs/contracts/x.ts'], status: 'planned' },
      { ...base, id: 'T4', title: 'd', deps: [], pathsOwned: ['d/**'], status: 'dropped', refs: ['input:I1#x'] },
    ] as unknown as Ticket[];
    const hit = impactCandidates(tickets, { changedRefs: ['input:I1#x'], paths: { repo: 'app', globs: ['libs/contracts/**'] } });
    expect(hit.map((h) => [h.ticketId, h.why[0]])).toEqual([
      ['T1', 'cites input:I1#x (changed: input:I1#x)'],
      ['T2', 'depends on T1'],
      ['T3', 'uses contract path libs/contracts/**'],
    ]);
  });
});

describe('ongoing hub', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it('keeps work records forever and expires traffic-like records', async () => {
    const { hub, db } = env;
    await boot(env);
    const project = db.items.get('PROJECT#customer-notifications|META');
    const ticketItem = db.items.get('TICKET#T1|META');
    const event = [...db.items.values()].find((i) => i.PK === 'EVENT');
    expect(project?.ttl).toBeUndefined();
    expect(ticketItem?.ttl).toBeUndefined();
    expect(typeof event?.ttl).toBe('number');
    const eventMode = setup('event');
    await eventMode.hub.createSeatForHuman('s', 'a@x', { id: 'ania', name: 'Ania' });
    expect(typeof eventMode.db.items.get('SEAT#ania|META')?.ttl).toBe('number');
    expect(hub.mode).toBe('ongoing');
  });

  it('switching a store to ongoing retention clears the TTL of work records', async () => {
    const db = new FakeDynamo();
    const now = () => Date.parse('2026-11-20T09:00:00Z');
    await new Store('c1', 21, db.asClient(), now).commit([new Store('c1', 21, db.asClient(), now).putNew(K.seat('x'), { id: 'x' })], [{ stream: 'tasks', type: 't', from: 'x', fromKind: 'human', summary: 's' }]);
    expect(db.items.get('SEAT#x|META')?.ttl).toBeDefined();
    const stats = await new Store('c1', { mode: 'ongoing', dataTtlDays: 21, eventDays: 90 }, db.asClient(), now).applyRetention();
    expect(stats.kept).toBeGreaterThan(0);
    expect(db.items.get('SEAT#x|META')?.ttl).toBeUndefined();
  });

  it('gives tokens a lifetime and rotates them with a short grace period', async () => {
    const { hub, advance } = env;
    await hub.createSeatForHuman('s-l', 'l@x', { id: 'lukasz', name: 'Lukasz' });
    const { code } = await hub.createJoinCode(human('lukasz'));
    const joined = await hub.join({ code, machine: 'mbp' });
    expect(joined.expiresAt).toBe(env.now() + 30 * DAY);
    const rotated = await hub.rotateToken(agent('lukasz'), { token: joined.token });
    await expect(hub.authenticateAgentToken(rotated.token)).resolves.toMatchObject({ seatId: 'lukasz' });
    await expect(hub.authenticateAgentToken(joined.token as string)).resolves.toMatchObject({ seatId: 'lukasz' });
    advance(11 * 60_000);
    await expect(hub.authenticateAgentToken(joined.token as string)).resolves.toBeUndefined();
    await hub.createSeatForHuman('s-o', 'o@x', { id: 'other', name: 'Other' });
    await expect(hub.rotateToken(agent('other'), { token: rotated.token })).rejects.toThrow(/belong to your seat/);
  });

  it('creates epics from the repo catalog and starts them on the first booking', async () => {
    const { hub } = env;
    const ids = await boot(env);
    const p = (await hub.requireProject('customer-notifications')).value;
    expect(p.repos[0]).toMatchObject({ name: 'app', fromCatalog: true, integrationBranch: 'main' });
    expect(p.epic).toMatchObject({ state: 'planned', owners: ['lukasz'], targetDate: '2027-02-01' });
    const { booked } = await hub.next(agent('lukasz'), {});
    expect(booked[0].branch).toMatch(/^c1\/customer-notifications\//);
    expect((await hub.requireProject('customer-notifications')).value.epic?.state).toBe('in_progress');
    await hub.execute(human('lukasz'), 'epic.update', { projectId: 'customer-notifications', state: 'paused' });
    await expect(hub.book(agent('lukasz'), ids.render, {})).rejects.toThrow(/is paused/);
    await expect(hub.execute(human('lukasz'), 'epic.update', { projectId: 'customer-notifications', targetDate: '2027-03-01' })).rejects.toThrow(/needs a reason/);
    await hub.execute(human('lukasz'), 'epic.update', { projectId: 'customer-notifications', targetDate: '2027-03-01', reason: 'Sales event moved' });
    const recs = await hub.ongoing.listRecords('customer-notifications');
    expect(recs.find((r) => r.source === 'dates')).toMatchObject({ choice: expect.stringContaining('2027-02-01 to 2027-03-01') });
  });

  it('validates refs and puts the cited text in the ticket brief', async () => {
    const { hub } = env;
    const ids = await boot(env);
    await expect(hub.createTicket(human('lukasz'), 'customer-notifications', ticket({ title: 'x', pathsOwned: ['x/**'], refs: ['input:I1#nope'] }))).rejects.toThrow(/no section #nope/);
    await expect(hub.createTicket(human('lukasz'), 'customer-notifications', ticket({ title: 'x', pathsOwned: ['x/**'], refs: ['dod:d9'] }))).rejects.toThrow(/no item d9/);
    const view = await hub.ticketView(ids.send);
    expect(view.card).toContain('## Why');
    expect(view.card).toContain("Email the customer whenever a job's status changes.");
    expect(view.card).toContain('dod:d1: status emails go out');
  });

  it('a changed PRD opens a change request; suspect tickets cannot be booked or merged', async () => {
    const { hub } = env;
    const ids = await boot(env);
    await merge(hub, ids.send, ['services/notify/send/index.ts']);
    await hub.book(agent('lukasz'), ids.retry, {});
    await hub.setStatus(agent('lukasz'), ids.retry, { status: 'review' });
    await hub.ongoing.addVersion(agent('lukasz'), ids.input === 'I1' ? 'I1' : ids.input, { body: PRD_V2, note: 'digest' });
    const approved = (await hub.execute(human('lukasz'), 'input.approve', { inputId: 'I1' })) as { changes: string[] };
    expect(approved.changes).toEqual(['CR1']);
    const cr = (await hub.ongoing.requireChange('CR1')).value;
    expect(cr.impact.map((e) => e.ticketId).sort()).toEqual([ids.send, ids.queue, ids.retry, ids.prefs].sort());
    expect(cr.addedRefs).toEqual(['input:I1#sms']);
    expect((await get(hub, ids.queue)).suspectBy).toEqual(['CR1']);
    expect((await get(hub, ids.send)).suspectBy).toBeUndefined();
    expect((await get(hub, ids.render)).suspectBy).toBeUndefined();
    await expect(hub.book(agent('lukasz'), ids.queue, {})).rejects.toThrow(/suspect/);
    await hub.createSeatForHuman('s-r2', 'r@x', { id: 'rev2', name: 'Rev' });
    await expect(hub.reviewDone(human('rev2'), ids.retry, { outcome: 'merged' })).rejects.toThrow(/suspect under CR1/);
    const view = await hub.ongoing.changeView('CR1');
    expect((view.diffs as { ref: string; after: string }[]).find((d) => d.ref === 'input:I1#status-email')?.after).toContain('daily digest');
  });

  it('applies verdicts: amend, supersede, obsolete, defer and one rework ticket for merged code', async () => {
    const { hub, events } = env;
    const ids = await boot(env);
    await merge(hub, ids.send, ['services/notify/send/index.ts', 'services/notify/send/mail.ts']);
    await hub.ongoing.addVersion(agent('lukasz'), 'I1', { body: PRD_V2 });
    await hub.execute(human('lukasz'), 'input.approve', { inputId: 'I1' });
    await expect(hub.execute(human('lukasz'), 'change.approve', { changeId: 'CR1' })).rejects.toThrow(/needs a verdict/);
    await expect(hub.ongoing.assess(agent('lukasz'), 'CR1', { impact: [{ ticketId: ids.send, verdict: 'amend', amend: { title: 'x' } }] })).rejects.toThrow(/is done/);
    const assessed = await hub.ongoing.assess(agent('lukasz'), 'CR1', {
      impact: [
        { ticketId: ids.send, verdict: 'rework', group: 'digest', acceptance: [{ criterion: 'one digest per day per customer' }] },
        { ticketId: ids.queue, verdict: 'supersede' },
        { ticketId: ids.retry, verdict: 'obsolete', note: 'digest retries as a whole' },
        { ticketId: ids.prefs, verdict: 'amend', amend: { description: 'Customers pick digest time', refs: ['input:I1#sms', 'input:I1#status-email'] } },
      ],
      newTickets: [{ key: 'digest', repo: 'app', title: 'Daily digest job', pathsOwned: ['services/notify/digest/**'], acceptance: [{ criterion: 'digest sent' }], supersedes: [ids.queue], refs: ['input:I1#status-email'] }],
      scope: { definitionOfDone: [{ id: 'd1', text: 'one daily digest goes out' }, 'templates use the brand'] },
    });
    expect(assessed.status).toBe('proposed');
    const done = (await hub.execute(human('lukasz'), 'change.approve', { changeId: 'CR1' })) as ChangeRequest;
    expect(done.status).toBe('applied');
    expect(done.appliedScopeVersion).toBe(2);
    const digest = await get(hub, done.created?.digest as string);
    expect(digest).toMatchObject({ status: 'ready', supersedes: [ids.queue], scopeVersion: 2 });
    expect(await get(hub, ids.queue)).toMatchObject({ status: 'dropped', supersededBy: [digest.id] });
    expect(await get(hub, ids.retry)).toMatchObject({ status: 'dropped', dropReason: 'obsolete after CR1' });
    const prefs = await get(hub, ids.prefs);
    expect(prefs).toMatchObject({ description: 'Customers pick digest time', scopeVersion: 2 });
    expect(prefs.suspectBy).toBeUndefined();
    const send = await get(hub, ids.send);
    expect(send.status).toBe('done');
    const rework = await get(hub, done.created?.['rework:digest'] as string);
    expect(rework).toMatchObject({ type: 'rework', reworks: [ids.send], pathsOwned: ['services/notify/send/index.ts', 'services/notify/send/mail.ts'], acceptance: [{ criterion: 'one digest per day per customer' }] });
    expect(rework.description).toContain('merged as abc1234');
    expect(rework.description).toContain(`${ids.send}: Send status email works`);
    const goal = await hub.goal('customer-notifications');
    expect(goal?.dod).toEqual([{ id: 'd1', text: 'one daily digest goes out' }, { id: 'd2', text: 'templates use the brand' }]);
    const recs = (await hub.ongoing.listRecords()) as DecisionRecord[];
    expect(recs.find((r) => r.source === 'change')?.sourceId).toBe('CR1');
    expect((await events()).map((e) => e.type)).toEqual(expect.arrayContaining(['change.opened', 'change.assessed', 'change.approved', 'epic.scope_changed', 'change.applied']));
    const again = await hub.ongoing.apply('CR1');
    expect(again.status).toBe('applied');
  });

  it('a stale change request must be rebased; verdicts on untouched tickets carry over', async () => {
    const { hub } = env;
    const ids = await boot(env);
    const a = await hub.ongoing.openChange(human('lukasz'), { projectId: 'customer-notifications', title: 'Drop retries', reason: 'r', ticketIds: [ids.retry] });
    const b = await hub.ongoing.openChange(human('lukasz'), { projectId: 'customer-notifications', title: 'Defer prefs', reason: 'r', ticketIds: [ids.prefs, ids.unrelated] });
    await hub.ongoing.assess(agent('lukasz'), a.id, { impact: [{ ticketId: ids.retry, verdict: 'obsolete' }] });
    await hub.ongoing.assess(agent('lukasz'), b.id, { impact: [{ ticketId: ids.prefs, verdict: 'defer' }, { ticketId: ids.unrelated, verdict: 'keep' }] });
    await hub.execute(human('lukasz'), 'change.approve', { changeId: a.id });
    await expect(hub.execute(human('lukasz'), 'change.approve', { changeId: b.id })).rejects.toThrow(/rebase it/);
    const rebased = await hub.ongoing.rebase(agent('lukasz'), b.id);
    expect(rebased).toMatchObject({ status: 'proposed', baseScopeVersion: a.baseScopeVersion + 1 });
    await hub.execute(human('lukasz'), 'change.approve', { changeId: b.id });
    expect(await get(hub, ids.prefs)).toMatchObject({ deferred: true });
    await expect(hub.book(agent('lukasz'), ids.prefs, {})).rejects.toThrow(/deferred/);
  });

  it('rejecting a change request clears the suspect flags', async () => {
    const { hub } = env;
    const ids = await boot(env);
    const cr = await hub.ongoing.openChange(agent('lukasz'), { projectId: 'customer-notifications', title: 'Maybe', reason: 'r', changedRefs: ['dod:d2'] });
    expect((await get(hub, ids.render)).suspectBy).toEqual([cr.id]);
    await hub.execute(human('lukasz'), 'change.reject', { changeId: cr.id, reason: 'not now' });
    expect((await get(hub, ids.render)).suspectBy).toBeUndefined();
    await hub.book(agent('lukasz'), ids.render, {});
  });

  it('a superseded decision and a contract change from another epic open change requests', async () => {
    const { hub } = env;
    const ids = await boot(env);
    const { record } = (await hub.execute(human('lukasz'), 'decision.record', { projectId: 'customer-notifications', title: 'Mail provider', choice: 'Use SES', replan: false })) as { record: DecisionRecord };
    await hub.createTicket(human('lukasz'), 'customer-notifications', ticket({ title: 'SES client', pathsOwned: ['services/notify/ses/**'], refs: [`decision:${record.id}`], pathsRead: ['libs/contracts/job.ts'] }));
    const sup = (await hub.execute(human('lukasz'), 'decision.record', { projectId: 'customer-notifications', title: 'Mail provider', choice: 'Use Postmark', supersedes: record.id, replan: false })) as { changes: string[] };
    expect(sup.changes).toHaveLength(1);
    await hub.execute(human('lukasz'), 'project.create', { name: 'Job events', repoRefs: ['app'] });
    const contract = (await hub.execute(human('lukasz'), 'decision.record', { projectId: 'job-events', title: 'Job status event v2', choice: 'Add a reason field', repo: 'app', contractPaths: ['libs/contracts/**'], replan: false })) as { changes: string[] };
    expect(contract.changes).toHaveLength(1);
    const cr = (await hub.ongoing.requireChange(contract.changes[0])).value;
    expect(cr).toMatchObject({ projectId: 'customer-notifications', trigger: { kind: 'contract' } });
    expect(cr.impact.map((e) => e.why[0])).toContain('uses contract path libs/contracts/**');
    expect(ids.unrelated).toBeDefined();
  });

  it('changing the definition of done opens a change request for tickets citing changed items', async () => {
    const { hub } = env;
    const ids = await boot(env);
    await hub.execute(human('lukasz'), 'goal.set', { projectId: 'customer-notifications', statement: 'x', definitionOfDone: ['status emails go out', 'templates follow the new brand'] });
    const [cr] = await hub.ongoing.listChanges('customer-notifications');
    expect(cr.changedRefs).toEqual(['dod:d2']);
    expect(cr.impact.map((e) => e.ticketId)).toEqual([ids.render]);
  });

  it('resuming a paused epic revalidates refs that changed during the pause', async () => {
    const { hub, advance } = env;
    await boot(env);
    await hub.execute(human('lukasz'), 'epic.update', { projectId: 'customer-notifications', state: 'paused' });
    advance(DAY);
    await hub.ongoing.addVersion(agent('lukasz'), 'I1', { body: PRD_V2 });
    const all = (await hub.execute(human('lukasz'), 'input.approve', { inputId: 'I1' })) as { changes: string[] };
    await hub.execute(human('lukasz'), 'change.reject', { changeId: all.changes[0] });
    await hub.execute(human('lukasz'), 'epic.update', { projectId: 'customer-notifications', state: 'in_progress' });
    const changes = await hub.ongoing.listChanges('customer-notifications', 'open');
    expect(changes.map((c) => c.trigger.kind)).toEqual(['resume']);
  });

  it('follows several epics and exports everything', async () => {
    const { hub } = env;
    await boot(env);
    await hub.execute(human('lukasz'), 'project.create', { name: 'Billing', repoRefs: ['app'], epic: { priority: 1 } });
    await hub.createTicket(human('lukasz'), 'billing', ticket({ title: 'Invoices', pathsOwned: ['services/billing/**'] }));
    await hub.patchMe(agent('lukasz'), { follow: ['billing'] });
    const { booked } = await hub.next(agent('lukasz'), {});
    expect(booked[0].projectId).toBe('billing');
    const out = await hub.ongoing.exportAll();
    expect((out.epics as { project: Project }[]).map((e) => e.project.id).sort()).toEqual(['billing', 'customer-notifications']);
    expect((out.inputs as (Input & { versions: unknown[] })[])[0].versions).toHaveLength(1);
    const board = await hub.board('customer-notifications');
    expect(board.mode).toBe('ongoing');
    expect((board.roadmap as { projectId: string }[]).length).toBe(2);
  });

  it('agent-native: ingesting a PRD opens a re-plan that any agent picks up, assesses and approves', async () => {
    const { hub } = env;
    await hub.createSeatForHuman('s-l', 'l@x', { id: 'lukasz', name: 'Lukasz' });
    await hub.execute(human('lukasz'), 'repo.set', { name: 'app', url: 'git@github.com:acme/app.git' });
    const created = (await hub.propose(agent('lukasz'), { action: 'project.create', payload: { name: 'Customer notifications', repoRefs: ['app'] } })) as { executed: boolean };
    expect(created.executed).toBe(true);
    await hub.patchMe(agent('lukasz'), { pinProject: 'customer-notifications' });
    await hub.ongoing.createInput(agent('lukasz'), { kind: 'prd', title: 'Notifications PRD', body: PRD_V1, projectIds: ['customer-notifications'] });
    const approved = (await hub.propose(agent('lukasz'), { action: 'input.approve', payload: { inputId: 'I1' } })) as { executed: boolean; result: { changes: string[] } };
    expect(approved.executed).toBe(true);
    const [crId] = approved.result.changes;
    const cr = (await hub.ongoing.requireChange(crId)).value;
    expect(cr).toMatchObject({ status: 'assessing', trigger: { kind: 'ingest', ref: 'I1' }, impact: [] });
    const { booked } = await hub.next(agent('lukasz'), {});
    expect(booked[0]).toMatchObject({ id: cr.replanTicket, type: 'replan', forChange: crId });
    const assessed = await hub.ongoing.assess(agent('lukasz'), crId, {
      impact: [],
      newTickets: [{ key: 'send', repo: 'app', title: 'Send status email', pathsOwned: ['services/notify/**'], acceptance: [{ criterion: 'sent' }], refs: ['input:I1#status-email'] }],
      summary: 'First plan from the PRD: one ticket for status emails.',
    });
    expect(assessed).toMatchObject({ status: 'proposed', needsHuman: [] });
    expect(await get(hub, cr.replanTicket as string)).toMatchObject({ status: 'done' });
    const approvedByAgent = (await hub.propose(agent('lukasz'), { action: 'change.approve', payload: { changeId: crId } })) as { executed: boolean; result: ChangeRequest };
    expect(approvedByAgent).toMatchObject({ executed: true, result: { status: 'approved', decidedByKind: 'agent' } });
    await hub.sweep();
    expect((await hub.ongoing.requireChange(crId)).value.status).toBe('approved');
    env.advance(6 * 60_000);
    await hub.sweep();
    const applied = { result: (await hub.ongoing.requireChange(crId)).value };
    expect(applied.result.status).toBe('applied');
    const send = await get(hub, applied.result.created?.send as string);
    expect(send.refs).toEqual(['input:I1#status-email']);
    const log = await hub.ongoing.changelog('customer-notifications');
    expect(log.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['change.opened', 'change.applied', 'decision', 'scope']));
    expect(log.entries.find((e) => e.kind === 'change.applied')?.text).toContain('First plan from the PRD');
  });

  it('agent-native: a change that reworks merged code waits for a human', async () => {
    const { hub } = env;
    const ids = await boot(env);
    await merge(hub, ids.send);
    const cr = await hub.ongoing.openChange(agent('lukasz'), { projectId: 'customer-notifications', title: 'Digest', reason: 'r', changedRefs: ['input:I1#status-email'] });
    await hub.ongoing.assess(agent('lukasz'), cr.id, {
      impact: cr.impact.map((e) => ({ ticketId: e.ticketId, verdict: e.ticketId === ids.send ? 'rework' : 'keep' })),
      summary: 'Per-change emails become a digest.',
    });
    const r = (await hub.propose(agent('lukasz'), { action: 'change.approve', payload: { changeId: cr.id } })) as { executed: boolean; needsHuman: string[] };
    expect(r.executed).toBe(false);
    expect(r.needsHuman[0]).toMatch(/reworks merged code/);
    await expect(hub.propose(agent('lukasz'), { action: 'repo.set', payload: { name: 'x', url: 'u' } })).resolves.toMatchObject({ executed: false });
    await expect(hub.propose(agent('lukasz'), { action: 'epic.update', payload: { projectId: 'customer-notifications', targetDate: '2027-05-01', reason: 'x' } })).resolves.toMatchObject({ executed: false, needsHuman: ['moves the target date'] });
  });

  it('a human can stop an agent-approved change during its contest window, and ingests fold into one re-plan', async () => {
    const { hub } = env;
    await boot(env);
    const a = (await hub.propose(agent('lukasz'), { action: 'decision.record', payload: { projectId: 'customer-notifications', title: 'Channel', choice: 'Email only' } })) as { result: { changes: string[] } };
    const b = (await hub.propose(agent('lukasz'), { action: 'decision.record', payload: { projectId: 'customer-notifications', title: 'Tone', choice: 'Friendly' } })) as { result: { changes: string[] } };
    expect(b.result.changes).toEqual(a.result.changes);
    const cr = (await hub.ongoing.requireChange(a.result.changes[0])).value;
    expect(cr.addedRefs).toEqual(['decision:R1', 'decision:R2']);
    await hub.ongoing.assess(agent('lukasz'), cr.id, { impact: [], summary: 'Nothing to change.' });
    await hub.propose(agent('lukasz'), { action: 'change.approve', payload: { changeId: cr.id } });
    await expect(hub.execute(agent('lukasz'), 'change.reject', { changeId: cr.id })).rejects.toThrow(/only a human/);
    await hub.execute(human('lukasz'), 'change.reject', { changeId: cr.id, reason: 'wait for legal' });
    env.advance(10 * 60_000);
    await hub.sweep();
    expect((await hub.ongoing.requireChange(cr.id)).value.status).toBe('rejected');
  });

  it('a solo user may review and merge their own agents\' work in ongoing mode', async () => {
    const { hub } = env;
    const ids = await boot(env);
    await hub.book(agent('lukasz'), ids.render, {});
    await hub.setStatus(agent('lukasz'), ids.render, { status: 'review' });
    await hub.reviewBook(agent('lukasz'), ids.render, { workerId: 'reviewer' });
    expect(await hub.reviewDone(human('lukasz'), ids.render, { outcome: 'merged' })).toMatchObject({ status: 'done' });
  });

  it('agents must cite refs on build tickets in ongoing mode', async () => {
    const { hub } = env;
    await boot(env);
    await expect(hub.createTicket(agent('lukasz'), 'customer-notifications', ticket({ title: 'x', pathsOwned: ['x/**'] }))).rejects.toThrow(/cite what this ticket implements/);
    await hub.createTicket(agent('lukasz'), 'customer-notifications', ticket({ title: 'x', type: 'chore', pathsOwned: ['x/**'] }));
  });

  it('ingesting a business decision for an epic opens a re-plan', async () => {
    const { hub } = env;
    await boot(env);
    const r = (await hub.propose(agent('lukasz'), { action: 'decision.record', payload: { projectId: 'customer-notifications', title: 'Channel', choice: 'Customers can opt out of email' } })) as { result: { changes: string[] } };
    const cr = (await hub.ongoing.requireChange(r.result.changes[0])).value;
    expect(cr).toMatchObject({ trigger: { kind: 'decision' }, status: 'assessing', addedRefs: ['decision:R1'] });
    expect(cr.replanTicket).toBeDefined();
    await hub.execute(agent('lukasz'), 'change.reject', { changeId: cr.id, reason: 'already covered' });
    expect(await get(hub, cr.replanTicket as string)).toMatchObject({ status: 'dropped' });
  });

  it('refuses ongoing-only actions on an event hub', async () => {
    const ev = setup('event');
    await expect(ev.hub.ongoing.createInput(agent('x'), { kind: 'prd', title: 't', body: 'b' })).rejects.toThrow(/ongoing mode/);
  });
});
