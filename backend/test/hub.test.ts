import { beforeEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/app/hub';
import { Store } from '../src/adapters/store';
import { K } from '../src/adapters/keys';
import type { SkillFiles } from '../src/adapters/s3';
import type { Actor, Envelope, Ticket } from '../src/shared/types';
import { DomainError } from '../src/core/errors';
import { dispatch, match } from '../src/handlers/api';
import { FakeDynamo } from './fake-dynamo';

const MIN = 60_000;

const setup = () => {
  const db = new FakeDynamo();
  let clock = Date.parse('2026-11-20T09:00:00Z');
  const now = () => clock;
  const store = new Store('h1', 21, db.asClient(), now);
  const uploads = new Map<string, number>();
  const files = {
    uploadUrl: async (k: string) => `https://s3.example/${k}?put`,
    downloadUrl: async (k: string) => `https://s3.example/${k}?get`,
    inspect: async (k: string) => ({ exists: uploads.has(k), bytes: uploads.get(k) ?? 0 }),
    remove: async (k: string) => void uploads.delete(k),
  } as unknown as SkillFiles;
  const hub = new Hub({
    store,
    files,
    pepper: async () => 'pepper',
    runtime: async () => ({
      boardUrl: 'https://board.example',
      apiUrl: 'https://board.example/api/v1',
      userPoolId: 'pool',
      clientId: 'client',
      region: 'us-east-1',
      events: { httpHost: 'x.appsync-api.us-east-1.amazonaws.com', realtimeUrl: 'wss://x/event/realtime', namespace: 'h1' },
    }),
    eventEndsAt: Date.parse('2026-12-01T00:00:00Z'),
    now,
  });
  const events = async (): Promise<Envelope[]> => (await store.events(0, 500)) as Envelope[];
  return { db, hub, store, uploads, events, advance: (ms: number) => (clock += ms), now };
};

const human = (seatId: string): Actor => ({ seatId, kind: 'human' });
const agent = (seatId: string, workerId?: string): Actor => ({ seatId, kind: 'agent', workerId });

const bootstrap = async (env: ReturnType<typeof setup>) => {
  const { hub } = env;
  for (const [id, sub] of [['ania', 's-a'], ['bob', 's-b'], ['cyril', 's-c']]) await hub.createSeatForHuman(sub, `${id}@x`, { id, name: id, plan: 'ultra', lanes: [] });
  await hub.execute(human('ania'), 'project.create', { name: 'Offline Capture', repos: [{ name: 'mono', url: 'git@x:mono.git', integrationBranch: 'hack/offline-capture' }], lanes: ['api', 'mobile'] });
  for (const s of ['ania', 'bob', 'cyril']) await hub.patchMe(agent(s), { pinProject: 'offline-capture' });
  await hub.execute(human('ania'), 'goal.set', { projectId: 'offline-capture', statement: 'Capture notes offline', definitionOfDone: ['sync works'] });
  const plan = await hub.execute(human('ania'), 'plan.load', {
    projectId: 'offline-capture',
    tickets: [
      { id: 'contracts', repo: 'mono', title: 'Contracts', pathsOwned: ['libs/shared/**'], acceptance: [{ criterion: 'types compile', cmd: 'npm run type:check' }], priority: 1, wave: 0, lanes: ['api'] },
      { id: 'api', repo: 'mono', title: 'Sync endpoint', pathsOwned: ['services/sync/**'], deps: ['contracts'], acceptance: [{ criterion: 'unit green' }], wave: 1, lanes: ['api'] },
      { id: 'mobile', repo: 'mono', title: 'Offline queue', pathsOwned: ['apps/mobile/**'], deps: ['contracts'], acceptance: [{ criterion: 'e2e green' }], wave: 1, lanes: ['mobile'] },
    ],
  });
  return plan as { created: string[] };
};

describe('hub flows', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it('joins a Mac with a single-use join code and authenticates its token', async () => {
    const { hub } = env;
    await hub.createSeatForHuman('sub-1', 'a@x', { id: 'ania', name: 'Ania' });
    await expect(hub.createJoinCode(agent('ania'))).rejects.toThrow(/needs a human/);
    const { code } = await hub.createJoinCode(human('ania'));
    const joined = await hub.join({ code, machine: 'mbp' });
    expect(joined).toMatchObject({ seatId: 'ania', apiUrl: 'https://board.example/api/v1' });
    const token = joined.token as string;
    await expect(hub.authenticateAgentToken(token)).resolves.toMatchObject({ seatId: 'ania' });
    await expect(hub.join({ code, machine: 'mbp' })).rejects.toThrow(/invalid, used or expired/);
    const [t] = await hub.listTokens(human('ania'));
    expect(t).not.toHaveProperty('hash');
    await hub.revokeToken(human('ania'), t.tokenId);
    await expect(hub.authenticateAgentToken(token)).resolves.toBeUndefined();
    expect(await hub.seatForSub('sub-1')).toBe('ania');
  });

  it('hides direct messages addressed to other seats from event catch-up', async () => {
    const { hub } = env;
    for (const [id, sub] of [['ania', 's-a'], ['bob', 's-b'], ['cyril', 's-c']]) await hub.createSeatForHuman(sub, `${id}@x`, { id, name: id, plan: 'ultra', lanes: [] });
    await hub.message(agent('ania'), { to: 'bob', text: 'private hello' });
    await hub.message(agent('ania'), { to: 'all', text: 'hello everyone' });
    const asBob = (await hub.events(agent('bob'), 0, 500)).events as Envelope[];
    const asCyril = (await hub.events(agent('cyril'), 0, 500)).events as Envelope[];
    expect(asBob.some((e) => e.type === 'message' && e.to === 'bob')).toBe(true);
    expect(asCyril.some((e) => e.type === 'message' && e.to === 'bob')).toBe(false);
    expect(asCyril.some((e) => e.type === 'message' && !e.to)).toBe(true);
    const all = await hub.events(agent('cyril'), 0, 500);
    expect(all.lastSeq).toBeGreaterThanOrEqual((asBob[asBob.length - 1] as Envelope).seq);
  });

  describe('repo and project metadata', () => {
    const metaRepo = {
      name: 'platform',
      url: 'git@github.com:org/platform.git',
      hotPaths: ['package.json', '**/project.json'],
      contractPaths: ['libs/shared/**'],
      setup: ['npm ci'],
      verify: [{ name: 'typecheck', cmd: 'npm run type:check' }],
      laneMap: [{ glob: 'apps/mobile/**', lane: 'mobile' }],
      notes: 'Never run builds',
    };
    const seed = async () => {
      const { hub } = env;
      await hub.createSeatForHuman('s-a', 'a@x', { id: 'ania', name: 'Ania', plan: 'ultra', lanes: [] });
      await hub.createSeatForHuman('s-b', 'b@x', { id: 'bob', name: 'Bob', plan: 'ultra', lanes: [] });
      await hub.execute(human('ania'), 'project.create', {
        name: 'Repair Cart',
        repos: [metaRepo, { name: 'web', url: 'https://github.com/org/web.git' }],
        description: 'Inspection PDF to bookable repair cart',
        demo: { url: 'https://demo.example.com', stage: 'hack-int' },
        links: [{ label: 'Slack', url: 'https://example.slack.com/archives/C1' }],
        tags: ['revenue'],
      });
      await hub.patchMe(agent('ania'), { pinProject: 'repair-cart' });
      await hub.patchMe(agent('bob'), { pinProject: 'repair-cart' });
    };

    it('creates a project with repo defaults and metadata', async () => {
      await seed();
      const p = (await env.hub.requireProject('repair-cart')).value;
      expect(p).toMatchObject({ description: 'Inspection PDF to bookable repair cart', demo: { url: 'https://demo.example.com', stage: 'hack-int' }, tags: ['revenue'] });
      expect(p.links).toEqual([{ label: 'Slack', url: 'https://example.slack.com/archives/C1' }]);
      expect(p.repos[0]).toMatchObject({ name: 'platform', baseBranch: 'main', integrationBranch: 'hack/repair-cart', setup: ['npm ci'], prLabels: [] });
      expect(p.repos[1]).toMatchObject({ name: 'web', baseBranch: 'main', integrationBranch: 'hack/repair-cart', hotPaths: [], verify: [] });
      expect((await env.hub.projects())[0].repos).toHaveLength(2);
    });

    it('reads old project records with defaults', async () => {
      const legacy = { id: 'legacy', name: 'Legacy', repos: [{ name: 'mono', url: 'git@x:mono.git', integrationBranch: 'hack/legacy' }], lanes: [], status: 'active', phase: 'plan', goalVersion: 0, createdBy: 'a', createdAt: 0 };
      await env.store.commit([env.store.putNew(K.project('legacy'), legacy as never)], []);
      const p = (await env.hub.requireProject('legacy')).value;
      expect(p.links).toEqual([]);
      expect(p.tags).toEqual([]);
      expect(p.repos[0]).toMatchObject({ baseBranch: 'main', integrationBranch: 'hack/legacy', hotPaths: [], contractPaths: [], setup: [], verify: [], laneMap: [], prLabels: [] });
    });

    it('rejects duplicate repo names and non-https links', async () => {
      await seed();
      await expect(env.hub.execute(human('ania'), 'project.create', { name: 'Dup', repos: [metaRepo, metaRepo] })).rejects.toThrow(/duplicate repo name platform/);
      await expect(
        env.hub.execute(human('ania'), 'project.create', { name: 'Bad Link', repos: [metaRepo], links: [{ label: 'x', url: 'http://insecure.example.com' }] }),
      ).rejects.toThrow(/https/);
      await expect(env.hub.execute(human('ania'), 'project.update', { projectId: 'repair-cart', demo: { url: 'ftp://x.example.com' } })).rejects.toThrow(/invalid|https|url/i);
    });

    it('replaces repos on update, but not while a removed repo has active tickets', async () => {
      await seed();
      const { hub } = env;
      const t = await hub.createTicket(human('ania'), 'repair-cart', { repo: 'web', title: 'Cart page', pathsOwned: ['src/cart/**'], acceptance: [{ criterion: 'renders' }] });
      await hub.book(agent('bob'), t.id, {});
      await expect(hub.execute(human('ania'), 'project.update', { projectId: 'repair-cart', repos: [metaRepo] })).rejects.toThrow(/repo web still has active tickets/);
      await hub.release(agent('bob'), t.id, { reason: 'switching' });
      const updated = (await hub.execute(human('ania'), 'project.update', {
        projectId: 'repair-cart',
        repos: [{ ...metaRepo, baseBranch: 'develop', prLabels: ['hackathon'] }],
        tags: ['revenue', 'demo'],
      })) as { repos: { name: string; baseBranch: string; prLabels: string[] }[]; tags: string[]; description?: string };
      expect(updated.repos.map((r) => r.name)).toEqual(['platform']);
      expect(updated.repos[0]).toMatchObject({ baseBranch: 'develop', prLabels: ['hackathon'] });
      expect(updated.tags).toEqual(['revenue', 'demo']);
      expect(updated.description).toBe('Inspection PDF to bookable repair cart');
    });

    it('validates new tickets against hot and contract paths and fills lanes', async () => {
      await seed();
      const { hub } = env;
      await expect(
        hub.createTicket(agent('ania'), 'repair-cart', { repo: 'platform', title: 'Edit lockfile', pathsOwned: ['package.json'], acceptance: [{ criterion: 'x' }] }),
      ).rejects.toThrow(/hot path package.json/);
      await expect(
        hub.createTicket(agent('ania'), 'repair-cart', { repo: 'platform', title: 'Change contract', pathsOwned: ['libs/shared/cart/**'], acceptance: [{ criterion: 'x' }] }),
      ).rejects.toThrow(/contract path/);
      const contract = await hub.createTicket(agent('ania'), 'repair-cart', { repo: 'platform', type: 'contract', title: 'Cart contract', pathsOwned: ['libs/shared/cart/**'], acceptance: [{ criterion: 'x' }] });
      expect(contract.id).toMatch(/^T\d+$/);
      const slice = await hub.createTicket(agent('ania'), 'repair-cart', { repo: 'platform', title: 'Mobile cart', pathsOwned: ['apps/mobile/src/cart/**'], acceptance: [{ criterion: 'x' }] });
      expect(slice.lanes).toEqual(['mobile']);
      await expect(
        hub.createTicket(agent('ania'), 'repair-cart', { repo: 'nope', title: 'x', pathsOwned: ['a/**'], acceptance: [{ criterion: 'x' }] }),
      ).rejects.toThrow(/unknown repo nope/);
    });

    it('rejects a plan with a build ticket on a contract path and accepts it as a contract ticket', async () => {
      await seed();
      const { hub } = env;
      await expect(
        hub.execute(human('ania'), 'plan.load', { projectId: 'repair-cart', tickets: [{ id: 'c', repo: 'platform', title: 'Contracts', pathsOwned: ['libs/shared/**'], acceptance: [{ criterion: 'x' }] }] }),
      ).rejects.toThrow(/plan rejected: c: owns libs\/shared/);
      await expect(
        hub.propose(agent('ania'), { action: 'plan.load', summary: 'plan', payload: { projectId: 'repair-cart', tickets: [{ id: 'c', repo: 'platform', title: 'Contracts', pathsOwned: ['libs/shared/**'], acceptance: [{ criterion: 'x' }] }] } }),
      ).rejects.toThrow(/plan rejected/);
      expect(await hub.proposals('pending')).toHaveLength(0);
      const ok = (await hub.execute(human('ania'), 'plan.load', {
        projectId: 'repair-cart',
        tickets: [
          { id: 'c', repo: 'platform', type: 'contract', title: 'Contracts', pathsOwned: ['libs/shared/**'], acceptance: [{ criterion: 'x' }], wave: 0 },
          { id: 'm', repo: 'platform', title: 'Mobile', deps: ['c'], pathsOwned: ['apps/mobile/**'], acceptance: [{ criterion: 'x' }], wave: 1 },
        ],
      })) as { created: string[] };
      const [, mobileId] = ok.created;
      expect((await hub.ticketView(mobileId)).ticket.lanes).toEqual(['mobile']);
    });

    it('puts the repo on the ticket card and the pinned repos on /me', async () => {
      await seed();
      const { hub } = env;
      const t = await hub.createTicket(human('ania'), 'repair-cart', { repo: 'platform', title: 'Queue', pathsOwned: ['apps/mobile/src/q/**'], acceptance: [{ criterion: 'x' }] });
      const view = await hub.ticketView(t.id);
      expect(view.repo).toMatchObject({ name: 'platform', integrationBranch: 'hack/repair-cart', verify: [{ name: 'typecheck', cmd: 'npm run type:check' }] });
      expect(view.card).toMatch(/## Repo platform/);
      expect(view.card).toMatch(/Never run builds/);
      const me = await hub.me(agent('ania'));
      expect(me.projectId).toBe('repair-cart');
      expect((me.repos as { name: string }[]).map((r) => r.name)).toEqual(['platform', 'web']);
      const board = await hub.board('repair-cart');
      expect(((board.projects as { repos: unknown[] }[])[0]).repos).toHaveLength(2);
    });
  });

  it('expires join codes after 10 minutes', async () => {
    const { hub } = env;
    await hub.createSeatForHuman('sub-1', undefined, { id: 'ania', name: 'Ania' });
    const { code } = await hub.createJoinCode(human('ania'));
    env.advance(11 * MIN);
    await expect(hub.join({ code, machine: 'mbp' })).rejects.toThrow(/expired/);
  });

  it('runs a ticket from plan to merge, with locks, review and unblocking', async () => {
    const { hub } = env;
    const { created } = await bootstrap(env);
    const [contracts, api, mobile] = created;
    expect(await hub.listTickets('offline-capture', undefined, true)).toEqual([expect.objectContaining({ id: contracts })]);

    const { booked } = await hub.next(agent('ania'), {});
    expect(booked.map((t) => t.id)).toEqual([contracts]);
    expect(booked[0].branch).toBe(`hack/offline-capture/${contracts}-contracts`);
    expect((await hub.next(agent('bob'), {})).booked).toEqual([]);

    await hub.setStatus(agent('ania'), contracts, { status: 'in_progress' });
    await expect(hub.setStatus(agent('bob'), contracts, { status: 'review' })).rejects.toThrow(/booked by ania/);
    await hub.setStatus(agent('ania'), contracts, { status: 'review', prUrl: 'https://github.com/x/y/pull/1' });
    await expect(hub.reviewBook(agent('ania'), contracts, {})).rejects.toThrow(/another seat must review/);
    await hub.reviewBook(agent('bob'), contracts, {});
    await expect(hub.reviewBook(agent('cyril'), contracts, {})).rejects.toThrow(/being reviewed by bob/);
    const done = await hub.reviewDone(agent('bob'), contracts, { outcome: 'merged' });
    expect(done.status).toBe('done');

    const types = (await env.events()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['ticket.booked', 'ticket.review_needed', 'ticket.review_booked', 'ticket.done', 'ticket.ready']));
    const ready = (await env.events()).filter((e) => e.type === 'ticket.ready').map((e) => e.ticketId);
    expect(ready.sort()).toEqual([api, mobile].sort());

    const two = await hub.next(agent('cyril'), { n: 2 });
    expect(two.booked.map((t) => t.id)).toEqual([api, mobile]);
    const seqs = (await env.events()).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('refuses overlapping paths across tickets and frees locks on release', async () => {
    const { hub } = env;
    await bootstrap(env);
    await hub.execute(human('ania'), 'plan.load', {
      projectId: 'offline-capture',
      tickets: [
        { id: 'a', repo: 'mono', title: 'Wide', pathsOwned: ['apps/**'], acceptance: [{ criterion: 'x' }], priority: 0 },
        { id: 'b', repo: 'mono', title: 'Narrow', pathsOwned: ['apps/web/**'], acceptance: [{ criterion: 'x' }], priority: 0 },
      ],
    });
    const all = await hub.tickets('offline-capture');
    const wide = all.find((t) => t.title === 'Wide') as Ticket;
    const narrow = all.find((t) => t.title === 'Narrow') as Ticket;
    await hub.book(agent('ania'), wide.id, {});
    await expect(hub.book(agent('bob'), narrow.id, {})).rejects.toMatchObject({ code: 'path_conflict' });
    await hub.release(agent('ania'), wide.id, { reason: 'stuck', failed: true });
    expect((await hub.requireTicket(wide.id)).value).toMatchObject({ status: 'ready', attempts: 1 });
    await expect(hub.book(agent('bob'), narrow.id, {})).resolves.toMatchObject({ status: 'booked' });
  });

  it('honours seat and hub booking limits', async () => {
    const { hub } = env;
    await bootstrap(env);
    await hub.patchMe(agent('ania'), { maxConcurrentBookings: 1 });
    await hub.next(agent('ania'), {});
    await expect(hub.next(agent('ania'), {})).rejects.toThrow(/limit 1/);
  });

  it('expires leases in the sweep and returns tickets to ready', async () => {
    const { hub } = env;
    const { created } = await bootstrap(env);
    await hub.next(agent('ania'), {});
    env.advance(14 * MIN);
    await hub.heartbeat(agent('ania'), created[0], {});
    env.advance(14 * MIN);
    expect((await hub.sweep()).leases).toBe(0);
    env.advance(2 * MIN);
    expect((await hub.sweep()).leases).toBe(1);
    expect((await hub.requireTicket(created[0])).value).toMatchObject({ status: 'ready', booking: undefined });
  });

  it('keeps human-only actions behind proposals', async () => {
    const { hub } = env;
    await bootstrap(env);
    await expect(hub.execute(agent('ania'), 'project.phase', { projectId: 'offline-capture', phase: 'build' })).rejects.toThrow(/needs a human/);
    const r = (await hub.propose(agent('ania'), { action: 'project.phase', payload: { projectId: 'offline-capture', phase: 'build' }, summary: 'start building' })) as {
      proposal: { id: string };
      approveUrl: string;
    };
    expect(r.approveUrl).toBe(`https://board.example/#/approve/${r.proposal.id}`);
    await expect(hub.decideProposal(agent('bob'), r.proposal.id, true)).rejects.toThrow(/needs a human/);
    await hub.decideProposal(human('bob'), r.proposal.id, true);
    expect((await hub.requireProject('offline-capture')).value.phase).toBe('build');
    await expect(hub.decideProposal(human('bob'), r.proposal.id, true)).rejects.toThrow(/approved/);
    await expect(hub.propose(agent('ania'), { action: 'project.phase', payload: { projectId: 'offline-capture', phase: 'nope' } })).rejects.toBeInstanceOf(DomainError);
  });

  it('runs the open floor: resolve, contest, human vote, unpark', async () => {
    const { hub } = env;
    const { created } = await bootstrap(env);
    await hub.next(agent('ania'), {});
    const { escalation } = await hub.raise(agent('ania'), { kind: 'blocker', projectId: 'offline-capture', ticketId: created[0], ruleCode: 'B4', summary: 'Which date format?' });
    expect((await hub.requireTicket(created[0])).value.status).toBe('blocked');
    await expect(hub.resolve(agent('bob'), escalation.id, { resolution: 'ISO' })).rejects.toThrow(/needs a human/);
    await hub.resolve(human('bob'), escalation.id, { resolution: 'ISO 8601' });
    const { decision } = await hub.contest(human('cyril'), escalation.id, { reason: 'US format for the demo' });
    expect(decision.electorate).toBe('humans');
    await hub.vote(human('ania'), decision.id, { option: 'overturn' });
    await hub.vote(human('bob'), decision.id, { option: 'uphold' });
    const final = await hub.vote(human('cyril'), decision.id, { option: 'overturn' });
    expect(final).toMatchObject({ status: 'made', outcome: 'overturn' });
    expect((await hub.requireEscalation(escalation.id)).value.status).toBe('open');
    await hub.resolve(human('cyril'), escalation.id, { resolution: 'MM/DD/YYYY' });
    env.advance(6 * MIN);
    await hub.sweep();
    expect((await hub.requireEscalation(escalation.id)).value.status).toBe('resolved');
    expect((await hub.requireTicket(created[0])).value.status).toBe('ready');
  });

  it('keeps a ticket parked until every blocker that parked it is closed', async () => {
    const { hub } = env;
    const { created } = await bootstrap(env);
    await hub.next(agent('ania'), {});
    const first = await hub.raise(agent('ania'), { kind: 'blocker', projectId: 'offline-capture', ticketId: created[0], ruleCode: 'B4', summary: 'Which date format?' });
    const second = await hub.raise(agent('ania'), { kind: 'blocker', projectId: 'offline-capture', ticketId: created[0], ruleCode: 'B4', summary: 'Which time zone?' });
    expect(first.escalation.parksTicket).toBe(true);
    await hub.resolve(human('bob'), first.escalation.id, { resolution: 'ISO 8601' });
    env.advance(6 * MIN);
    await hub.sweep();
    expect((await hub.requireEscalation(first.escalation.id)).value.status).toBe('resolved');
    expect((await hub.requireTicket(created[0])).value.status).toBe('blocked');
    await hub.resolve(human('bob'), second.escalation.id, { resolution: 'UTC' });
    env.advance(6 * MIN);
    await hub.sweep();
    expect((await hub.requireTicket(created[0])).value.status).toBe('ready');
  });

  it('lets agents vote first on B1 and humans override until the deadline', async () => {
    const { hub } = env;
    const { created } = await bootstrap(env);
    await hub.next(agent('ania'), {});
    const { decision } = await hub.raise(agent('ania'), {
      kind: 'blocker', projectId: 'offline-capture', ticketId: created[0], ruleCode: 'B1', summary: 'add field', proposed: ['Add optional field'],
    });
    expect(decision).toBeDefined();
    const d = decision as NonNullable<typeof decision>;
    for (const s of d.eligible) await hub.vote(agent(s), d.id, { option: 'Add optional field', why: 'small change' });
    expect((await hub.requireDecision(d.id)).value.status).toBe('open');
    await hub.vote(human(d.eligible[0]), d.id, { option: d.defaultOption, why: 'keep contract' });
    env.advance(11 * MIN);
    await hub.sweep();
    const closed = (await hub.requireDecision(d.id)).value;
    expect(closed.status).not.toBe('open');
    expect((await hub.requireEscalation(d.escalationId as string)).value.status).toMatch(/resolved|defaulted/);
  });

  it('hands unanswered B3 help to humans and lets agents answer it', async () => {
    const { hub } = env;
    await bootstrap(env);
    const { escalation } = await hub.raise(agent('ania'), { kind: 'help', projectId: 'offline-capture', ruleCode: 'B3', summary: 'simulator will not boot' });
    env.advance(11 * MIN);
    await hub.sweep();
    expect((await env.events()).some((e) => e.type === 'escalation.to_humans')).toBe(true);
    await hub.answer(agent('bob'), escalation.id, { text: 'run sudo xcode-select -s /Applications/Xcode.app' });
    expect((await hub.requireEscalation(escalation.id)).value.status).toBe('resolved');
  });

  it('versions knowledge, blocks secrets and checks skill uploads', async () => {
    const { hub, uploads } = env;
    await bootstrap(env);
    await expect(hub.share(agent('ania'), { kind: 'tip', name: 'aws', body: 'use AKIAIOSFODNN7EXAMPLE' })).rejects.toThrow(/secrets/);
    const { s3Key } = await hub.skillUploadUrl(agent('ania'), { name: 'run-ios-sim' });
    await expect(hub.share(agent('ania'), { kind: 'skill', name: 'run-ios-sim', s3Key })).rejects.toThrow(/upload the skill archive/);
    uploads.set(s3Key, 1000);
    const v1 = await hub.share(agent('ania'), { kind: 'skill', name: 'run-ios-sim', s3Key, tags: ['ios'] });
    env.advance(1000);
    const { s3Key: k2 } = await hub.skillUploadUrl(agent('bob'), { name: 'run-ios-sim' });
    uploads.set(k2, 5 * 1024 * 1024);
    await expect(hub.share(agent('bob'), { kind: 'skill', name: 'run-ios-sim', s3Key: k2 })).rejects.toThrow(/limit/);
    uploads.set(k2, 2000);
    const v2 = await hub.share(agent('bob'), { kind: 'skill', name: 'run-ios-sim', s3Key: k2 });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await hub.knowledge('active')).map((k) => k.id)).toEqual([v2.id]);
    expect((await env.events()).map((e) => e.type)).toEqual(expect.arrayContaining(['skill.published', 'skill.updated']));
  });

  it('versions rules and merges project overrides', async () => {
    const { hub } = env;
    await bootstrap(env);
    await hub.execute(human('bob'), 'rules.set', { code: 'B3', patch: { maxAttempts: 1 } });
    await hub.execute(human('bob'), 'rules.override', { projectId: 'offline-capture', code: 'B1', patch: { resolver: 'human_quorum' } });
    const { version, rules } = await hub.rules('offline-capture');
    expect(version).toBe(3);
    expect(rules.find((r) => r.code === 'B3')?.maxAttempts).toBe(1);
    expect(rules.find((r) => r.code === 'B1')?.resolver).toBe('human_quorum');
    expect((await hub.rules()).rules.find((r) => r.code === 'B1')?.resolver).toBe('agent_quorum');
    await expect(hub.execute(human('bob'), 'rules.set', { code: 'Z9', patch: { name: 'x' } })).rejects.toThrow(/does not exist/);
    await hub.execute(human('bob'), 'rules.set', { code: 'B3', patch: { timeoutMin: null, contestMin: null, maxAttempts: 3 } });
    const b3 = (await hub.rules()).rules.find((r) => r.code === 'B3');
    expect(b3).toMatchObject({ maxAttempts: 3 });
    expect(b3 && 'timeoutMin' in b3).toBe(false);
  });

  it('records a goal change as a contestable B5 change and builds the board', async () => {
    const { hub } = env;
    await bootstrap(env);
    await hub.execute(human('bob'), 'goal.set', { projectId: 'offline-capture', statement: 'New goal', definitionOfDone: ['x'] });
    const esc = await hub.escalations('open');
    expect(esc).toEqual([expect.objectContaining({ ruleCode: 'B5', status: 'resolved_pending_contest' })]);
    const board = await hub.board();
    expect(board).toMatchObject({ projectId: 'offline-capture', goal: { version: 2 } });
    expect((board.projects as { total: number }[])[0].total).toBe(3);
    expect((board.seats as { human: boolean; cognitoSub?: string }[])[0]).toMatchObject({ human: true });
    expect((board.seats as Record<string, unknown>[])[0]).not.toHaveProperty('cognitoSub');
  });

  it('only emits presence events on session state changes', async () => {
    const { hub } = env;
    await bootstrap(env);
    const before = (await env.events()).length;
    await hub.session(agent('ania'), { sessionId: 's1', state: 'working' });
    await hub.session(agent('ania'), { sessionId: 's1', state: 'working' });
    await hub.session(agent('ania'), { sessionId: 's1', state: 'needs_input' });
    const added = (await env.events()).slice(before);
    expect(added.map((e) => e.data?.state)).toEqual(['working', 'needs_input']);
    expect(added[1].to).toBe('humans');
  });
});

