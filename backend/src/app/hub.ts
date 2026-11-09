import { z } from 'zod';
import type {
  Actor,
  BlockerRule,
  Decision,
  EnvelopeInput,
  Escalation,
  Goal,
  HumanAction,
  KnowledgeItem,
  Project,
  Proposal,
  Release,
  Repo,
  Seat,
  Settings,
  Ticket,
} from '../shared/types';
import {
  actionPayloadSchemas,
  type ActionPayloads,
  answerSchema,
  bookSchema,
  contestSchema,
  escalationCreateSchema,
  heartbeatSchema,
  joinSchema,
  knowledgeCreateSchema,
  messageSchema,
  nextSchema,
  patchMeSchema,
  proposalSchema,
  releaseSchema,
  resolveSchema,
  reviewBookSchema,
  reviewDoneSchema,
  seatCreateSchema,
  sessionSchema,
  statusSchema,
  ticketInputSchema,
  type TicketInput,
  toolBugSchema,
  voteSchema,
} from '../shared/schemas';
import { DomainError, fail } from '../core/errors';
import { envelope, truncate } from '../core/envelope';
import { prefixedId, slugify, ticketBranch } from '../core/ids';
import { lockPrefixes, prefixesOverlap } from '../core/paths';
import { validatePlan } from '../core/plan';
import { lanesFromMap, normalizeProject, normalizeRepo, protectedPathErrors } from '../core/repos';
import { findRule, mergeRules, rulesDigest, type StoredRule } from '../core/rules';
import { castVote, settle } from '../core/quorum';
import {
  answerByAgent,
  applyDecisionOutcome,
  contest as contestEscalation,
  isClosed,
  planEscalation,
  resolveByHuman,
  sweepEscalation,
} from '../core/escalations';
import { scanSecrets } from '../core/secrets';
import { TOOL_AREAS, TOOL_PROJECT_ID, toolRepo } from '../core/tool';
import { compareVersions } from '../core/version';
import { generateAgentToken, generateJoinCode, generateTokenId, hashSecret } from '../core/tokens';
import {
  activeBookingsOf,
  assertSeatUnderLimit,
  claimable,
  isActive,
  newlyReadyDependents,
  readiness,
  renderCard,
  statusTransitionFor,
  transition,
} from '../core/tickets';
import { K, type JoinRecord, type LockRecord, type TokenRecord } from '../adapters/keys';
import { chunk, Store, type TxItem, type Versioned } from '../adapters/store';
import { MAX_SKILL_BYTES, SkillFiles } from '../adapters/s3';
import type { RuntimeConfig } from '../adapters/config';

const MIN = 60_000;
export const DEFAULT_SETTINGS: Settings = { leaseTtlSec: 900, defaultContestMin: 5, rulesVersion: 1 };
const OPEN_ESC_STATUSES = ['open', 'resolved_pending_contest', 'contested'] as const;
const SESSION_STATE_TEXT: Record<string, string> = { working: 'is working', needs_input: 'is waiting for a human', idle: 'is idle', ended: 'ended' };
const PARKABLE: readonly string[] = ['booked', 'in_progress', 'blocked', 'ready', 'review'];

export interface HubDeps {
  store: Store;
  files: SkillFiles;
  pepper: () => Promise<string>;
  runtime: () => Promise<RuntimeConfig>;
  eventEndsAt: number;
  now?: () => number;
  /** Default git URL of the CollabOne repo for the fix queue; the hub setting overrides it. */
  toolRepoUrl?: string;
}

const RELEASE_CACHE_MS = 30_000;

export interface StoredToken extends TokenRecord {
  hash: string;
}

type Ev = Parameters<typeof envelope>[0];

const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new DomainError('invalid', issues.join('; '), { issues });
  }
  return r.data;
};

const requireHuman = (actor: Actor): void => {
  if (actor.kind !== 'human') fail('forbidden', 'this action needs a human: propose it with /proposals and approve it in the board');
};

export class Hub {
  private readonly store: Store;
  private readonly files: SkillFiles;
  private readonly now: () => number;

  private releaseCache?: { at: number; value: Release | undefined };

  constructor(private readonly deps: HubDeps) {
    this.store = deps.store;
    this.files = deps.files;
    this.now = deps.now ?? Date.now;
  }

  private ev(actor: Actor | 'system', e: Omit<Ev, 'from' | 'fromKind'>): EnvelopeInput {
    return actor === 'system'
      ? envelope({ ...e, from: 'system', fromKind: 'system' })
      : envelope({ ...e, from: actor.workerId ? `${actor.seatId}/${actor.workerId}` : actor.seatId, fromKind: actor.kind });
  }

  // ---------- reads ----------

  async settings(): Promise<Versioned<Settings>> {
    const s = await this.store.get<Settings>(K.settings());
    return s ? { value: { ...DEFAULT_SETTINGS, ...s.value }, v: s.v } : { value: { ...DEFAULT_SETTINGS }, v: 0 };
  }

  async seat(id: string): Promise<Versioned<Seat> | undefined> {
    return this.store.get<Seat>(K.seat(id));
  }

  async requireSeat(id: string): Promise<Versioned<Seat>> {
    return (await this.seat(id)) ?? fail('not_found', `seat ${id} not found`);
  }

  async seats(): Promise<Seat[]> {
    return (await this.store.queryGsi<Seat>('SEATS')).map((s) => s.value);
  }

  async projects(): Promise<Project[]> {
    return (await this.store.queryGsi<Project>('PROJECTS')).map((p) => normalizeProject(p.value));
  }

  async requireProject(id: string): Promise<Versioned<Project>> {
    const p = (await this.store.get<Project>(K.project(id))) ?? fail('not_found', `project ${id} not found`);
    return { ...p, value: normalizeProject(p.value) };
  }

  async goal(projectId: string): Promise<Goal | undefined> {
    const p = await this.requireProject(projectId);
    if (!p.value.goalVersion) return undefined;
    return (await this.store.get<Goal>(K.goal(projectId, p.value.goalVersion)))?.value;
  }

  async ticketsV(projectId: string): Promise<Versioned<Ticket>[]> {
    return this.store.queryGsi<Ticket>(`PROJECT#${projectId}#TICKETS`);
  }

  async tickets(projectId: string): Promise<Ticket[]> {
    return (await this.ticketsV(projectId)).map((t) => t.value);
  }

  async requireTicket(id: string): Promise<Versioned<Ticket>> {
    return (await this.store.get<Ticket>(K.ticketPk(id))) ?? fail('not_found', `ticket ${id} not found`);
  }

  async rules(projectId?: string): Promise<{ version: number; rules: BlockerRule[] }> {
    const [settings, hub, project] = await Promise.all([
      this.settings(),
      this.store.queryPk<StoredRule>('HUB', 'RULE#'),
      projectId ? this.store.queryPk<StoredRule>(`PROJECT#${projectId}`, 'RULE#') : Promise.resolve([]),
    ]);
    return { version: settings.value.rulesVersion, rules: mergeRules(hub.map((r) => r.value), project.map((r) => r.value)) };
  }

  private async escalationsV(statuses: readonly string[]): Promise<Versioned<Escalation>[]> {
    const lists = await Promise.all(statuses.map((s) => this.store.queryGsi<Escalation>('ESCS', `${s}#`)));
    return lists.flat();
  }

  async escalations(status: string | undefined): Promise<Escalation[]> {
    const statuses = !status || status === 'open' ? [...OPEN_ESC_STATUSES] : [status];
    return (await this.escalationsV(statuses)).map((e) => e.value);
  }

  async requireEscalation(id: string): Promise<Versioned<Escalation>> {
    return (await this.store.get<Escalation>({ PK: `ESC#${id}`, SK: 'META' })) ?? fail('not_found', `escalation ${id} not found`);
  }

  async decisions(status = 'open'): Promise<Decision[]> {
    return (await this.store.queryGsi<Decision>('DECS', `${status}#`)).map((d) => d.value);
  }

  async requireDecision(id: string): Promise<Versioned<Decision>> {
    return (await this.store.get<Decision>({ PK: `DEC#${id}`, SK: 'META' })) ?? fail('not_found', `decision ${id} not found`);
  }

  async knowledge(status = 'active', since = 0): Promise<KnowledgeItem[]> {
    return (await this.store.queryGsi<KnowledgeItem>('KNOW', `${status}#`)).map((k) => k.value).filter((k) => k.createdAt > since);
  }

  async proposals(status = 'pending'): Promise<Proposal[]> {
    return (await this.store.queryGsi<Proposal>('PROPS', `${status}#`)).map((p) => p.value);
  }

  private async humanSeatIds(): Promise<string[]> {
    return (await this.seats()).filter((s) => s.cognitoSub).map((s) => s.id);
  }

  private async members(projectId: string): Promise<string[]> {
    return (await this.seats()).filter((s) => s.projects.includes(projectId)).map((s) => s.id);
  }

  // ---------- seats, join codes, tokens ----------

  async createSeatForHuman(sub: string, email: string | undefined, body: unknown): Promise<Seat> {
    const input = parse(seatCreateSchema, body);
    const linked = await this.store.get<{ seatId: string }>(K.sub(sub));
    if (linked) fail('conflict', `you already have seat ${linked.value.seatId}`);
    const existing = await this.seat(input.id);
    if (existing?.value.cognitoSub) fail('conflict', `seat ${input.id} belongs to someone else`);
    const seat: Seat = existing
      ? { ...existing.value, name: input.name, plan: input.plan, lanes: input.lanes, cognitoSub: sub }
      : { id: input.id, name: input.name, lanes: input.lanes, projects: [], pinned: true, plan: input.plan, workMode: 'solo', autopilot: false, cognitoSub: sub };
    await this.store.commit(
      [this.store.put(K.seat(seat.id), seat, existing ? existing.v : 0), this.store.putNew(K.sub(sub), { seatId: seat.id, email })],
      [this.ev({ seatId: seat.id, kind: 'human' }, { type: 'seat.joined', summary: `${seat.name} (${seat.id}) joined the hub` })],
    );
    return seat;
  }