describe('api router', () => {
  it('matches literal routes before parameters and maps errors to HTTP', async () => {
    expect(match('POST', '/tickets/next')?.route.pattern.source).toContain('next');
    expect(match('POST', '/tickets/T12/book')?.params).toEqual({ tid: 'T12' });
    expect(match('DELETE', '/tokens/tk_abc')?.params).toEqual({ tokenId: 'tk_abc' });
    const env = setup();
    const notFound = await dispatch(env.hub, { method: 'GET', path: '/nope', params: {}, query: {}, body: {}, auth: {} });
    expect(notFound.statusCode).toBe(404);
    const unauth = await dispatch(env.hub, { method: 'GET', path: '/me', params: {}, query: {}, body: {}, auth: {} });
    expect(unauth.statusCode).toBe(401);
    const noSeat = await dispatch(env.hub, { method: 'GET', path: '/me', params: {}, query: {}, body: {}, auth: { kind: 'human', sub: 'x' } });
    expect(JSON.parse(noSeat.body as string).error.code).toBe('forbidden');
    const invalid = await dispatch(env.hub, { method: 'POST', path: '/seats/me', params: {}, query: {}, body: { id: 'X!' }, auth: { kind: 'human', sub: 'x' } });
    expect(invalid.statusCode).toBe(400);
    const created = await dispatch(env.hub, { method: 'POST', path: '/seats/me', params: {}, query: {}, body: { id: 'ania', name: 'Ania' }, auth: { kind: 'human', sub: 'x' } });
    expect(created.statusCode).toBe(201);
    const health = await dispatch(env.hub, { method: 'GET', path: '/health', params: {}, query: {}, body: {}, auth: {} });
    expect(JSON.parse(health.body as string)).toMatchObject({ ok: true });
  });
});