  async createJoinCode(actor: Actor): Promise<{ code: string; expiresAt: number }> {
    requireHuman(actor);
    await this.requireSeat(actor.seatId);
    const code = generateJoinCode();
    const expiresAt = this.now() + 10 * MIN;
    const rec: JoinRecord = { seatId: actor.seatId, createdAt: this.now(), expiresAt, used: false };
    await this.store.commit([this.store.putNew(K.join(hashSecret(await this.deps.pepper(), code)), rec)]);
    return { code, expiresAt };
  }

  async join(body: unknown): Promise<Record<string, unknown>> {
    const input = parse(joinSchema, body);
    const pepper = await this.deps.pepper();
    const rec = await this.store.get<JoinRecord>(K.join(hashSecret(pepper, input.code)));
    if (!rec || rec.value.used || rec.value.expiresAt < this.now()) fail('unauthorized', 'join code is invalid, used or expired; create a new one in the board');
    const joinRec = rec as Versioned<JoinRecord>;
    const seat = await this.requireSeat(joinRec.value.seatId);
    const token = generateAgentToken();
    const hash = hashSecret(pepper, token);
    const record: StoredToken = {
      hash,
      tokenId: generateTokenId(),
      seatId: seat.value.id,
      kind: 'agent',
      machine: input.machine,
      createdAt: this.now(),
      expiresAt: this.deps.eventEndsAt,
      revoked: false,
    };
    await this.store.commit(
      [
        this.store.put(K.join(hashSecret(pepper, input.code)), { ...joinRec.value, used: true }, joinRec.v),
        this.store.putNew(K.token(hash, seat.value.id, record.tokenId), record),
        this.store.put(K.seat(seat.value.id), { ...seat.value, machine: input.machine, lastSeen: this.now() }, seat.v),
      ],
      [this.ev({ seatId: seat.value.id, kind: 'agent' }, { type: 'seat.connected', summary: `${seat.value.id} connected ${input.machine}` })],
    );
    const rt = await this.deps.runtime();
    return {
      token,
      tokenId: record.tokenId,
      seatId: seat.value.id,
      projectId: seat.value.projects[0],
      apiUrl: rt.apiUrl,
      boardUrl: rt.boardUrl,
      events: rt.events,
      expiresAt: record.expiresAt,
    };
  }

  async authenticateAgentToken(token: string): Promise<{ seatId: string; workerId?: string; tokenId: string } | undefined> {
    const rec = await this.store.get<StoredToken>(K.tokenPk(hashSecret(await this.deps.pepper(), token)), false);
    if (!rec || rec.value.revoked || rec.value.expiresAt < this.now()) return undefined;
    return { seatId: rec.value.seatId, workerId: rec.value.workerId, tokenId: rec.value.tokenId };
  }

  async seatForSub(sub: string): Promise<string | undefined> {
    return (await this.store.get<{ seatId: string }>(K.sub(sub), false))?.value.seatId;
  }

  async listTokens(actor: Actor): Promise<Omit<TokenRecord, never>[]> {
    requireHuman(actor);
    return (await this.store.queryGsi<StoredToken>(`SEAT#${actor.seatId}`, 'TOKEN#')).map(({ value }) => {
      const { hash: _hash, ...rest } = value;
      return rest;
    });
  }

  async revokeToken(actor: Actor, tokenId: string): Promise<void> {
    requireHuman(actor);
    const tokens = await this.store.queryGsi<StoredToken>(`SEAT#${actor.seatId}`, `TOKEN#${tokenId}`);
    const t = tokens[0] ?? fail('not_found', `token ${tokenId} not found on your seat`);
    await this.store.commit(
      [this.store.put(K.token(t.value.hash, actor.seatId, t.value.tokenId), { ...t.value, revoked: true }, t.v)],
      [this.ev(actor, { type: 'seat.token_revoked', summary: `${actor.seatId} revoked ${tokenId}`, to: actor.seatId })],
    );
  }

  private async createWorkerToken(actor: Actor, workerId: string): Promise<{ token: string; tokenId: string; workerId: string }> {
    const token = generateAgentToken();
    const hash = hashSecret(await this.deps.pepper(), token);
    const record: StoredToken = {
      hash,
      tokenId: generateTokenId(),
      seatId: actor.seatId,
      kind: 'worker',
      workerId,
      createdAt: this.now(),
      expiresAt: this.deps.eventEndsAt,
      revoked: false,
    };
    await this.store.commit([this.store.putNew(K.token(hash, actor.seatId, record.tokenId), record)]);
    return { token, tokenId: record.tokenId, workerId };
  }

  // ---------- me ----------

  async me(actor: Actor): Promise<Record<string, unknown>> {
    const seat = await this.requireSeat(actor.seatId);
    const projectId = seat.value.projects[0];
    const { version, rules } = await this.rules(projectId);
    const project = projectId ? (await this.store.get<Project>(K.project(projectId)))?.value : undefined;
    const repos = project ? normalizeProject(project).repos : [];
    return { seat: seat.value, actor, projectId, repos, rules: { version, digest: rulesDigest(rules, version) }, release: (await this.currentRelease()) ?? null };
  }

  async patchMe(actor: Actor, body: unknown): Promise<Seat> {
    const p = parse(patchMeSchema, body);
    const seat = await this.requireSeat(actor.seatId);
    const next: Seat = { ...seat.value, lastSeen: this.now() };
    if (p.lanes) next.lanes = p.lanes;
    if (p.workMode) next.workMode = p.workMode;
    if (p.maxConcurrentBookings !== undefined) next.maxConcurrentBookings = p.maxConcurrentBookings ?? undefined;
    if (p.autopilot !== undefined) next.autopilot = p.autopilot;
    if (p.machine) next.machine = p.machine;
    if (p.usage) next.usage = { ...p.usage, at: this.now() };
    const events: EnvelopeInput[] = [];
    if (p.pinProject) {
      await this.requireProject(p.pinProject);
      next.projects = [p.pinProject, ...next.projects.filter((x) => x !== p.pinProject)];
      next.pinned = true;
      events.push(this.ev(actor, { type: 'seat.pinned', summary: `${actor.seatId} pinned to ${p.pinProject}`, projectId: p.pinProject }));
    }
    if (p.workMode && p.workMode !== seat.value.workMode)
      events.push(this.ev(actor, { type: 'seat.mode', summary: `${actor.seatId} switched to ${p.workMode}` }));
    await this.store.commit([this.store.put(K.seat(seat.value.id), next, seat.v)], events);
    return next;
  }