describe('HackathonOne fix queue and releases', () => {
  const call = (env: ReturnType<typeof setup>, method: string, path: string, auth: Record<string, string>, body: unknown = {}, clientVersion?: string) =>
    dispatch(env.hub, { method, path, params: {}, query: {}, body, auth, clientVersion });

  it('files a bug into the fix queue project, creating it on first use', async () => {
    const env = setup();
    const { hub } = env;
    await hub.createSeatForHuman('s-a', 'a@x', { id: 'ania', name: 'Ania' });
    await expect(hub.fileToolBug(agent('ania'), { summary: 'watch prints nothing' })).rejects.toThrow(/HackathonOne repo URL/);
    await hub.execute(human('ania'), 'settings.set', { toolRepoUrl: 'git@github.com:acme/hakatonOne.git' });
    const t = await hub.fileToolBug(agent('ania', 'w1'), { summary: 'watch prints nothing after pin', detail: 'steps…', area: 'plugin', urgent: true, ticketId: 'T4' });
    expect(t).toMatchObject({ projectId: 'hackathonone', repo: 'hakatonOne', status: 'ready', priority: 1, lanes: ['plugin'] });
    expect(t.title).toBe('Fix: watch prints nothing after pin');
    expect(t.description).toContain('Reported by ania/w1 (agent) while working on T4');
    const project = (await hub.requireProject('hackathonone')).value;
    expect(project.repos[0]).toMatchObject({ name: 'hakatonOne', integrationBranch: 'main' });
    const second = await hub.fileToolBug(agent('ania'), { summary: 'board typo', area: 'board' });
    expect(second.pathsOwned).toEqual(['board/**']);
    await expect(hub.fileToolBug(agent('ania'), { summary: 'key AKIAABCDEFGHIJKLMNOP leaked' })).rejects.toThrow(/secrets/);
  });

  it('publishes releases through humans only, newest first, and announces them', async () => {
    const env = setup();
    const { hub } = env;
    await hub.createSeatForHuman('s-a', 'a@x', { id: 'ania', name: 'Ania' });
    await expect(hub.execute(agent('ania'), 'release.publish', { version: '0.3.0', notes: 'x' })).rejects.toThrow(/human/);
    const { proposal } = (await hub.propose(agent('ania'), { action: 'release.publish', payload: { version: '0.3.0', notes: 'fix queue' } })) as { proposal: { id: string } };
    await hub.decideProposal(human('ania'), proposal.id, true);
    expect(await hub.currentRelease()).toMatchObject({ latest: '0.3.0', notes: 'fix queue', by: 'ania' });
    await expect(hub.execute(human('ania'), 'release.publish', { version: '0.2.9', notes: 'old' })).rejects.toThrow(/not newer/);
    await expect(hub.execute(human('ania'), 'release.publish', { version: '0.3.1', notes: 'x', minimum: '0.4.0' })).rejects.toThrow(/newer than the release/);
    const events = await env.events();
    expect(events.find((e) => e.type === 'tool.released')).toMatchObject({ data: { version: '0.3.0' } });
    expect((await hub.me(agent('ania'))).release).toMatchObject({ latest: '0.3.0' });
  });

  it('blocks changes from agents below the minimum version but lets them read', async () => {
    const env = setup();
    const { hub } = env;
    await hub.createSeatForHuman('s-a', 'a@x', { id: 'ania', name: 'Ania' });
    const auth = { kind: 'agent', seatId: 'ania' };
    await hub.execute(human('ania'), 'release.publish', { version: '0.3.0', notes: 'breaking', minimum: '0.3.0' });
    const old = await call(env, 'PATCH', '/me', auth, { lanes: ['api'] }, '0.2.0');
    expect(old.statusCode).toBe(426);
    expect(JSON.parse(old.body as string).error).toMatchObject({ code: 'update_required', details: { minimum: '0.3.0' } });
    expect((await call(env, 'PATCH', '/me', auth, { lanes: ['api'] })).statusCode).toBe(426);
    expect((await call(env, 'GET', '/me', auth, {}, '0.2.0')).statusCode).toBe(200);
    expect((await call(env, 'PATCH', '/me', auth, { lanes: ['api'] }, '0.3.0')).statusCode).toBe(200);
    expect((await call(env, 'PATCH', '/me', { kind: 'human', seatId: 'ania' }, { lanes: ['api'] })).statusCode).toBe(200);
    expect(JSON.parse((await call(env, 'GET', '/release', auth)).body as string).release).toMatchObject({ latest: '0.3.0', minimum: '0.3.0' });
  });
});