  async session(actor: Actor, body: unknown): Promise<void> {
    const s = parse(sessionSchema, body);
    const seat = await this.requireSeat(actor.seatId);
    const now = this.now();
    const prev = seat.value.sessions?.find((x) => x.sessionId === s.sessionId);
    const sessions = [
      { ...s, at: now },
      ...(seat.value.sessions ?? []).filter((x) => x.sessionId !== s.sessionId && x.state !== 'ended' && now - x.at < 2 * 60 * MIN),
    ].slice(0, 12);
    const events =
      prev?.state !== s.state
        ? [
            this.ev(actor, {
              type: 'session.state',
              summary: `${actor.seatId} session ${s.sessionId.slice(0, 8)} ${SESSION_STATE_TEXT[s.state] ?? `is ${s.state}`}${s.ticketId ? ` on ${s.ticketId}` : ''}`,
              ticketId: s.ticketId,
              to: s.state === 'needs_input' ? 'humans' : undefined,
              data: { sessionId: s.sessionId, state: s.state },
            }),
          ]
        : [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fresh = attempt === 0 ? seat : await this.requireSeat(actor.seatId);
        await this.store.commit([this.store.put(K.seat(actor.seatId), { ...fresh.value, sessions, lastSeen: now }, fresh.v)], events);
        return;
      } catch (e) {
        if (!(e instanceof DomainError && e.code === 'conflict') || attempt === 2) throw e;
      }
    }
  }

  // ---------- tickets ----------

  private assertTicketOwner(actor: Actor, t: Ticket, allowAnyHuman = false): void {
    if (allowAnyHuman && actor.kind === 'human') return;
    if (t.booking?.seatId !== actor.seatId) fail('forbidden', `${t.id} is booked by ${t.booking?.seatId ?? 'nobody'}, not ${actor.seatId}`);
  }

  private lockOps(t: Ticket, op: 'put' | 'delete'): TxItem[] {
    return lockPrefixes(t.pathsOwned).map((prefix) => {
      const keys = K.lock(t.projectId, t.repo, prefix);
      if (op === 'delete') return this.store.delete(keys);
      const rec: LockRecord = { projectId: t.projectId, repo: t.repo, prefix, ticketId: t.id };
      return this.store.putNew(keys, rec);
    });
  }

  private log(t: Ticket, actor: Actor | 'system', text: string): Ticket['log'] {
    const entry = actor === 'system' ? { ts: this.now(), who: 'system', kind: 'agent' as const, text } : { ts: this.now(), who: actor.seatId, kind: actor.kind, text };
    return [...t.log, entry].slice(-50);
  }

  async ticketView(id: string): Promise<{ ticket: Ticket; card: string; repo: Repo | null }> {
    const t = (await this.requireTicket(id)).value;
    const project = (await this.store.get<Project>(K.project(t.projectId)))?.value;
    const repo = project ? normalizeProject(project).repos.find((r) => r.name === t.repo) ?? null : null;
    return { ticket: t, card: renderCard(t, repo ?? undefined), repo };
  }

  async listTickets(projectId: string, status?: string, ready?: boolean): Promise<Ticket[]> {
    await this.requireProject(projectId);
    const all = await this.tickets(projectId);
    let out = status ? all.filter((t) => t.status === status) : all;
    if (ready) out = out.filter((t) => readiness(t, all).ok);
    return out;
  }

  async createTicket(actor: Actor, projectId: string, body: unknown): Promise<Ticket> {
    let input = parse(ticketInputSchema, body);
    const project = await this.requireProject(projectId);
    const repo = project.value.repos.find((r) => r.name === input.repo) ?? fail('invalid', `unknown repo ${input.repo}`);
    const pathErrors = protectedPathErrors(input.title, input.type, input.pathsOwned, repo);
    if (pathErrors.length) fail('invalid', pathErrors.join('; '), { errors: pathErrors });
    if (input.lanes.length === 0) {
      const lanes = lanesFromMap(input.pathsOwned, repo);
      if (lanes.length) input = { ...input, lanes };
    }
    const existing = await this.tickets(projectId);
    for (const d of input.deps) if (!existing.some((t) => t.id === d)) fail('invalid', `unknown dependency ${d}`);
    const [n] = await this.store.nextIds('ticket');
    const id = prefixedId('T', n);
    const status: Ticket['status'] =
      actor.kind === 'agent' ? (input.dodRefs && input.dodRefs.length > 0 ? 'planned' : 'ready') : (input.status ?? 'ready');
    const ticket = this.ticketFromInput(id, projectId, input, actor, status);
    await this.store.commit(
      [this.store.putNew(K.ticket(ticket), ticket)],
      [this.ev(actor, { type: 'ticket.added', summary: `${id} added (${status}): ${ticket.title}`, projectId, ticketId: id, data: { status, lanes: ticket.lanes } })],
    );
    return ticket;
  }

  private ticketFromInput(id: string, projectId: string, input: TicketInput, actor: Actor, status: Ticket['status'], deps = input.deps): Ticket {
    return {
      id,
      projectId,
      repo: input.repo,
      title: input.title,
      description: input.description,
      type: input.type,
      lanes: input.lanes,
      deps,
      pathsOwned: input.pathsOwned,
      pathsRead: input.pathsRead,
      acceptance: input.acceptance,
      priority: input.priority,
      wave: input.wave,
      status,
      attempts: 0,
      createdBy: actor.seatId,
      createdByAgent: actor.kind === 'agent',
      dodRefs: input.dodRefs,
      log: [{ ts: this.now(), who: actor.seatId, kind: actor.kind, text: 'created' }],
      updatedAt: this.now(),
      version: 1,
    };
  }

  private async bookOne(actor: Actor, tv: Versioned<Ticket>, all: Ticket[], opts: { workerId?: string; sessionId?: string }): Promise<Ticket> {
    const t = tv.value;
    const r = readiness(t, all);
    if (!r.ok) throw new DomainError(r.code, `${t.id}: ${r.reason}`, r.conflictsWith ? { conflictsWith: r.conflictsWith } : undefined);
    const [project, settings, locks] = await Promise.all([
      this.requireProject(t.projectId),
      this.settings(),
      this.store.queryGsi<LockRecord>(`PROJECT#${t.projectId}#LOCKS`, `${t.repo}#`),
    ]);
    for (const prefix of lockPrefixes(t.pathsOwned)) {
      const clash = locks.find((l) => l.value.repo === t.repo && l.value.ticketId !== t.id && prefixesOverlap(l.value.prefix, prefix));
      if (clash) throw new DomainError('path_conflict', `${t.id}: ${prefix || '(repo root)'} is locked by ${clash.value.ticketId}`, { conflictsWith: clash.value.ticketId });
    }
    const status = transition(t, 'book');
    const workerId = opts.workerId ?? actor.workerId;
    const booked: Ticket = {
      ...t,
      status,
      booking: { seatId: actor.seatId, workerId, sessionId: opts.sessionId, leaseExpiresAt: this.now() + settings.value.leaseTtlSec * 1000 },
      branch: t.branch ?? ticketBranch(t.projectId, t.id, t.title),
      log: this.log(t, actor, `booked${workerId ? ` by worker ${workerId}` : ''}`),
      updatedAt: this.now(),
      version: tv.v + 1,
    };
    await this.store.commit(
      [
        this.store.put(K.ticket(booked), booked, tv.v),
        this.store.put(K.project(project.value.id), project.value, project.v),
        ...this.lockOps(booked, 'put'),
      ],
      [this.ev(actor, { type: 'ticket.booked', summary: `${t.id} booked by ${actor.seatId}: ${t.title}`, projectId: t.projectId, ticketId: t.id, data: { branch: booked.branch } })],
    );
    return booked;
  }

  async book(actor: Actor, ticketId: string, body: unknown): Promise<Ticket> {
    const opts = parse(bookSchema, body);
    const tv = await this.requireTicket(ticketId);
    const [seat, settings, all] = await Promise.all([this.requireSeat(actor.seatId), this.settings(), this.tickets(tv.value.projectId)]);
    assertSeatUnderLimit(seat.value, settings.value, activeBookingsOf(actor.seatId, all));
    return this.bookOne(actor, tv, all, opts);
  }

  async next(actor: Actor, body: unknown): Promise<{ booked: Ticket[] }> {
    const opts = parse(nextSchema, body);
    const [seat, settings] = await Promise.all([this.requireSeat(actor.seatId), this.settings()]);
    const projectId = opts.projectId ?? seat.value.projects[0] ?? fail('invalid', 'no project: pass projectId or pin your seat to a project');
    const lanes = opts.lanes ?? seat.value.lanes;
    const booked: Ticket[] = [];
    const skipped = new Set<string>();
    for (let round = 0; round < 12 && booked.length < opts.n; round++) {
      const tvs = await this.ticketsV(projectId);
      const all = tvs.map((t) => t.value);
      assertSeatUnderLimit(seat.value, settings.value, activeBookingsOf(actor.seatId, all));
      const candidate = claimable(all, projectId, lanes).find((t) => !skipped.has(t.id));
      if (!candidate) break;
      const tv = tvs.find((x) => x.value.id === candidate.id) as Versioned<Ticket>;
      try {
        booked.push(await this.bookOne(actor, tv, all, opts));
      } catch (e) {
        if (!(e instanceof DomainError) || !['conflict', 'path_conflict', 'not_ready'].includes(e.code)) throw e;
        skipped.add(candidate.id);
      }
    }
    return { booked };
  }

  async heartbeat(actor: Actor, ticketId: string, body: unknown): Promise<{ leaseExpiresAt: number }> {
    const { sessionId } = parse(heartbeatSchema, body);
    const tv = await this.requireTicket(ticketId);
    const settings = await this.settings();
    const t = tv.value;
    const lease = this.now() + settings.value.leaseTtlSec * 1000;
    let next: Ticket;
    if (t.review && t.review.seatId === actor.seatId && t.status === 'review') next = { ...t, review: { ...t.review, leaseExpiresAt: lease } };
    else {
      this.assertTicketOwner(actor, t);
      next = { ...t, booking: { ...(t.booking as NonNullable<Ticket['booking']>), sessionId: sessionId ?? t.booking?.sessionId, leaseExpiresAt: lease } };
    }
    await this.store.commit([this.store.put(K.ticket(next), { ...next, version: tv.v + 1 }, tv.v)]);
    return { leaseExpiresAt: lease };
  }

  async setStatus(actor: Actor, ticketId: string, body: unknown): Promise<Ticket> {
    const input = parse(statusSchema, body);
    const tv = await this.requireTicket(ticketId);
    const t = tv.value;
    this.assertTicketOwner(actor, t);
    const status = transition(t, statusTransitionFor(input.status));
    const settings = await this.settings();
    const next: Ticket = {
      ...t,
      status,
      prUrl: input.prUrl ?? t.prUrl,
      booking: t.booking ? { ...t.booking, leaseExpiresAt: this.now() + settings.value.leaseTtlSec * 1000 } : t.booking,
      log: this.log(t, actor, `${status}${input.note ? `: ${input.note}` : ''}`),
      updatedAt: this.now(),
      version: tv.v + 1,
    };
    const type = status === 'review' ? 'ticket.review_needed' : 'ticket.status';
    await this.store.commit(
      [this.store.put(K.ticket(next), next, tv.v)],
      [
        this.ev(actor, {
          type,
          summary: status === 'review' ? `${t.id} ready for review${next.prUrl ? ` (${next.prUrl})` : ''}: ${t.title}` : `${t.id} → ${status}${input.note ? `: ${input.note}` : ''}`,
          projectId: t.projectId,
          ticketId: t.id,
          data: { status, prUrl: next.prUrl },
        }),
      ],
    );
    return next;
  }

  async release(actor: Actor, ticketId: string, body: unknown): Promise<Ticket> {
    const input = parse(releaseSchema, body);
    const tv = await this.requireTicket(ticketId);
    const t = tv.value;
    this.assertTicketOwner(actor, t, true);
    const status = transition(t, 'release');
    const next: Ticket = {
      ...t,
      status,
      booking: undefined,
      review: undefined,
      attempts: t.attempts + (input.failed ? 1 : 0),
      log: this.log(t, actor, `released: ${input.reason}`),
      updatedAt: this.now(),
      version: tv.v + 1,
    };
    await this.store.commit(
      [this.store.put(K.ticket(next), next, tv.v), ...this.lockOps(t, 'delete')],
      [this.ev(actor, { type: 'ticket.released', summary: `${t.id} released by ${actor.seatId}: ${input.reason}`, projectId: t.projectId, ticketId: t.id, data: { failed: input.failed, attempts: next.attempts } })],
    );
    return next;
  }

  async reviewBook(actor: Actor, ticketId: string, body: unknown): Promise<Ticket> {
    const { workerId } = parse(reviewBookSchema, body);
    const tv = await this.requireTicket(ticketId);
    const t = tv.value;
    if (t.status !== 'review') fail('not_ready', `${t.id} is ${t.status}, not waiting for review`);
    if (t.booking?.seatId === actor.seatId) fail('forbidden', `${t.id} was written by your seat; another seat must review it`);
    if (t.review && t.review.seatId !== actor.seatId && t.review.leaseExpiresAt > this.now()) fail('conflict', `${t.id} is being reviewed by ${t.review.seatId}`);
    const settings = await this.settings();
    const next: Ticket = {
      ...t,
      review: { seatId: actor.seatId, workerId: workerId ?? actor.workerId, leaseExpiresAt: this.now() + settings.value.leaseTtlSec * 1000 },
      log: this.log(t, actor, 'review booked'),
      updatedAt: this.now(),
      version: tv.v + 1,
    };
    await this.store.commit(
      [this.store.put(K.ticket(next), next, tv.v)],
      [this.ev(actor, { type: 'ticket.review_booked', summary: `${t.id} review booked by ${actor.seatId}`, projectId: t.projectId, ticketId: t.id })],
    );
    return next;
  }

  async reviewDone(actor: Actor, ticketId: string, body: unknown): Promise<Ticket> {
    const input = parse(reviewDoneSchema, body);
    const tv = await this.requireTicket(ticketId);
    const t = tv.value;
    if (t.status !== 'review') fail('not_ready', `${t.id} is ${t.status}`);
    if (!(t.review?.seatId === actor.seatId || (actor.kind === 'human' && t.booking?.seatId !== actor.seatId)))
      fail('forbidden', `book the review of ${t.id} first (POST /tickets/${t.id}/review/book)`);
    const now = this.now();
    if (input.outcome === 'merged') {
      const next: Ticket = {
        ...t,
        status: transition(t, 'merged'),
        prUrl: input.prUrl ?? t.prUrl,
        booking: undefined,
        review: undefined,
        log: this.log(t, actor, `merged${input.note ? `: ${input.note}` : ''}`),
        updatedAt: now,
        version: tv.v + 1,
      };
      const all = (await this.tickets(t.projectId)).map((x) => (x.id === t.id ? next : x));
      const ready = newlyReadyDependents(t.id, all);
      await this.store.commit(
        [this.store.put(K.ticket(next), next, tv.v), ...this.lockOps(t, 'delete')],
        [
          this.ev(actor, { type: 'ticket.done', summary: `${t.id} merged by ${actor.seatId}: ${t.title}`, projectId: t.projectId, ticketId: t.id, data: { prUrl: next.prUrl, unblocked: ready.map((r) => r.id) } }),
          ...ready.map((r) =>
            this.ev(actor, { type: 'ticket.ready', summary: `${r.id} ready (${r.lanes.join(', ') || 'any lane'}): ${r.title}`, projectId: r.projectId, ticketId: r.id, data: { lanes: r.lanes } }),
          ),
        ],
      );
      return next;
    }
    const settings = await this.settings();
    const next: Ticket = {
      ...t,
      status: transition(t, 'changes'),
      review: undefined,
      booking: t.booking ? { ...t.booking, leaseExpiresAt: now + settings.value.leaseTtlSec * 1000 } : t.booking,
      log: this.log(t, actor, `changes requested${input.note ? `: ${input.note}` : ''}`),
      updatedAt: now,
      version: tv.v + 1,
    };
    await this.store.commit(
      [this.store.put(K.ticket(next), next, tv.v)],
      [
        this.ev(actor, {
          type: 'ticket.changes_requested',
          summary: `${t.id} needs changes (review by ${actor.seatId})${input.note ? `: ${input.note}` : ''}`,
          projectId: t.projectId,
          ticketId: t.id,
          to: t.booking?.seatId,
        }),
      ],
    );
    return next;
  }

  // ---------- escalations & decisions ----------

  async raise(actor: Actor, body: unknown): Promise<{ escalation: Escalation; decision?: Decision }> {
    const input = parse(escalationCreateSchema, body);
    await this.requireProject(input.projectId);
    const { version, rules } = await this.rules(input.projectId);
    const rule = findRule(rules, input.ruleCode) ?? fail('invalid', `unknown rule ${input.ruleCode}; see GET /rules`);
    const tv = input.ticketId ? await this.requireTicket(input.ticketId) : undefined;
    const [all, members, humans] = await Promise.all([this.tickets(input.projectId), this.members(input.projectId), this.humanSeatIds()]);
    const plan = planEscalation({
      kind: input.kind,
      projectId: input.projectId,
      ticket: tv?.value,
      rule,
      rulesVersion: version,
      summary: input.summary,
      detail: input.detail,
      proposed: input.proposed,
      actor,
      allTickets: all,
      members,
      humanSeats: humans,
      now: this.now(),
    });
    const [en] = await this.store.nextIds('escalation');
    const escalation: Escalation = { ...plan.escalation, id: prefixedId('E', en) };
    let decision: Decision | undefined;
    if (plan.decision) {
      const [dn] = await this.store.nextIds('decision');
      decision = { ...plan.decision, id: prefixedId('D', dn), escalationId: escalation.id };
      escalation.decisionId = decision.id;
    }
    const parks = Boolean(tv && plan.parkTicket && PARKABLE.includes(tv.value.status));
    if (parks) escalation.parksTicket = true;
    const ops: TxItem[] = [this.store.putNew(K.escalation(escalation), escalation)];
    if (decision) ops.push(this.store.putNew(K.decision(decision), decision));
    const events: EnvelopeInput[] = [
      this.ev(actor, {
        type: 'escalation.raised',
        summary: `${escalation.id} ${rule.code} ${rule.name} [${rule.severity}] from ${actor.seatId}${escalation.ticketId ? ` on ${escalation.ticketId}` : ''}: ${input.summary}`,
        projectId: input.projectId,
        ticketId: escalation.ticketId,
        to: rule.notify === 'humans' || rule.resolver === 'any_human' ? 'humans' : undefined,
        data: { escalationId: escalation.id, ruleCode: rule.code, resolver: rule.resolver, severity: rule.severity, deadline: escalation.deadline },
      }),
    ];
    if (decision)
      events.push(
        this.ev(actor, {
          type: 'decision.opened',
          summary: `VOTE ${decision.id} by ${new Date(decision.deadline).toISOString().slice(11, 16)}Z: ${decision.question}`,
          projectId: input.projectId,
          data: { decisionId: decision.id, eligible: decision.eligible, options: decision.options, deadline: decision.deadline },
        }),
      );
    if (tv && parks) {
      const t = tv.value;
      const parked: Ticket = { ...t, status: transition(t, 'park'), booking: undefined, log: this.log(t, actor, `parked by ${escalation.id}`), updatedAt: this.now(), version: tv.v + 1 };
      ops.push(this.store.put(K.ticket(parked), parked, tv.v), ...this.lockOps(t, 'delete'));
      events.push(this.ev(actor, { type: 'ticket.blocked', summary: `${t.id} parked by ${escalation.id} (${rule.code})`, projectId: t.projectId, ticketId: t.id }));
    }
    await this.store.commit(ops, events);
    return { escalation, decision };
  }

  private async unparkOps(esc: Escalation, actor: Actor | 'system'): Promise<{ ops: TxItem[]; events: EnvelopeInput[] }> {
    if (!esc.ticketId) return { ops: [], events: [] };
    const tv = await this.store.get<Ticket>(K.ticketPk(esc.ticketId));
    if (!tv || tv.value.status !== 'blocked') return { ops: [], events: [] };
    const stillParked = (await this.escalationsV(OPEN_ESC_STATUSES)).some((e) => e.value.id !== esc.id && e.value.ticketId === esc.ticketId && e.value.parksTicket);
    if (stillParked) return { ops: [], events: [] };
    const t = tv.value;
    const next: Ticket = { ...t, status: transition(t, 'unpark'), booking: undefined, log: this.log(t, actor, `unparked: ${esc.id} closed`), updatedAt: this.now(), version: tv.v + 1 };
    return {
      ops: [this.store.put(K.ticket(next), next, tv.v)],
      events: [this.ev(actor, { type: 'ticket.ready', summary: `${t.id} ready again (${esc.id} closed): ${t.title}`, projectId: t.projectId, ticketId: t.id, data: { lanes: t.lanes } })],
    };
  }

  private escPut(prev: Versioned<Escalation>, next: Escalation): TxItem[] {
    return [this.store.put(K.escalation(next), next, prev.v)];
  }

  async answer(actor: Actor, id: string, body: unknown): Promise<Escalation> {
    const { text } = parse(answerSchema, body);
    const ev = await this.requireEscalation(id);
    const { rules } = await this.rules(ev.value.projectId);
    const rule = findRule(rules, ev.value.ruleCode) ?? fail('not_found', `rule ${ev.value.ruleCode} no longer exists`);
    const next = answerByAgent(ev.value, rule, actor, text, this.now());
    const unpark = await this.unparkOps(next, actor);
    await this.store.commit(
      [...this.escPut(ev, next), ...unpark.ops],
      [
        this.ev(actor, { type: 'escalation.answered', summary: `${id} answered by ${actor.seatId}: ${truncate(text, 120)}`, projectId: next.projectId, ticketId: next.ticketId, to: next.raisedBy, data: { escalationId: id } }),
        ...unpark.events,
      ],
    );
    return next;
  }

  private async resolveCore(actor: Actor, id: string, resolution: string): Promise<Escalation> {
    const ev = await this.requireEscalation(id);
    const [{ rules }, settings] = await Promise.all([this.rules(ev.value.projectId), this.settings()]);
    const rule = findRule(rules, ev.value.ruleCode) ?? fail('not_found', `rule ${ev.value.ruleCode} no longer exists`);
    const next = resolveByHuman(ev.value, rule, actor, resolution, this.now(), settings.value.defaultContestMin);
    const until = next.resolution?.contestUntil ?? this.now();
    await this.store.commit(this.escPut(ev, next), [
      this.ev(actor, {
        type: 'escalation.resolved',
        summary: `${id} resolved by ${actor.seatId} (contest until ${new Date(until).toISOString().slice(11, 16)}Z): ${truncate(resolution, 100)}`,
        projectId: next.projectId,
        ticketId: next.ticketId,
        data: { escalationId: id, contestUntil: until },
      }),
    ]);
    return next;
  }

  async resolve(actor: Actor, id: string, body: unknown): Promise<Escalation> {
    requireHuman(actor);
    const { resolution } = parse(resolveSchema, body);
    return this.resolveCore(actor, id, resolution);
  }

  private async contestCore(actor: Actor, id: string, reason: string): Promise<{ escalation: Escalation; decision: Decision }> {
    const ev = await this.requireEscalation(id);
    const [{ rules }, humans] = await Promise.all([this.rules(ev.value.projectId), this.humanSeatIds()]);
    const rule = findRule(rules, ev.value.ruleCode) ?? fail('not_found', `rule ${ev.value.ruleCode} no longer exists`);
    const r = contestEscalation(ev.value, rule, actor, reason, humans, this.now());
    const [dn] = await this.store.nextIds('decision');
    const decision: Decision = { ...r.decision, id: prefixedId('D', dn) };
    const escalation: Escalation = { ...r.escalation, decisionId: decision.id };
    await this.store.commit(
      [...this.escPut(ev, escalation), this.store.putNew(K.decision(decision), decision)],
      [
        this.ev(actor, { type: 'escalation.contested', summary: `${id} contested by ${actor.seatId}: ${truncate(reason, 120)}`, projectId: escalation.projectId, ticketId: escalation.ticketId, to: 'humans', data: { escalationId: id, decisionId: decision.id } }),
        this.ev(actor, { type: 'decision.opened', summary: `VOTE ${decision.id} (humans): ${decision.question}`, projectId: decision.projectId, to: 'humans', data: { decisionId: decision.id, deadline: decision.deadline } }),
      ],
    );
    return { escalation, decision };
  }

  async contest(actor: Actor, id: string, body: unknown): Promise<{ escalation: Escalation; decision: Decision }> {
    requireHuman(actor);
    const { reason } = parse(contestSchema, body);
    return this.contestCore(actor, id, reason);
  }

  private decPut(prev: Versioned<Decision>, next: Decision): TxItem[] {
    return [this.store.put(K.decision(next), next, prev.v)];
  }

  private async closeDecisionOps(actor: Actor | 'system', prev: Versioned<Decision>, settled: Decision): Promise<{ ops: TxItem[]; events: EnvelopeInput[] }> {
    const ops = this.decPut(prev, settled);
    const events: EnvelopeInput[] = [];
    if (settled.status === 'open') return { ops, events };
    events.push(
      this.ev(actor, {
        type: settled.status === 'made' ? 'decision.made' : 'decision.defaulted',
        summary: `${settled.id} ${settled.status === 'made' ? 'decided' : 'defaulted'}: ${truncate(settled.outcome ?? '', 140)}`,
        projectId: settled.projectId,
        data: { decisionId: settled.id, outcome: settled.outcome, escalationId: settled.escalationId },
      }),
    );
    if (settled.escalationId) {
      const ev = await this.store.get<Escalation>({ PK: `ESC#${settled.escalationId}`, SK: 'META' });
      if (ev && !isClosed(ev.value)) {
        const next = applyDecisionOutcome(ev.value, settled, this.now());
        ops.push(...this.escPut(ev, next));
        events.push(
          this.ev(actor, {
            type: next.status === 'open' ? 'escalation.reopened' : 'escalation.final',
            summary: `${next.id} ${next.status === 'open' ? 'reopened after vote' : `closed: ${truncate(next.resolution?.text ?? '', 120)}`}`,
            projectId: next.projectId,
            ticketId: next.ticketId,
            data: { escalationId: next.id, status: next.status },
          }),
        );
        if (isClosed(next)) {
          const unpark = await this.unparkOps(next, actor);
          ops.push(...unpark.ops);
          events.push(...unpark.events);
        }
      }
    }
    return { ops, events };
  }

  async vote(actor: Actor, id: string, body: unknown): Promise<Decision> {
    const { option, why } = parse(voteSchema, body);
    const dv = await this.requireDecision(id);
    const voted = castVote(dv.value, actor.seatId, actor.kind, option, why, this.now());
    const settled = settle(voted, this.now());
    const close = await this.closeDecisionOps(actor, dv, settled);
    await this.store.commit(close.ops, [
      this.ev(actor, {
        type: 'vote.cast',
        summary: `${actor.seatId} (${actor.kind}) voted "${truncate(option, 60)}" on ${id}${why ? `: ${truncate(why, 80)}` : ''}`,
        projectId: dv.value.projectId,
        data: { decisionId: id, option, by: actor.kind },
      }),
      ...close.events,
    ]);
    return settled;
  }

  // ---------- knowledge ----------

  async share(actor: Actor, body: unknown): Promise<KnowledgeItem> {
    const input = parse(knowledgeCreateSchema, body);
    const text = `${input.name}\n${'body' in input ? input.body : ''}`;
    const findings = scanSecrets(text);
    if (findings.length) fail('invalid', `content looks like it contains secrets (${findings.map((f) => f.type).join(', ')}); remove them and share again`, { findings });
    if (input.kind === 'skill') {
      if (!input.s3Key.startsWith(`skills/${actor.seatId}/${input.name}/`)) fail('invalid', 'use the s3Key returned by /knowledge/skills/upload-url');
      const head = await this.files.inspect(input.s3Key);
      if (!head.exists) fail('invalid', 'upload the skill archive first');
      if (head.bytes > MAX_SKILL_BYTES) {
        await this.files.remove(input.s3Key);
        fail('invalid', `skill archive is ${head.bytes} bytes; the limit is ${MAX_SKILL_BYTES}`);
      }
    }
    if (typeof input.scope === 'object') await this.requireProject(input.scope.projectId);
    const previous = (await this.store.queryGsi<KnowledgeItem>('KNOW', 'active#')).find((k) => k.value.kind === input.kind && k.value.name === input.name);
    const [kn] = await this.store.nextIds('knowledge');
    const item: KnowledgeItem = {
      id: prefixedId('K', kn),
      kind: input.kind,
      name: input.name,
      version: (previous?.value.version ?? 0) + 1,
      author: actor.seatId,
      tags: input.tags,
      scope: input.scope,
      body: 'body' in input ? input.body : undefined,
      s3Key: input.kind === 'skill' ? input.s3Key : undefined,
      status: 'active',
      createdAt: this.now(),
    };
    const ops: TxItem[] = [this.store.putNew(K.knowledge(item), item)];
    if (previous) {
      const retired = { ...previous.value, status: 'retired' as const };
      ops.push(this.store.put(K.knowledge(retired), retired, previous.v));
    }
    const type = input.kind === 'skill' ? (item.version > 1 ? 'skill.updated' : 'skill.published') : `${input.kind}.shared`;
    const label = input.kind === 'skill' ? `c1--${item.name} v${item.version}` : input.kind === 'tip' ? 'Tip' : `Playbook "${item.name}" v${item.version}`;
    const detail = input.kind === 'tip' ? truncate(item.body ?? '', 150) : item.tags.length ? `tags ${item.tags.join(', ')}` : '';
    await this.store.commit(ops, [
      this.ev(actor, {
        type,
        summary: `${label} from ${actor.seatId}${detail ? `: ${detail}` : ''}`,
        projectId: typeof item.scope === 'object' ? item.scope.projectId : undefined,
        data: { knowledgeId: item.id, kind: item.kind, name: item.name, version: item.version },
      }),
    ]);
    return item;
  }

  async skillUploadUrl(actor: Actor, body: unknown): Promise<{ uploadUrl: string; s3Key: string }> {
    const { name } = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/) }).parse(body);
    const s3Key = `skills/${actor.seatId}/${name}/${this.now()}.tgz`;
    return { uploadUrl: await this.files.uploadUrl(s3Key), s3Key };
  }

  async skillDownloadUrl(id: string): Promise<{ url: string; item: KnowledgeItem }> {
    const k = (await this.store.get<KnowledgeItem>({ PK: `KNOW#${id}`, SK: 'META' })) ?? fail('not_found', `knowledge item ${id} not found`);
    if (k.value.kind !== 'skill' || !k.value.s3Key) fail('invalid', `${id} is not a skill`);
    return { url: await this.files.downloadUrl(k.value.s3Key as string), item: k.value };
  }

  async retire(actor: Actor, id: string): Promise<KnowledgeItem> {
    const k = (await this.store.get<KnowledgeItem>({ PK: `KNOW#${id}`, SK: 'META' })) ?? fail('not_found', `knowledge item ${id} not found`);
    if (k.value.author !== actor.seatId && actor.kind !== 'human') fail('forbidden', 'only the author or a human can retire it');
    if (k.value.status === 'retired') return k.value;
    const next = { ...k.value, status: 'retired' as const };
    await this.store.commit(
      [this.store.put(K.knowledge(next), next, k.v)],
      [
        this.ev(actor, {
          type: k.value.kind === 'skill' ? 'skill.retired' : 'knowledge.retired',
          summary: `${k.value.kind} ${k.value.name} v${k.value.version} retired by ${actor.seatId}`,
          projectId: typeof k.value.scope === 'object' ? k.value.scope.projectId : undefined,
          data: { knowledgeId: id, kind: k.value.kind, name: k.value.name },
        }),
      ],
    );
    return next;
  }

  // ---------- messages ----------

  async message(actor: Actor, body: unknown): Promise<void> {
    const m = parse(messageSchema, body);
    const findings = scanSecrets(m.text);
    if (findings.length) fail('invalid', `message looks like it contains secrets (${findings.map((f) => f.type).join(', ')})`);
    if (m.to !== 'all') await this.requireSeat(m.to);
    await this.store.commit([], [
      this.ev(actor, { type: 'message', summary: `${actor.seatId}${m.to === 'all' ? '' : ` → ${m.to}`}: ${m.text}`, to: m.to === 'all' ? undefined : m.to, projectId: m.projectId, data: { text: truncate(m.text, 1500) } }),
    ]);
  }

  // ---------- proposals & human actions ----------

  async propose(actor: Actor, body: unknown): Promise<Record<string, unknown>> {
    const input = parse(proposalSchema, body);
    const payload = parse(actionPayloadSchemas[input.action], input.payload);
    if (actor.kind === 'human') return { executed: true, result: await this.execute(actor, input.action, payload) };
    if (input.action === 'plan.load') await this.precheckPlan(payload as ActionPayloads['plan.load']);
    const [pn] = await this.store.nextIds('proposal');
    const proposal: Proposal = {
      id: prefixedId('P', pn),
      action: input.action,
      payload,
      summary: input.summary || `${input.action} proposed by ${actor.seatId}`,
      proposedBy: actor.seatId,
      status: 'pending',
      createdAt: this.now(),
      expiresAt: this.now() + 24 * 60 * MIN,
    };
    await this.store.commit(
      [this.store.putNew(K.proposal(proposal), proposal)],
      [
        this.ev(actor, {
          type: 'proposal.created',
          summary: `${proposal.id} needs a human: ${proposal.summary}`,
          to: 'humans',
          projectId: (payload as { projectId?: string }).projectId,
          data: { proposalId: proposal.id, action: proposal.action },
        }),
      ],
    );
    const rt = await this.deps.runtime();
    return { executed: false, proposal, approveUrl: `${rt.boardUrl.replace(/\/$/, '')}/#/approve/${proposal.id}` };
  }

  async decideProposal(actor: Actor, id: string, approve: boolean): Promise<Proposal> {
    requireHuman(actor);
    const pv = (await this.store.get<Proposal>({ PK: `PROP#${id}`, SK: 'META' })) ?? fail('not_found', `proposal ${id} not found`);
    if (pv.value.status !== 'pending') fail('conflict', `${id} is ${pv.value.status}`);
    let result: unknown;
    if (approve) result = await this.execute(actor, pv.value.action, pv.value.payload);
    const next: Proposal = { ...pv.value, status: approve ? 'approved' : 'rejected', decidedBy: actor.seatId, result: sanitizeResult(result) };
    await this.store.commit(
      [this.store.put(K.proposal(next), next, pv.v)],
      [
        this.ev(actor, {
          type: approve ? 'proposal.approved' : 'proposal.rejected',
          summary: `${id} ${approve ? 'approved' : 'rejected'} by ${actor.seatId}: ${pv.value.summary}`,
          to: pv.value.proposedBy,
          data: { proposalId: id, action: pv.value.action },
        }),
      ],
    );
    return { ...next, result };
  }

  async directAction(actor: Actor, body: unknown): Promise<unknown> {
    requireHuman(actor);
    const { action, payload } = parse(z.object({ action: proposalSchema.shape.action, payload: z.unknown() }), body);
    return this.execute(actor, action, payload);
  }

  async execute(actor: Actor, action: HumanAction, raw: unknown): Promise<unknown> {
    requireHuman(actor);
    switch (action) {
      case 'project.create':
        return this.projectCreate(actor, parse(actionPayloadSchemas['project.create'], raw));
      case 'project.update':
        return this.projectUpdate(actor, parse(actionPayloadSchemas['project.update'], raw));
      case 'project.status':
        return this.projectStatus(actor, parse(actionPayloadSchemas['project.status'], raw));
      case 'project.phase':
        return this.projectPhase(actor, parse(actionPayloadSchemas['project.phase'], raw));
      case 'goal.set':
        return this.goalSet(actor, parse(actionPayloadSchemas['goal.set'], raw));
      case 'plan.load':
        return this.planLoad(actor, parse(actionPayloadSchemas['plan.load'], raw));
      case 'rules.set':
        return this.rulesSet(actor, parse(actionPayloadSchemas['rules.set'], raw), undefined);
      case 'rules.override': {
        const p = parse(actionPayloadSchemas['rules.override'], raw);
        return this.rulesSet(actor, { code: p.code, patch: p.patch }, p.projectId);
      }
      case 'escalation.resolve': {
        const p = parse(actionPayloadSchemas['escalation.resolve'], raw);
        return this.resolveCore(actor, p.escalationId, p.resolution);
      }
      case 'escalation.contest': {
        const p = parse(actionPayloadSchemas['escalation.contest'], raw);
        return this.contestCore(actor, p.escalationId, p.reason);
      }
      case 'settings.set':
        return this.settingsSet(actor, parse(actionPayloadSchemas['settings.set'], raw));
      case 'token.worker':
        return this.createWorkerToken(actor, parse(actionPayloadSchemas['token.worker'], raw).workerId);
      case 'release.publish':
        return this.releasePublish(actor, parse(actionPayloadSchemas['release.publish'], raw));
    }
  }

  private async openFloorRecord(actor: Actor, projectId: string, summary: string): Promise<{ ops: TxItem[]; events: EnvelopeInput[] }> {
    const [{ version, rules }, settings] = await Promise.all([this.rules(projectId), this.settings()]);
    const rule = findRule(rules, 'B5');
    if (!rule) return { ops: [], events: [] };
    const now = this.now();
    const [en] = await this.store.nextIds('escalation');
    const esc: Escalation = {
      id: prefixedId('E', en),
      kind: 'issue',
      projectId,
      ruleCode: 'B5',
      ruleVersion: version,
      summary,
      detail: summary,
      status: 'resolved_pending_contest',
      raisedBy: actor.seatId,
      raisedByKind: 'human',
      resolution: { text: summary, by: actor.seatId, at: now, contestUntil: now + (rule.contestMin ?? settings.value.defaultContestMin) * MIN },
      createdAt: now,
    };
    return {
      ops: [this.store.putNew(K.escalation(esc), esc)],
      events: [
        this.ev(actor, {
          type: 'escalation.resolved',
          summary: `${esc.id} B5 open-floor change by ${actor.seatId} (contestable until ${new Date(esc.resolution?.contestUntil ?? now).toISOString().slice(11, 16)}Z): ${truncate(summary, 100)}`,
          projectId,
          to: 'humans',
          data: { escalationId: esc.id, contestUntil: esc.resolution?.contestUntil },
        }),
      ],
    };
  }

  private async projectCreate(actor: Actor, p: ActionPayloads['project.create']): Promise<Project> {
    const id = p.id ?? slugify(p.name);
    const project: Project = {
      id,
      name: p.name,
      repos: p.repos.map((r) => normalizeRepo(r, id)),
      lanes: p.lanes,
      status: 'active',
      phase: 'plan',
      goalVersion: 0,
      createdBy: actor.seatId,
      createdAt: this.now(),
      ...(p.description ? { description: p.description } : {}),
      ...(p.demo ? { demo: p.demo } : {}),
      links: p.links,
      tags: p.tags,
    };
    try {
      await this.store.commit(
        [this.store.putNew(K.project(id), project)],
        [this.ev(actor, { type: 'project.created', summary: `Project ${p.name} (${id}) created by ${actor.seatId}`, data: { projectId: id, repos: p.repos.map((r) => r.name) } })],
      );
    } catch (e) {
      if (e instanceof DomainError && e.code === 'conflict') fail('conflict', `project ${id} already exists`);
      throw e;
    }
    return project;
  }

  private async projectUpdate(actor: Actor, p: ActionPayloads['project.update']): Promise<Project> {
    const pv = await this.requireProject(p.projectId);
    if (p.repos) {
      const keep = new Set(p.repos.map((r) => r.name));
      const removed = pv.value.repos.filter((r) => !keep.has(r.name)).map((r) => r.name);
      if (removed.length) {
        const inUse = (await this.tickets(p.projectId)).filter((t) => removed.includes(t.repo) && isActive(t));
        if (inUse.length) fail('conflict', `repo ${[...new Set(inUse.map((t) => t.repo))].join(', ')} still has active tickets: ${inUse.map((t) => t.id).join(', ')}`);
      }
    }
    const next: Project = {
      ...pv.value,
      name: p.name ?? pv.value.name,
      repos: p.repos ? p.repos.map((r) => normalizeRepo(r, pv.value.id)) : pv.value.repos,
      lanes: p.lanes ?? pv.value.lanes,
      description: p.description ?? pv.value.description,
      demo: p.demo ?? pv.value.demo,
      links: p.links ?? pv.value.links,
      tags: p.tags ?? pv.value.tags,
    };
    await this.store.commit([this.store.put(K.project(next.id), next, pv.v)], [
      this.ev(actor, { type: 'project.updated', summary: `Project ${next.id} updated by ${actor.seatId}`, projectId: next.id }),
    ]);
    return next;
  }

  private async projectStatus(actor: Actor, p: ActionPayloads['project.status']): Promise<Project> {
    const pv = await this.requireProject(p.projectId);
    const next: Project = { ...pv.value, status: p.status };
    const floor = p.status === 'archived' ? await this.openFloorRecord(actor, next.id, `Archive project ${next.id}`) : { ops: [], events: [] };
    await this.store.commit([this.store.put(K.project(next.id), next, pv.v), ...floor.ops], [
      this.ev(actor, { type: p.status === 'archived' ? 'project.archived' : 'project.status', summary: `Project ${next.id} is now ${p.status} (${actor.seatId})`, projectId: next.id }),
      ...floor.events,
    ]);
    return next;
  }

  private async projectPhase(actor: Actor, p: ActionPayloads['project.phase']): Promise<Project> {
    const pv = await this.requireProject(p.projectId);
    const next: Project = { ...pv.value, phase: p.phase };
    await this.store.commit([this.store.put(K.project(next.id), next, pv.v)], [
      this.ev(actor, { type: 'phase.changed', summary: `${next.id} phase → ${p.phase} (${actor.seatId})`, projectId: next.id, data: { phase: p.phase } }),
    ]);
    return next;
  }

  private async goalSet(actor: Actor, p: ActionPayloads['goal.set']): Promise<Goal> {
    const pv = await this.requireProject(p.projectId);
    const version = pv.value.goalVersion + 1;
    const goal: Goal = {
      projectId: p.projectId,
      version,
      statement: p.statement,
      definitionOfDone: p.definitionOfDone,
      demoScript: p.demoScript,
      nonGoals: p.nonGoals,
      contact: p.contact ?? actor.seatId,
      createdBy: actor.seatId,
      createdAt: this.now(),
    };
    const floor = version > 1 ? await this.openFloorRecord(actor, p.projectId, `Goal v${version}: ${p.statement}`) : { ops: [], events: [] };
    await this.store.commit(
      [this.store.put(K.project(pv.value.id), { ...pv.value, goalVersion: version }, pv.v), this.store.putNew(K.goal(p.projectId, version), goal), ...floor.ops],
      [this.ev(actor, { type: 'goal.set', summary: `${p.projectId} goal v${version} by ${actor.seatId}: ${p.statement}`, projectId: p.projectId, data: { version } }), ...floor.events],
    );
    return goal;
  }

  private async precheckPlan(p: ActionPayloads['plan.load']): Promise<void> {
    const pv = await this.requireProject(p.projectId);
    const existing = (await this.ticketsV(p.projectId)).map((t) => t.value);
    let i = 0;
    const result = validatePlan(p.tickets, existing, pv.value.repos, () => `T-new-${++i}`);
    if (result.errors.length) fail('invalid', `plan rejected: ${result.errors.join('; ')}`, { errors: result.errors });
  }

  private async planLoad(actor: Actor, p: ActionPayloads['plan.load']): Promise<{ created: string[]; updated: string[] }> {
    const pv = await this.requireProject(p.projectId);
    const existingV = await this.ticketsV(p.projectId);
    const existing = existingV.map((t) => t.value);
    const newCount = p.tickets.filter((t) => !(t.id && existing.some((e) => e.id === t.id))).length;
    const ids = newCount ? await this.store.nextIds('ticket', newCount) : [];
    let i = 0;
    const result = validatePlan(p.tickets, existing, pv.value.repos, () => prefixedId('T', ids[i++]));
    if (result.errors.length) fail('invalid', `plan rejected: ${result.errors.join('; ')}`, { errors: result.errors });
    const ops: TxItem[] = [];
    for (const pt of result.tickets) {
      if (pt.isNew) {
        const t = this.ticketFromInput(pt.id, p.projectId, pt.input, actor, pt.input.status ?? 'ready', pt.deps);
        ops.push(this.store.putNew(K.ticket(t), t));
      } else {
        const prev = existingV.find((e) => e.value.id === pt.id) as Versioned<Ticket>;
        const input = pt.input;
        const status = prev.value.status === 'planned' && input.status ? input.status : prev.value.status;
        if (isActive(prev.value) && JSON.stringify(prev.value.pathsOwned) !== JSON.stringify(input.pathsOwned))
          fail('conflict', `${pt.id} is ${prev.value.status}; release it before changing its owned paths`);
        const t: Ticket = {
          ...prev.value,
          repo: input.repo,
          title: input.title,
          description: input.description,
          type: input.type,
          lanes: input.lanes,
          deps: pt.deps,
          pathsOwned: input.pathsOwned,
          pathsRead: input.pathsRead,
          acceptance: input.acceptance,
          priority: input.priority,
          wave: input.wave,
          dodRefs: input.dodRefs,
          status,
          log: this.log(prev.value, actor, 'updated by plan'),
          updatedAt: this.now(),
          version: prev.v + 1,
        };
        ops.push(this.store.put(K.ticket(t), t, prev.v));
      }
    }
    const created = result.tickets.filter((t) => t.isNew).map((t) => t.id);
    const updated = result.tickets.filter((t) => !t.isNew).map((t) => t.id);
    await this.store.commitChunked(chunk(ops, 90), [
      this.ev(actor, {
        type: 'plan.loaded',
        summary: `${p.projectId} plan loaded by ${actor.seatId}: ${created.length} new, ${updated.length} updated tickets`,
        projectId: p.projectId,
        data: { created, updated },
      }),
    ]);
    return { created, updated };
  }

  private async rulesSet(actor: Actor, p: ActionPayloads['rules.set'], projectId: string | undefined): Promise<{ version: number; rule: BlockerRule }> {
    if (projectId) await this.requireProject(projectId);
    const sv = await this.settings();
    const version = sv.value.rulesVersion + 1;
    const keys = projectId ? K.projectRule(projectId, p.code) : K.hubRule(p.code);
    const prev = await this.store.get<StoredRule>(keys);
    const stored: StoredRule = { code: p.code, patch: { ...(prev?.value.patch ?? {}), ...p.patch }, version };
    const merged = mergeRules(
      projectId ? (await this.store.queryPk<StoredRule>('HUB', 'RULE#')).map((r) => r.value) : [stored, ...(await this.store.queryPk<StoredRule>('HUB', 'RULE#')).map((r) => r.value).filter((r) => r.code !== p.code)],
      projectId ? [stored, ...(await this.store.queryPk<StoredRule>(`PROJECT#${projectId}`, 'RULE#')).map((r) => r.value).filter((r) => r.code !== p.code)] : [],
    );
    const rule = findRule(merged, p.code) ?? fail('invalid', `rule ${p.code} does not exist; a new rule needs name, trigger, severity, resolver, defaultOnTimeout, stopScope and notify`);
    await this.store.commit(
      [this.store.put(K.settings(), { ...sv.value, rulesVersion: version }, sv.v), this.store.put(keys, stored, prev?.v ?? 0)],
      [
        this.ev(actor, {
          type: 'rules.updated',
          summary: `RULES v${version}: ${p.code} changed${projectId ? ` for ${projectId}` : ''} by ${actor.seatId} (${Object.keys(p.patch).join(', ')})`,
          projectId,
          data: { version, code: p.code, patch: p.patch },
        }),
      ],
    );
    return { version, rule };
  }

  private async settingsSet(actor: Actor, p: ActionPayloads['settings.set']): Promise<Settings> {
    const sv = await this.settings();
    const next: Settings = {
      ...sv.value,
      leaseTtlSec: p.leaseTtlSec ?? sv.value.leaseTtlSec,
      defaultContestMin: p.defaultContestMin ?? sv.value.defaultContestMin,
      maxBookingsPerSeat: p.maxBookingsPerSeat === null ? undefined : (p.maxBookingsPerSeat ?? sv.value.maxBookingsPerSeat),
      toolRepoUrl: p.toolRepoUrl === null ? undefined : (p.toolRepoUrl ?? sv.value.toolRepoUrl),
    };
    await this.store.commit([this.store.put(K.settings(), next, sv.v)], [
      this.ev(actor, { type: 'settings.updated', summary: `Hub settings changed by ${actor.seatId}`, data: { ...next } }),
    ]);
    return next;
  }

  // ---------- CollabOne fix queue and releases ----------

  async currentRelease(): Promise<Release | undefined> {
    const now = this.now();
    if (this.releaseCache && now - this.releaseCache.at < RELEASE_CACHE_MS) return this.releaseCache.value;
    const value = (await this.store.get<Release>(K.release()))?.value;
    this.releaseCache = { at: now, value };
    return value;
  }

  /** Throws update_required when an agent below the published minimum version tries to change anything. */
  async requireClientVersion(actor: Actor, clientVersion: string | undefined): Promise<void> {
    if (actor.kind !== 'agent') return;
    const rel = await this.currentRelease();
    if (!rel?.minimum) return;
    const client = clientVersion ?? '0.0.0';
    if (compareVersions(client, rel.minimum) < 0)
      fail('update_required', `CollabOne ${client} is too old for this hub: update to ${rel.latest} with /c1:update (minimum ${rel.minimum})`, { client, minimum: rel.minimum, latest: rel.latest });
  }

  private async releasePublish(actor: Actor, p: ActionPayloads['release.publish']): Promise<Release> {
    if (p.minimum && compareVersions(p.minimum, p.version) > 0) fail('invalid', `minimum ${p.minimum} is newer than the release ${p.version}`);
    const prev = await this.store.get<Release>(K.release());
    if (prev && compareVersions(p.version, prev.value.latest) <= 0) fail('conflict', `${p.version} is not newer than the published ${prev.value.latest}`);
    const minimum = p.minimum ?? prev?.value.minimum;
    const next: Release = { latest: p.version, ...(minimum ? { minimum } : {}), notes: p.notes, publishedAt: this.now(), by: actor.seatId };
    await this.store.commit(
      [prev ? this.store.put(K.release(), next, prev.v) : this.store.putNew(K.release(), next)],
      [
        this.ev(actor, {
          type: 'tool.released',
          summary: `CollabOne ${p.version} released${p.minimum ? ` (required: update before your next change)` : ''}: ${truncate(p.notes, 140)}`,
          data: { version: p.version, minimum: minimum ?? null, notes: p.notes },
        }),
      ],
    );
    this.releaseCache = { at: this.now(), value: next };
    return next;
  }

  private async ensureToolProject(actor: Actor): Promise<void> {
    if (await this.store.get<Project>(K.project(TOOL_PROJECT_ID))) return;
    const url = (await this.settings()).value.toolRepoUrl ?? this.deps.toolRepoUrl;
    if (!url) fail('invalid', 'the fix queue needs the CollabOne repo URL: an organizer sets it in the board (Settings → CollabOne repo)');
    try {
      await this.projectCreate(actor, {
        id: TOOL_PROJECT_ID,
        name: 'CollabOne fixes',
        repos: [toolRepo(url as string)] as ActionPayloads['project.create']['repos'],
        lanes: ['plugin', 'board', 'backend', 'docs'],
        description: 'Problems with CollabOne itself, reported from any session with /c1:bug. Pin to this project to fix them.',
        links: [],
        tags: ['tooling'],
      });
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'conflict')) throw e;
    }
  }

  async fileToolBug(actor: Actor, body: unknown): Promise<Ticket> {
    const b = parse(toolBugSchema, body);
    const findings = scanSecrets(`${b.summary}\n${b.detail}`);
    if (findings.length) fail('invalid', `the report looks like it contains secrets (${findings.map((f) => f.type).join(', ')}); remove them and report again`, { findings });
    await this.ensureToolProject(actor);
    const area = TOOL_AREAS[b.area];
    const reporter = actor.workerId ? `${actor.seatId}/${actor.workerId}` : actor.seatId;
    const description = [b.detail, `Reported by ${reporter} (${actor.kind})${b.ticketId ? ` while working on ${b.ticketId}` : ''}. Area: ${b.area}.`].filter(Boolean).join('\n\n');
    return this.createTicket(actor, TOOL_PROJECT_ID, {
      repo: 'collab1',
      title: `Fix: ${b.summary}`,
      description,
      type: 'chore',
      lanes: area.lanes,
      pathsOwned: area.paths,
      acceptance: [{ criterion: 'The reported problem no longer happens and a test covers it', ...(area.check ? { cmd: area.check } : {}) }],
      priority: b.urgent ? 1 : 50,
      status: 'ready',
    });
  }

  // ---------- board & events ----------

  async board(projectId?: string): Promise<Record<string, unknown>> {
    const [projects, seats, escalations, decisions, proposals, knowledge, settings, lastSeq] = await Promise.all([
      this.projects(),
      this.seats(),
      this.escalations('open'),
      this.decisions('open'),
      this.proposals('pending'),
      this.knowledge('active'),
      this.settings(),
      this.store.lastSeq(),
    ]);
    const perProject = await Promise.all(projects.map(async (p) => ({ p, tickets: await this.tickets(p.id) })));
    const selected = projectId ?? projects.find((p) => p.status === 'active')?.id ?? projects[0]?.id;
    const sel = perProject.find((x) => x.p.id === selected);
    const goal = sel && sel.p.goalVersion ? (await this.store.get<Goal>(K.goal(sel.p.id, sel.p.goalVersion)))?.value : undefined;
    return {
      lastSeq,
      settings: settings.value,
      projects: perProject.map(({ p, tickets }) => ({
        ...p,
        counts: tickets.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {}),
        total: tickets.filter((t) => t.status !== 'dropped').length,
        done: tickets.filter((t) => t.status === 'done').length,
        openEscalations: escalations.filter((e) => e.projectId === p.id).length,
        openDecisions: decisions.filter((d) => d.projectId === p.id).length,
        members: seats.filter((s) => s.projects.includes(p.id)).map((s) => s.id),
      })),
      projectId: selected,
      project: sel?.p,
      goal,
      tickets: sel?.tickets ?? [],
      seats: seats.map(({ cognitoSub: _sub, ...s }) => ({ ...s, human: Boolean(_sub) })),
      escalations,
      decisions,
      proposals,
      knowledge: knowledge.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30),
    };
  }

  async events(actor: Actor, since: number, limit: number): Promise<{ events: unknown[]; lastSeq: number }> {
    const events = await this.store.events(since, Math.min(Math.max(limit, 1), 500));
    const visible = events.filter((e) => !e.to || e.to === 'all' || e.to === 'humans' || e.to === actor.seatId);
    return { events: visible, lastSeq: events.length ? events[events.length - 1].seq : since };
  }

  // ---------- sweep ----------

  async sweep(): Promise<Record<string, number>> {
    const now = this.now();
    const stats = { leases: 0, reviews: 0, decisions: 0, escalations: 0, proposals: 0 };
    const projects = await this.projects();
    for (const p of projects) {
      for (const tv of await this.ticketsV(p.id)) {
        const t = tv.value;
        try {
          if ((t.status === 'booked' || t.status === 'in_progress') && t.booking && t.booking.leaseExpiresAt < now) {
            const next: Ticket = { ...t, status: 'ready', booking: undefined, log: this.log(t, 'system', `lease of ${t.booking.seatId} expired`), updatedAt: now, version: tv.v + 1 };
            await this.store.commit([this.store.put(K.ticket(next), next, tv.v), ...this.lockOps(t, 'delete')], [
              this.ev('system', { type: 'ticket.released', summary: `${t.id} lease expired (${t.booking.seatId}); ready again: ${t.title}`, projectId: t.projectId, ticketId: t.id, data: { reason: 'lease_expired', lanes: t.lanes } }),
            ]);
            stats.leases++;
          } else if (t.status === 'review' && t.review && t.review.leaseExpiresAt < now) {
            const next: Ticket = { ...t, review: undefined, log: this.log(t, 'system', `review lease of ${t.review.seatId} expired`), updatedAt: now, version: tv.v + 1 };
            await this.store.commit([this.store.put(K.ticket(next), next, tv.v)], [
              this.ev('system', { type: 'ticket.review_needed', summary: `${t.id} needs a reviewer again (lease expired): ${t.title}`, projectId: t.projectId, ticketId: t.id }),
            ]);
            stats.reviews++;
          }
        } catch (e) {
          if (!(e instanceof DomainError && e.code === 'conflict')) throw e;
        }
      }
    }
    for (const d of await this.store.queryGsi<Decision>('DECS', 'open#')) {
      const settled = settle(d.value, now);
      if (settled.status === 'open') continue;
      try {
        const close = await this.closeDecisionOps('system', d, settled);
        await this.store.commit(close.ops, close.events);
        stats.decisions++;
      } catch (e) {
        if (!(e instanceof DomainError && e.code === 'conflict')) throw e;
      }
    }
    const rulesCache = new Map<string, BlockerRule[]>();
    for (const ev of await this.escalationsV(['open', 'resolved_pending_contest'])) {
      const pid = ev.value.projectId;
      if (!rulesCache.has(pid)) rulesCache.set(pid, (await this.rules(pid)).rules);
      const rule = findRule(rulesCache.get(pid) as BlockerRule[], ev.value.ruleCode);
      if (!rule) continue;
      const out = sweepEscalation(ev.value, rule, now);
      if (out.kind === 'none') continue;
      try {
        const unpark = out.kind === 'to_humans' ? { ops: [], events: [] } : await this.unparkOps(out.escalation, 'system');
        const type = out.kind === 'finalized' ? 'escalation.final' : out.kind === 'defaulted' ? 'escalation.defaulted' : 'escalation.to_humans';
        const summary =
          out.kind === 'to_humans'
            ? `${ev.value.id} ${rule.code} not answered by agents in time; any human can resolve it now: ${ev.value.summary}`
            : `${ev.value.id} closed (${out.kind}): ${truncate(out.escalation.resolution?.text ?? '', 120)}`;
        await this.store.commit([...this.escPut(ev, out.escalation), ...unpark.ops], [
          this.ev('system', { type, summary, projectId: pid, ticketId: ev.value.ticketId, to: out.kind === 'to_humans' ? 'humans' : undefined, data: { escalationId: ev.value.id } }),
          ...unpark.events,
        ]);
        stats.escalations++;
      } catch (e) {
        if (!(e instanceof DomainError && e.code === 'conflict')) throw e;
      }
    }
    for (const pv of await this.store.queryGsi<Proposal>('PROPS', 'pending#')) {
      if (pv.value.expiresAt > now) continue;
      const next = { ...pv.value, status: 'expired' as const };
      try {
        await this.store.commit([this.store.put(K.proposal(next), next, pv.v)], [
          this.ev('system', { type: 'proposal.expired', summary: `${pv.value.id} expired without a human decision: ${pv.value.summary}`, to: pv.value.proposedBy }),
        ]);
        stats.proposals++;
      } catch (e) {
        if (!(e instanceof DomainError && e.code === 'conflict')) throw e;
      }
    }
    return stats;
  }
}

const sanitizeResult = (result: unknown): unknown => {
  if (result && typeof result === 'object' && 'token' in (result as Record<string, unknown>)) {
    const { token: _t, ...rest } = result as Record<string, unknown>;
    return { ...rest, token: '(shown once to the approver)' };
  }
  return result;
};
