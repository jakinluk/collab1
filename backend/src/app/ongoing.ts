import type { z } from 'zod';
import type {
  Acceptance,
  Actor,
  ChangeRequest,
  ChangeTicket,
  DecisionRecord,
  EnvelopeInput,
  EpicInfo,
  Goal,
  ImpactEntry,
  Input,
  InputVersion,
  Milestone,
  Project,
  Repo,
  ScopePatch,
  Ticket,
  Verdict,
} from '../shared/types';
import { type ActionPayloads, changeAssessSchema, changeCreateSchema, inputCreateSchema, inputVersionSchema, repoSchema } from '../shared/schemas';
import { DomainError, fail } from '../core/errors';
import { truncate } from '../core/envelope';
import { prefixedId } from '../core/ids';
import { normalizeRepo, protectedPathErrors } from '../core/repos';
import { isActive } from '../core/tickets';
import { scanSecrets } from '../core/secrets';
import {
  assertEpicMove,
  assignDodIds,
  type CandidateQuery,
  defaultEpic,
  diffSections,
  dodOf,
  impactCandidates,
  parseRef,
  parseSections,
  refCovers,
} from '../core/ongoing';
import { needsHumanForChange } from '../core/gates';
import { K } from '../adapters/keys';
import type { TxItem, Versioned } from '../adapters/store';
import type { Hub } from './hub';

const DONE_VERDICTS: readonly Verdict[] = ['keep', 'rework', 'revert'];
const OPEN_VERDICTS: readonly Verdict[] = ['keep', 'amend', 'supersede', 'obsolete', 'defer'];
const OPEN_CHANGE: readonly ChangeRequest['status'][] = ['assessing', 'proposed'];
const BRIEF_SECTION_CHARS = 1500;

const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new DomainError('invalid', issues.join('; '), { issues });
  }
  return r.data;
};

interface OpenSpec {
  /** Ingestion: open the change request even when no ticket cites what changed, so an agent re-plans the epic. */
  ingest?: boolean;
  title: string;
  reason: string;
  trigger: ChangeRequest['trigger'];
  addedRefs?: string[];
  scope?: ScopePatch;
  query?: ChangeRequest['query'];
}

/** Ongoing mode: repo catalog, epics, inputs, decision records and change requests. */
export class OngoingMode {
  constructor(private readonly hub: Hub) {}

  private get store() {
    return this.hub.store;
  }

  private now(): number {
    return this.hub.now();
  }

  private requireOngoing(): void {
    if (this.hub.mode !== 'ongoing') fail('invalid', 'this needs a hub in ongoing mode (deploy with -c mode=ongoing)');
  }

  // ---------- repo catalog ----------

  async catalog(): Promise<Repo[]> {
    return (await this.store.queryPk<Repo>('HUB', 'REPO#')).map((r) => r.value);
  }

  async catalogRepos(names: readonly string[]): Promise<Repo[]> {
    this.requireOngoing();
    return Promise.all(
      names.map(async (n) => ({ ...((await this.store.get<Repo>(K.catalogRepo(n)))?.value ?? fail('invalid', `repo ${n} is not in the catalog; add it first (c1 repo-catalog propose)`)), fromCatalog: true })),
    );
  }

  async repoSet(actor: Actor, p: ActionPayloads['repo.set']): Promise<Repo> {
    this.requireOngoing();
    const input = parse(repoSchema, p);
    const repo: Repo = { ...normalizeRepo(input, ''), integrationBranch: input.integrationBranch ?? input.baseBranch, fromCatalog: true };
    const prev = await this.store.get<Repo>(K.catalogRepo(repo.name));
    await this.store.commit([this.store.put(K.catalogRepo(repo.name), repo, prev?.v ?? 0)], [
      this.hub.ev(actor, { type: 'repo.cataloged', summary: `Repo ${repo.name} ${prev ? 'updated' : 'added to the catalog'} by ${actor.seatId}`, data: { repo: repo.name } }),
    ]);
    for (const pv of await this.store.queryGsi<Project>('PROJECTS')) {
      if (pv.value.epic?.state === 'archived' || !pv.value.repos.some((r) => r.name === repo.name && r.fromCatalog)) continue;
      const next = { ...pv.value, repos: pv.value.repos.map((r) => (r.name === repo.name && r.fromCatalog ? repo : r)) };
      await this.store.commit([this.store.put(K.project(next.id), next, pv.v)]);
    }
    return repo;
  }

  async repoRemove(actor: Actor, p: ActionPayloads['repo.remove']): Promise<{ removed: string }> {
    this.requireOngoing();
    const prev = (await this.store.get<Repo>(K.catalogRepo(p.name))) ?? fail('not_found', `repo ${p.name} is not in the catalog`);
    const users = (await this.hub.projects()).filter((x) => x.epic?.state !== 'archived' && x.repos.some((r) => r.name === p.name && r.fromCatalog));
    if (users.length) fail('conflict', `repo ${p.name} is used by open epics: ${users.map((u) => u.id).join(', ')}`);
    await this.store.commit([this.store.delete(K.catalogRepo(p.name), prev.v)], [
      this.hub.ev(actor, { type: 'repo.removed', summary: `Repo ${p.name} removed from the catalog by ${actor.seatId}`, data: { repo: p.name } }),
    ]);
    return { removed: p.name };
  }

  // ---------- epics ----------

  async epicUpdate(actor: Actor, p: ActionPayloads['epic.update']): Promise<Project> {
    this.requireOngoing();
    const pv = await this.hub.requireProject(p.projectId);
    const was: EpicInfo = pv.value.epic ?? defaultEpic(pv.value.createdBy);
    if (actor.kind === 'agent') {
      const needsHuman = [
        ...(p.targetDate !== undefined && was.targetDate && p.targetDate !== was.targetDate ? ['moves the target date'] : []),
        ...(p.state === 'archived' ? ['archives the epic'] : []),
        ...(p.owners ? ['changes the owners'] : []),
      ];
      if (needsHuman.length) fail('forbidden', `this epic change needs a human: it ${needsHuman.join('; ')}`, { needsHuman });
    }
    const next: EpicInfo = { ...was };
    const events: EnvelopeInput[] = [];
    const ops: TxItem[] = [];
    if (p.state && p.state !== was.state) {
      assertEpicMove(was.state, p.state);
      next.state = p.state;
      if (p.state === 'paused') next.pausedAt = this.now();
      else delete next.pausedAt;
      events.push(this.hub.ev(actor, { type: 'epic.state_changed', summary: `Epic ${pv.value.id}: ${was.state} → ${p.state} (${actor.seatId})`, projectId: pv.value.id, data: { from: was.state, to: p.state } }));
    }
    if (p.startDate !== undefined) next.startDate = p.startDate ?? undefined;
    if (p.targetDate !== undefined && p.targetDate !== (was.targetDate ?? null)) {
      next.targetDate = p.targetDate ?? undefined;
      if (was.targetDate) {
        if (!p.reason?.trim()) fail('invalid', `moving the target date of ${pv.value.id} needs a reason; it is recorded as a decision`);
        const rec = await this.newRecord(actor, {
          projectId: pv.value.id,
          title: `Target date of ${pv.value.name}`,
          choice: `Move the target date from ${was.targetDate} to ${p.targetDate ?? 'none'}`,
          reason: p.reason as string,
          refs: [],
          source: 'dates',
        });
        ops.push(this.store.putNew(K.record(rec.id), rec));
        events.push(this.recordEvent(actor, rec));
      }
      events.push(this.hub.ev(actor, { type: 'epic.dates_moved', summary: `Epic ${pv.value.id} target date ${was.targetDate ?? 'none'} → ${p.targetDate ?? 'none'}`, projectId: pv.value.id, data: { from: was.targetDate ?? null, to: p.targetDate ?? null } }));
    }
    if (p.milestones) next.milestones = await this.mergeMilestones(pv.value, was.milestones, p.milestones);
    if (p.owners) next.owners = p.owners;
    if (p.priority !== undefined) next.priority = p.priority;
    if (p.decisionMode) next.decisionMode = p.decisionMode;
    const project: Project = { ...pv.value, epic: next, ...(next.state === 'archived' ? { status: 'archived' as const } : pv.value.status === 'archived' ? { status: 'active' as const } : {}) };
    if (events.length === 0) events.push(this.hub.ev(actor, { type: 'epic.updated', summary: `Epic ${pv.value.id} updated by ${actor.seatId}`, projectId: pv.value.id }));
    await this.store.commit([this.store.put(K.project(project.id), project, pv.v), ...ops], events);
    if (was.state === 'paused' && next.state !== 'paused' && was.pausedAt) await this.revalidate(actor, project.id, was.pausedAt);
    return project;
  }

  private async mergeMilestones(project: Project, before: readonly Milestone[], wanted: ActionPayloads['epic.update']['milestones'] & object): Promise<Milestone[]> {
    let n = Math.max(0, ...before.map((m) => Number(m.id.slice(1))));
    const out: Milestone[] = wanted.map((m) => ({
      id: m.id ?? `m${++n}`,
      name: m.name,
      ...(m.targetDate ? { targetDate: m.targetDate } : {}),
      ...(m.done ? { done: true } : {}),
    }));
    const kept = new Set(out.map((m) => m.id));
    const gone = before.filter((m) => !kept.has(m.id)).map((m) => m.id);
    if (gone.length) {
      const users = (await this.hub.tickets(project.id)).filter((t) => t.milestone && gone.includes(t.milestone) && t.status !== 'dropped' && t.status !== 'done');
      if (users.length) fail('conflict', `milestone ${gone.join(', ')} still has open tickets (${users.map((t) => t.id).join(', ')}): open a change request that defers or moves them first`);
    }
    return out;
  }

  /** After a pause, anything the epic cites that changed while it was paused gets a change request before work restarts. */
  private async revalidate(actor: Actor, projectId: string, since: number): Promise<void> {
    const changed: string[] = [];
    for (const iv of await this.store.queryGsi<Input>('INPUTS')) {
      const input = iv.value;
      if (!input.approvedVersion) continue;
      const versions = (await this.store.queryPk<InputVersion>(`INPUT#${input.id}`, 'V#')).map((v) => v.value);
      const approvedSince = versions.filter((v) => v.approvedAt && v.approvedAt > since);
      if (approvedSince.length === 0) continue;
      const before = versions.filter((v) => v.approvedAt && v.approvedAt <= since).sort((a, b) => b.version - a.version)[0];
      const after = versions.find((v) => v.version === input.approvedVersion) as InputVersion;
      if (!before) continue;
      const d = diffSections(before.sections, after.sections);
      changed.push(...[...d.changed, ...d.removed].map((a) => `input:${input.id}#${a}`));
    }
    for (const rv of await this.store.queryGsi<DecisionRecord>('RECS')) {
      const r = rv.value;
      if (r.status === 'superseded' && r.supersededBy) {
        const by = (await this.store.get<DecisionRecord>(K.record(r.supersededBy)))?.value;
        if (by && by.at > since) changed.push(`decision:${r.id}`);
      }
    }
    if (changed.length)
      await this.intakeIfCited(actor, projectId, [...new Set(changed)], {
        title: 'Revalidate after pause',
        reason: `Inputs or decisions this epic cites changed while it was paused: ${[...new Set(changed)].join(', ')}.`,
        trigger: { kind: 'resume' },
      });
  }

  // ---------- refs ----------

  async assertRefs(projectId: string, refs: readonly string[]): Promise<void> {
    let dod: string[] | undefined;
    for (const ref of refs) {
      const r = parseRef(ref);
      if (r.kind === 'dod') {
        dod ??= dodOf(await this.hub.goal(projectId)).map((d) => d.id);
        if (!dod.includes(r.id)) fail('invalid', `${ref}: the current definition of done has no item ${r.id}`);
      } else if (r.kind === 'input') {
        const input = (await this.store.get<Input>(K.input(r.id)))?.value ?? fail('invalid', `${ref}: input ${r.id} not found`);
        if (r.anchor) {
          const v = (await this.store.get<InputVersion>(K.inputVersion(r.id, input.approvedVersion ?? input.latestVersion)))?.value;
          if (!v?.sections.some((s) => s.anchor === r.anchor))
            fail('invalid', `${ref}: input ${r.id} has no section #${r.anchor} (sections: ${(v?.sections ?? []).map((s) => s.anchor).join(', ')})`);
        }
      } else {
        const rec = (await this.store.get<DecisionRecord>(K.record(r.id)))?.value ?? fail('invalid', `${ref}: decision ${r.id} not found`);
        if (rec.status === 'superseded') fail('invalid', `${ref}: decision ${r.id} was superseded by ${rec.supersededBy}`);
      }
    }
  }

  /** The "why" part of a ticket brief: the text of every input section, decision and definition-of-done item it cites. */
  async brief(t: Ticket): Promise<string> {
    const lines: string[] = ['## Why (cited inputs, decisions and definition of done)'];
    const goal = await this.hub.goal(t.projectId).catch(() => undefined);
    for (const ref of t.refs ?? []) {
      const r = parseRef(ref);
      if (r.kind === 'dod') {
        const item = dodOf(goal).find((d) => d.id === r.id);
        lines.push(`- ${ref}: ${item ? item.text : '(no longer in the definition of done)'}`);
      } else if (r.kind === 'decision') {
        const rec = (await this.store.get<DecisionRecord>(K.record(r.id)))?.value;
        lines.push(rec ? `- ${ref} (${rec.status}): ${rec.title} → ${rec.choice}${rec.reason ? `. Why: ${truncate(rec.reason, 400)}` : ''}` : `- ${ref}: (not found)`);
      } else {
        const input = (await this.store.get<Input>(K.input(r.id)))?.value;
        if (!input) {
          lines.push(`- ${ref}: (not found)`);
          continue;
        }
        const version = input.approvedVersion ?? input.latestVersion;
        const v = (await this.store.get<InputVersion>(K.inputVersion(r.id, version)))?.value;
        const sections = v ? parseSections(v.body) : [];
        const picked = r.anchor ? sections.filter((s) => s.anchor === r.anchor) : sections.slice(0, 1);
        lines.push(`- ${ref}: ${input.title} v${version}${input.approvedVersion ? '' : ' (draft)'}`);
        for (const s of picked) lines.push(`  > ${s.title}`, ...truncate(s.text, BRIEF_SECTION_CHARS).split('\n').map((l) => `  > ${l}`));
      }
    }
    return lines.join('\n');
  }

  // ---------- inputs ----------

  async listInputs(projectId?: string): Promise<Input[]> {
    const all = (await this.store.queryGsi<Input>('INPUTS')).map((i) => i.value);
    return projectId ? all.filter((i) => i.projectIds.includes(projectId)) : all;
  }

  async getInput(id: string, version?: number): Promise<{ input: Input; version: InputVersion; versions: Omit<InputVersion, 'body'>[] }> {
    const input = (await this.store.get<Input>(K.input(id)))?.value ?? fail('not_found', `input ${id} not found`);
    const versions = (await this.store.queryPk<InputVersion>(`INPUT#${id}`, 'V#')).map((v) => v.value);
    const want = version ?? input.approvedVersion ?? input.latestVersion;
    const v = versions.find((x) => x.version === want) ?? fail('not_found', `input ${id} has no version ${want}`);
    return { input, version: v, versions: versions.map(({ body: _b, ...rest }) => rest) };
  }

  private scan(text: string): void {
    const findings = scanSecrets(text);
    if (findings.length) fail('invalid', `the input looks like it contains secrets (${findings.map((f) => f.type).join(', ')}); remove them and add it again`, { findings });
  }

  async createInput(actor: Actor, body: unknown): Promise<{ input: Input; version: InputVersion }> {
    this.requireOngoing();
    const p = parse(inputCreateSchema, body);
    this.scan(`${p.title}\n${p.body}`);
    for (const pid of p.projectIds) await this.hub.requireProject(pid);
    const [n] = await this.store.nextIds('input');
    const id = prefixedId('I', n);
    const now = this.now();
    const version: InputVersion = { inputId: id, version: 1, body: p.body, sections: parseSections(p.body).map(({ text: _t, ...s }) => s), status: 'draft', ...(p.note ? { note: p.note } : {}), createdBy: actor.seatId, createdAt: now };
    const input: Input = { id, kind: p.kind, title: p.title, owner: actor.seatId, projectIds: p.projectIds, status: 'draft', latestVersion: 1, createdAt: now, updatedAt: now };
    await this.store.commit([this.store.putNew(K.input(id), input), this.store.putNew(K.inputVersion(id, 1), version)], [
      this.hub.ev(actor, {
        type: 'input.added',
        summary: `${id} ${p.kind} "${p.title}" added by ${actor.seatId} (draft, ${version.sections.length} sections); a human approves it in the board`,
        projectId: p.projectIds[0],
        to: 'humans',
        data: { inputId: id, kind: p.kind, sections: version.sections.map((s) => s.anchor) },
      }),
    ]);
    return { input, version };
  }

  async addVersion(actor: Actor, id: string, body: unknown): Promise<{ input: Input; version: InputVersion; diff: ReturnType<typeof diffSections> }> {
    this.requireOngoing();
    const p = parse(inputVersionSchema, body);
    this.scan(p.body);
    const iv = (await this.store.get<Input>(K.input(id))) ?? fail('not_found', `input ${id} not found`);
    const base = (await this.store.get<InputVersion>(K.inputVersion(id, iv.value.approvedVersion ?? iv.value.latestVersion)))?.value as InputVersion;
    const n = iv.value.latestVersion + 1;
    const version: InputVersion = { inputId: id, version: n, body: p.body, sections: parseSections(p.body).map(({ text: _t, ...s }) => s), status: 'draft', ...(p.note ? { note: p.note } : {}), createdBy: actor.seatId, createdAt: this.now() };
    const diff = diffSections(base.sections, version.sections);
    const input: Input = { ...iv.value, latestVersion: n, updatedAt: this.now() };
    await this.store.commit([this.store.put(K.input(id), input, iv.v), this.store.putNew(K.inputVersion(id, n), version)], [
      this.hub.ev(actor, {
        type: 'input.version_added',
        summary: `${id} v${n} drafted by ${actor.seatId}: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed sections${p.note ? ` (${truncate(p.note, 80)})` : ''}`,
        projectId: input.projectIds[0],
        to: 'humans',
        data: { inputId: id, version: n, diff },
      }),
    ]);
    return { input, version, diff };
  }

  async approveInput(actor: Actor, p: ActionPayloads['input.approve']): Promise<{ input: Input; version: number; diff?: ReturnType<typeof diffSections>; changes: string[] }> {
    this.requireOngoing();
    const iv = (await this.store.get<Input>(K.input(p.inputId))) ?? fail('not_found', `input ${p.inputId} not found`);
    const want = p.version ?? iv.value.latestVersion;
    const vv = (await this.store.get<InputVersion>(K.inputVersion(p.inputId, want))) ?? fail('not_found', `input ${p.inputId} has no version ${want}`);
    if (vv.value.status === 'approved') return { input: iv.value, version: want, changes: [] };
    const prevNo = iv.value.approvedVersion;
    const prev = prevNo ? await this.store.get<InputVersion>(K.inputVersion(p.inputId, prevNo)) : undefined;
    if (prevNo && want < prevNo) fail('conflict', `${p.inputId} v${prevNo} is already approved; add a new version instead of approving an older one`);
    const now = this.now();
    const input: Input = { ...iv.value, status: 'approved', approvedVersion: want, updatedAt: now };
    const ops: TxItem[] = [
      this.store.put(K.input(p.inputId), input, iv.v),
      this.store.put(K.inputVersion(p.inputId, want), { ...vv.value, status: 'approved', approvedBy: actor.seatId, approvedAt: now }, vv.v),
    ];
    if (prev) ops.push(this.store.put(K.inputVersion(p.inputId, prevNo as number), { ...prev.value, status: 'superseded' }, prev.v));
    const diff = prev ? diffSections(prev.value.sections, vv.value.sections) : undefined;
    await this.store.commit(ops, [
      this.hub.ev(actor, {
        type: 'input.version_approved',
        summary: `${p.inputId} "${input.title}" v${want} approved by ${actor.seatId}${diff ? `: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed sections` : ''}`,
        projectId: input.projectIds[0],
        data: { inputId: p.inputId, version: want, previous: prevNo ?? null, diff: diff ?? null },
      }),
    ]);
    const changes: string[] = [];
    const linked = new Set(input.projectIds);
    if (!diff) {
      for (const pid of linked) {
        const cr = await this.intakeIfCited(actor, pid, [], {
          ingest: true,
          title: `Ingest ${input.kind} ${p.inputId}: ${input.title}`,
          reason: `${input.kind.toUpperCase()} ${p.inputId} "${input.title}" v${want} was approved for this epic: plan the tickets it needs, cite its sections, and correct the goal if it moves it.`,
          trigger: { kind: 'ingest', ref: p.inputId, toVersion: want },
          addedRefs: vv.value.sections.map((s) => `input:${p.inputId}#${s.anchor}`),
        });
        if (cr) changes.push(cr.id);
      }
    } else {
      const changedRefs = [...diff.changed, ...diff.removed].map((a) => `input:${p.inputId}#${a}`);
      if (changedRefs.length || diff.added.length)
        for (const project of await this.openEpics()) {
          const cr = await this.intakeIfCited(actor, project.id, changedRefs, {
            ingest: linked.has(project.id),
            title: `${input.title} v${want}`,
            reason: `${input.kind.toUpperCase()} ${p.inputId} "${input.title}" changed from v${prevNo} to v${want}: ${[...diff.changed.map((a) => `#${a} changed`), ...diff.removed.map((a) => `#${a} removed`), ...diff.added.map((a) => `#${a} added`)].join(', ')}.`,
            trigger: { kind: 'input', ref: p.inputId, fromVersion: prevNo, toVersion: want },
            addedRefs: diff.added.map((a) => `input:${p.inputId}#${a}`),
          });
          if (cr) changes.push(cr.id);
        }
    }
    return { input, version: want, diff, changes };
  }

  private async openEpics(): Promise<Project[]> {
    return (await this.hub.projects()).filter((p) => p.status !== 'archived' && p.epic?.state !== 'archived');
  }

  // ---------- decision records ----------

  async listRecords(projectId?: string): Promise<DecisionRecord[]> {
    const all = (await this.store.queryGsi<DecisionRecord>('RECS')).map((r) => r.value);
    return projectId ? all.filter((r) => !r.projectId || r.projectId === projectId) : all;
  }

  async getRecord(id: string): Promise<DecisionRecord> {
    return (await this.store.get<DecisionRecord>(K.record(id)))?.value ?? fail('not_found', `decision ${id} not found`);
  }

  private async newRecord(actor: Actor | 'system', r: Omit<DecisionRecord, 'id' | 'by' | 'at' | 'status'>): Promise<DecisionRecord> {
    const [n] = await this.store.nextIds('record');
    return { id: prefixedId('R', n), ...r, by: actor === 'system' ? 'system' : actor.seatId, at: this.now(), status: 'accepted' };
  }

  private recordEvent(actor: Actor | 'system', rec: DecisionRecord): EnvelopeInput {
    return this.hub.ev(actor, {
      type: 'decision.recorded',
      summary: `${rec.id} decided${rec.projectId ? ` for ${rec.projectId}` : ''}: ${truncate(rec.title, 80)} → ${truncate(rec.choice, 120)}`,
      projectId: rec.projectId,
      data: { recordId: rec.id, supersedes: rec.supersedes ?? null, source: rec.source },
    });
  }

  async recordDecision(actor: Actor, p: ActionPayloads['decision.record']): Promise<{ record: DecisionRecord; changes: string[] }> {
    this.requireOngoing();
    if (p.projectId) await this.hub.requireProject(p.projectId);
    if (p.refs.length && p.projectId) await this.assertRefs(p.projectId, p.refs);
    const old = p.supersedes ? ((await this.store.get<DecisionRecord>(K.record(p.supersedes))) ?? fail('not_found', `decision ${p.supersedes} not found`)) : undefined;
    if (old && old.value.status === 'superseded') fail('conflict', `${p.supersedes} was already superseded by ${old.value.supersededBy}`);
    const rec = await this.newRecord(actor, {
      ...(p.projectId ? { projectId: p.projectId } : {}),
      title: p.title,
      choice: p.choice,
      reason: p.reason,
      refs: p.refs,
      ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      ...(p.repo ? { repo: p.repo } : {}),
      ...(p.contractPaths?.length ? { contractPaths: p.contractPaths } : {}),
      source: 'manual',
    });
    const ops: TxItem[] = [this.store.putNew(K.record(rec.id), rec)];
    if (old) ops.push(this.store.put(K.record(old.value.id), { ...old.value, status: 'superseded', supersededBy: rec.id }, old.v));
    await this.store.commit(ops, [this.recordEvent(actor, rec)]);
    const changes: string[] = [];
    if (rec.projectId && p.replan) {
      const cr = await this.intakeIfCited(actor, rec.projectId, old ? [`decision:${old.value.id}`] : [], {
        ingest: true,
        title: `Ingest decision ${rec.id}: ${truncate(rec.title, 100)}`,
        reason: `Decision ${rec.id}: ${rec.title} → ${rec.choice}${rec.reason ? `. Why: ${rec.reason}` : ''}${old ? ` (supersedes ${old.value.id}: ${old.value.choice})` : ''}`,
        trigger: { kind: 'decision', ref: rec.id },
        addedRefs: [`decision:${rec.id}`],
      });
      if (cr) changes.push(cr.id);
    }
    if (old)
      for (const project of await this.openEpics()) {
        if (project.id === rec.projectId && p.replan) continue;
        const cr = await this.intakeIfCited(actor, project.id, [`decision:${old.value.id}`], {
          title: `${rec.id} supersedes ${old.value.id}`,
          reason: `Decision ${old.value.id} ("${old.value.choice}") was superseded by ${rec.id}: ${rec.choice}${rec.reason ? `. Why: ${rec.reason}` : ''}`,
          trigger: { kind: 'decision', ref: rec.id },
          addedRefs: [`decision:${rec.id}`],
        });
        if (cr) changes.push(cr.id);
      }
    if (rec.repo && rec.contractPaths?.length)
      for (const project of await this.openEpics()) {
        if (project.id === rec.projectId || !project.repos.some((r) => r.name === rec.repo)) continue;
        const cr = await this.intakeIfCited(actor, project.id, [], {
          title: `Contract change ${rec.id} from ${rec.projectId ?? 'the hub'}`,
          reason: `${rec.id} changes the contract at ${rec.contractPaths.join(', ')} in ${rec.repo}: ${rec.choice}`,
          trigger: { kind: 'contract', ref: rec.id },
          addedRefs: [`decision:${rec.id}`],
          query: { repo: rec.repo, contractPaths: rec.contractPaths },
        });
        if (cr) changes.push(cr.id);
      }
    return { record: rec, changes };
  }

  /** A finished vote or a closed escalation becomes a decision record. */
  async autoRecordOps(source: 'vote' | 'escalation', sourceId: string, projectId: string | undefined, title: string, choice: string): Promise<{ ops: TxItem[]; events: EnvelopeInput[] }> {
    if (this.hub.mode !== 'ongoing' || !choice.trim()) return { ops: [], events: [] };
    const rec = await this.newRecord('system', { ...(projectId ? { projectId } : {}), title, choice, reason: `From ${source} ${sourceId}`, refs: [], source, sourceId });
    return { ops: [this.store.putNew(K.record(rec.id), rec)], events: [this.recordEvent('system', rec)] };
  }

  // ---------- change requests ----------

  async listChanges(projectId?: string, status?: string): Promise<ChangeRequest[]> {
    const pids = projectId ? [projectId] : (await this.hub.projects()).map((p) => p.id);
    const all = (await Promise.all(pids.map((pid) => this.store.queryGsi<ChangeRequest>(`PROJECT#${pid}#CHANGES`)))).flat().map((c) => c.value);
    return status ? all.filter((c) => (status === 'open' ? OPEN_CHANGE.includes(c.status) : c.status === status)) : all;
  }

  async requireChange(id: string): Promise<Versioned<ChangeRequest>> {
    return (await this.store.get<ChangeRequest>(K.changePk(id))) ?? fail('not_found', `change request ${id} not found`);
  }

  /** Everything an assessor needs: the change, each impacted ticket in full, and the before/after text of changed input sections. */
  async changeView(id: string): Promise<Record<string, unknown>> {
    const cr = (await this.requireChange(id)).value;
    const tickets = await Promise.all(cr.impact.map(async (e) => (await this.store.get<Ticket>(K.ticketPk(e.ticketId)))?.value));
    const diffs: { ref: string; before: string; after: string }[] = [];
    if (cr.trigger.kind === 'input' && cr.trigger.ref && cr.trigger.fromVersion && cr.trigger.toVersion) {
      const [a, b] = await Promise.all([
        this.store.get<InputVersion>(K.inputVersion(cr.trigger.ref, cr.trigger.fromVersion)),
        this.store.get<InputVersion>(K.inputVersion(cr.trigger.ref, cr.trigger.toVersion)),
      ]);
      const before = a ? parseSections(a.value.body) : [];
      const after = b ? parseSections(b.value.body) : [];
      for (const ref of [...cr.changedRefs, ...cr.addedRefs]) {
        const anchor = ref.split('#')[1];
        if (!anchor) continue;
        const x = before.find((s) => s.anchor === anchor);
        const y = after.find((s) => s.anchor === anchor);
        diffs.push({ ref, before: x ? `${x.title}\n${x.text}` : '(not there)', after: y ? `${y.title}\n${y.text}` : '(removed)' });
      }
    }
    const project = (await this.hub.requireProject(cr.projectId)).value;
    return { change: cr, tickets: tickets.filter(Boolean), diffs, scopeVersion: project.goalVersion, goal: (await this.hub.goal(cr.projectId)) ?? null };
  }

  async openChange(actor: Actor, body: unknown): Promise<ChangeRequest> {
    this.requireOngoing();
    const p = parse(changeCreateSchema, body);
    await this.hub.requireProject(p.projectId);
    if (Boolean(p.repo) !== Boolean(p.contractPaths?.length)) fail('invalid', 'pass repo and contractPaths together');
    const query: ChangeRequest['query'] = {
      ...(p.ticketIds?.length ? { ticketIds: p.ticketIds } : {}),
      ...(p.milestone ? { milestone: p.milestone } : {}),
      ...(p.repo ? { repo: p.repo, contractPaths: p.contractPaths } : {}),
    };
    return this.create(actor, p.projectId, p.changedRefs, { title: p.title, reason: p.reason, trigger: { kind: 'manual' }, scope: p.scope, query });
  }

  /** Opens a change request only when some ticket in the epic is affected. */
  async intakeIfCited(actor: Actor, projectId: string, changedRefs: readonly string[], spec: OpenSpec): Promise<ChangeRequest | undefined> {
    const tickets = await this.hub.tickets(projectId);
    if (!spec.ingest && impactCandidates(tickets, this.candidateQuery(changedRefs, spec.query ?? {})).length === 0) return undefined;
    return this.create(actor, projectId, changedRefs, spec);
  }

  private candidateQuery(changedRefs: readonly string[], q: ChangeRequest['query']): CandidateQuery {
    return {
      changedRefs,
      ...(q.ticketIds ? { ticketIds: q.ticketIds } : {}),
      ...(q.milestone ? { milestone: q.milestone } : {}),
      ...(q.repo && q.contractPaths ? { paths: { repo: q.repo, globs: q.contractPaths } } : {}),
    };
  }

  /** Folds a new ingest into the epic's open re-plan while nobody has assessed it yet, so one meeting's decisions make one re-plan. */
  private async coalesce(actor: Actor, projectId: string, changedRefs: readonly string[], spec: OpenSpec): Promise<ChangeRequest | undefined> {
    if (!spec.ingest) return undefined;
    const open = (await this.store.queryGsi<ChangeRequest>(`PROJECT#${projectId}#CHANGES`)).find((c) => c.value.status === 'assessing' && !c.value.assessedBy && c.value.replanTicket);
    if (!open) return undefined;
    const tickets = await this.hub.tickets(projectId);
    const refs = [...new Set([...open.value.changedRefs, ...changedRefs])];
    const fresh = impactCandidates(tickets, this.candidateQuery(refs, open.value.query));
    const next: ChangeRequest = {
      ...open.value,
      title: `${open.value.title} + ${truncate(spec.title, 80)}`.slice(0, 200),
      reason: `${open.value.reason}\n\nAlso: ${spec.reason}`.slice(0, 8000),
      changedRefs: refs,
      addedRefs: [...new Set([...open.value.addedRefs, ...(spec.addedRefs ?? [])])],
      impact: fresh.map((e) => open.value.impact.find((o) => o.ticketId === e.ticketId) ?? e),
    };
    await this.store.commit([this.store.put(K.change(next), next, open.v)], [
      this.hub.ev(actor, { type: 'change.extended', summary: `${next.id} now also covers: ${truncate(spec.title, 100)} (${next.impact.length} tickets affected)`, projectId, data: { changeId: next.id } }),
    ]);
    const added = next.impact.filter((e) => !open.value.impact.some((o) => o.ticketId === e.ticketId)).map((e) => e.ticketId);
    if (added.length) await this.markSuspect(actor, next, added, true);
    return next;
  }

  private async create(actor: Actor, projectId: string, changedRefs: readonly string[], spec: OpenSpec): Promise<ChangeRequest> {
    const merged = await this.coalesce(actor, projectId, changedRefs, spec);
    if (merged) return merged;
    const pv = await this.hub.requireProject(projectId);
    const tickets = await this.hub.tickets(projectId);
    const query = spec.query ?? {};
    const impact = impactCandidates(tickets, this.candidateQuery(changedRefs, query));
    const [n] = await this.store.nextIds('change');
    const needsAssessment = impact.length > 0 || Boolean(spec.ingest);
    const [tn] = needsAssessment ? await this.store.nextIds('ticket') : [];
    const cr: ChangeRequest = {
      id: prefixedId('CR', n),
      projectId,
      title: spec.title,
      reason: spec.reason,
      trigger: spec.trigger,
      query,
      changedRefs: [...changedRefs],
      addedRefs: spec.addedRefs ?? [],
      baseScopeVersion: pv.value.goalVersion,
      impact,
      newTickets: [],
      ...(spec.scope ? { scope: spec.scope } : {}),
      status: needsAssessment ? 'assessing' : 'proposed',
      ...(tn ? { replanTicket: prefixedId('T', tn) } : {}),
      createdBy: actor.seatId,
      createdAt: this.now(),
    };
    const replan = tn ? this.replanTicket(cr, pv.value, cr.replanTicket as string, actor) : undefined;
    await this.store.commit([this.store.putNew(K.change(cr), cr), ...(replan ? [this.store.putNew(K.ticket(replan), replan)] : [])], [
      this.hub.ev(actor, {
        type: 'change.opened',
        summary: `${cr.id} opened on ${projectId}: ${truncate(cr.title, 80)}. ${impact.length} ticket${impact.length === 1 ? '' : 's'} affected${impact.length ? ' (open ones are suspect until it is decided)' : ''}${replan ? `; re-plan ticket ${replan.id} is ready for any agent` : ''}`,
        projectId,
        data: { changeId: cr.id, impacted: impact.map((e) => e.ticketId), changedRefs: cr.changedRefs, replanTicket: replan?.id ?? null },
      }),
      ...(replan ? [this.hub.ev(actor, { type: 'ticket.ready', summary: `${replan.id} ready (re-plan): ${replan.title}`, projectId, ticketId: replan.id, data: { lanes: [], changeId: cr.id } })] : []),
    ]);
    await this.markSuspect(actor, cr, impact.map((e) => e.ticketId), true);
    return cr;
  }

  /** The auto-generated task any participant's agent picks up: assess the change and re-plan the epic. */
  private replanTicket(cr: ChangeRequest, project: Project, id: string, actor: Actor): Ticket {
    const t = this.hub.ticketFromInput(
      id,
      project.id,
      {
        repo: project.repos[0].name,
        title: `Re-plan ${project.name} after ${cr.id}: ${truncate(cr.title, 120)}`,
        description: [
          `The hub opened ${cr.id} because: ${cr.reason}`,
          '',
          `Run /c1:assess ${cr.id}. It reads the change, every impacted ticket and the epic goal, then submits:`,
          '- a verdict for every impacted ticket (keep, amend, supersede, obsolete, defer; rework or revert for merged code),',
          '- new tickets for anything the change adds, citing the refs they implement,',
          '- a corrected goal or definition of done when the change moves it,',
          '- an impact summary for the change log.',
          '',
          'This ticket is done when the assessment is in. Agents may then approve the change themselves, unless it reworks merged code, changes the goal or stops work in progress: then a human decides.',
        ].join('\n'),
        type: 'replan',
        lanes: [],
        deps: [],
        pathsOwned: [`.c1/changes/${cr.id}/**`],
        acceptance: [{ criterion: `Every impacted ticket of ${cr.id} has a verdict, new tickets cover what changed, and the impact summary is written`, cmd: `c1 change show ${cr.id}` }],
        priority: 0,
        status: 'ready',
      } as Parameters<Hub['ticketFromInput']>[2],
      actor,
      'ready',
      [],
    );
    return { ...t, forChange: cr.id, scopeVersion: project.goalVersion };
  }

  /** Closes the re-plan ticket of a change request: done when assessed, dropped when the change is rejected. */
  private async closeReplan(cr: ChangeRequest, outcome: 'done' | 'dropped', actor: Actor | 'system'): Promise<void> {
    if (!cr.replanTicket) return;
    await this.updateTicket(cr.replanTicket, (t) => {
      if (t.status === 'done' || t.status === 'dropped') return undefined;
      const r = { ...t, status: outcome, log: this.hub.log(t, actor, outcome === 'done' ? `assessment of ${cr.id} is in` : `${cr.id} was ${cr.status}`) } as Ticket;
      delete r.booking;
      delete r.review;
      return {
        ticket: r,
        ops: t.booking ? this.hub.lockOps(t, 'delete') : [],
        events: [this.hub.ev(actor, { type: outcome === 'done' ? 'ticket.done' : 'ticket.status', summary: `${t.id} ${outcome === 'done' ? `done: ${cr.id} is assessed` : `dropped: ${cr.id} was ${cr.status}`}`, projectId: t.projectId, ticketId: t.id, data: { changeId: cr.id } })],
      };
    });
  }

  /** Adds or removes a change request from the suspect list of open tickets, one ticket at a time with retries. */
  private async markSuspect(actor: Actor | 'system', cr: ChangeRequest, ticketIds: readonly string[], on: boolean): Promise<void> {
    for (const id of ticketIds)
      await this.updateTicket(id, (t) => {
        if (t.status === 'done' || t.status === 'dropped') return undefined;
        const has = t.suspectBy?.includes(cr.id) ?? false;
        if (has === on) return undefined;
        const suspectBy = on ? [...(t.suspectBy ?? []), cr.id] : (t.suspectBy ?? []).filter((x) => x !== cr.id);
        const next: Ticket = { ...t, log: this.hub.log(t, actor, on ? `suspect: ${cr.id} may change this ticket` : `${cr.id} no longer affects this ticket`) };
        if (suspectBy.length) next.suspectBy = suspectBy;
        else delete next.suspectBy;
        const events: EnvelopeInput[] =
          on && t.booking
            ? [
                this.hub.ev(actor, {
                  type: 'ticket.suspected',
                  summary: `${t.id} may change under ${cr.id} (${truncate(cr.title, 60)}): finish to a checkpoint and push; merging waits until it is decided`,
                  projectId: t.projectId,
                  ticketId: t.id,
                  to: t.booking.seatId,
                  data: { changeId: cr.id },
                }),
              ]
            : [];
        return { ticket: next, events };
      });
  }

  /** Read-modify-write of one ticket with optimistic retries. */
  private async updateTicket(id: string, fn: (t: Ticket) => { ticket: Ticket; events?: EnvelopeInput[]; ops?: TxItem[] } | undefined): Promise<Ticket | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const tv = await this.store.get<Ticket>(K.ticketPk(id));
      if (!tv) return undefined;
      const out = fn(tv.value);
      if (!out) return tv.value;
      const next: Ticket = { ...out.ticket, updatedAt: this.now(), version: tv.v + 1 };
      try {
        await this.store.commit([this.store.put(K.ticket(next), next, tv.v), ...(out.ops ?? [])], out.events ?? []);
        return next;
      } catch (e) {
        if (!(e instanceof DomainError && e.code === 'conflict') || attempt === 4) throw e;
      }
    }
    return undefined;
  }

  async assess(actor: Actor, id: string, body: unknown): Promise<ChangeRequest> {
    this.requireOngoing();
    const p = parse(changeAssessSchema, body);
    const cv = await this.requireChange(id);
    const cr = cv.value;
    if (!OPEN_CHANGE.includes(cr.status)) fail('conflict', `${id} is ${cr.status}; only an open change request can be assessed`);
    const project = (await this.hub.requireProject(cr.projectId)).value;
    const tickets = await this.hub.tickets(cr.projectId);
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const impact = cr.impact.map((e) => ({ ...e }));
    const added: string[] = [];
    for (const v of p.impact) {
      const t = byId.get(v.ticketId) ?? fail('invalid', `${v.ticketId} is not a ticket of ${cr.projectId}`);
      let entry = impact.find((e) => e.ticketId === v.ticketId);
      if (!entry) {
        if (t.status === 'dropped') fail('invalid', `${t.id} is dropped`);
        entry = { ticketId: t.id, title: t.title, statusAtOpen: t.status, ticketVersion: t.version, why: ['added by the assessment'] };
        impact.push(entry);
        added.push(t.id);
      }
      const allowed = t.status === 'done' ? DONE_VERDICTS : OPEN_VERDICTS;
      if (!allowed.includes(v.verdict)) fail('invalid', `${t.id} is ${t.status}: use ${allowed.join(', ')}`);
      if (v.verdict === 'amend' && !v.amend) fail('invalid', `${t.id}: an amend verdict needs the amended fields`);
      if (v.amend?.refs?.length) await this.assertRefsAfter(cr, v.amend.refs);
      entry.verdict = v.verdict;
      entry.note = v.note;
      entry.amend = v.amend;
      entry.group = v.group;
      entry.acceptance = v.acceptance;
    }
    const groupRepo = new Map<string, string>();
    for (const e of impact) {
      if (e.verdict !== 'rework' && e.verdict !== 'revert') continue;
      const repo = (byId.get(e.ticketId) as Ticket).repo;
      const seen = groupRepo.get(groupKey(e));
      if (seen && seen !== repo) fail('invalid', `rework group ${groupKey(e)} mixes repos ${seen} and ${repo}: give each repo its own group`);
      groupRepo.set(groupKey(e), repo);
    }
    const keys = new Set(p.newTickets.map((t) => t.key));
    if (keys.size !== p.newTickets.length) fail('invalid', 'new ticket keys must be unique');
    for (const nt of p.newTickets) {
      const repo = project.repos.find((r) => r.name === nt.repo) ?? fail('invalid', `new ticket ${nt.key}: unknown repo ${nt.repo}`);
      const errs = nt.type === 'rework' ? [] : protectedPathErrors(nt.key, nt.type, nt.pathsOwned, repo);
      if (errs.length) fail('invalid', errs.join('; '));
      for (const d of nt.deps) if (!keys.has(d) && !byId.has(d)) fail('invalid', `new ticket ${nt.key}: unknown dependency ${d}`);
      for (const s of nt.supersedes ?? []) if (!impact.some((e) => e.ticketId === s && e.verdict === 'supersede')) fail('invalid', `new ticket ${nt.key} replaces ${s}, but ${s} has no supersede verdict`);
      if (nt.milestone && !project.epic?.milestones.some((m) => m.id === nt.milestone)) fail('invalid', `new ticket ${nt.key}: unknown milestone ${nt.milestone}`);
      if (nt.refs?.length) await this.assertRefsAfter(cr, nt.refs);
    }
    const next: ChangeRequest = {
      ...cr,
      impact,
      newTickets: p.newTickets as ChangeTicket[],
      ...(p.scope ? { scope: p.scope } : {}),
      ...(p.summary ? { summary: p.summary } : {}),
      assessedBy: actor.seatId,
      status: impact.every((e) => e.verdict) ? 'proposed' : 'assessing',
    };
    next.needsHuman = needsHumanForChange(next, tickets, Boolean((await this.hub.goal(cr.projectId))?.statement));
    const counts = verdictCounts(next);
    await this.store.commit([this.store.put(K.change(next), next, cv.v)], [
      this.hub.ev(actor, {
        type: 'change.assessed',
        summary: `${id} assessed by ${actor.seatId}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'no verdicts'}, ${p.newTickets.length} new ticket${p.newTickets.length === 1 ? '' : 's'}${
          next.status !== 'proposed' ? '; some tickets still need a verdict' : next.needsHuman.length ? `; a human decides because it ${next.needsHuman.join('; ')}` : '; an agent may approve it (c1 change approve)'
        }`,
        projectId: cr.projectId,
        to: next.status === 'proposed' && next.needsHuman.length ? 'humans' : undefined,
        data: { changeId: id, status: next.status, counts, needsHuman: next.needsHuman },
      }),
    ]);
    if (added.length) await this.markSuspect(actor, next, added, true);
    if (next.status === 'proposed') await this.closeReplan(next, 'done', actor);
    return next;
  }

  /** Refs in an assessment may point at sections that exist only in the new version of an input. */
  private async assertRefsAfter(cr: ChangeRequest, refs: readonly string[]): Promise<void> {
    const pending = new Set([...cr.addedRefs, ...cr.changedRefs]);
    await this.assertRefs(cr.projectId, refs.filter((r) => !pending.has(r) && !r.startsWith('dod:')));
  }

  async rebase(actor: Actor, id: string): Promise<ChangeRequest> {
    this.requireOngoing();
    const cv = await this.requireChange(id);
    const cr = cv.value;
    if (!OPEN_CHANGE.includes(cr.status)) fail('conflict', `${id} is ${cr.status}; only an open change request can be rebased`);
    const project = (await this.hub.requireProject(cr.projectId)).value;
    const tickets = await this.hub.tickets(cr.projectId);
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const fresh = impactCandidates(tickets, this.candidateQuery(cr.changedRefs, cr.query));
    const kept: ImpactEntry[] = [];
    let carried = 0;
    for (const e of fresh) {
      const old = cr.impact.find((o) => o.ticketId === e.ticketId);
      const t = byId.get(e.ticketId) as Ticket;
      const unchanged = old && old.verdict && old.statusAtOpen === t.status && (t.scopeVersion ?? 0) <= cr.baseScopeVersion;
      if (unchanged) carried++;
      kept.push(unchanged ? { ...old, why: e.why } : e);
    }
    for (const old of cr.impact) if (old.why.includes('added by the assessment') && byId.get(old.ticketId)?.status !== 'dropped' && !kept.some((k) => k.ticketId === old.ticketId)) kept.push(old);
    const next: ChangeRequest = {
      ...cr,
      impact: kept,
      newTickets: cr.newTickets.map((nt) => ({ ...nt, supersedes: nt.supersedes?.filter((s) => kept.some((k) => k.ticketId === s && k.verdict === 'supersede')) })),
      baseScopeVersion: project.goalVersion,
      status: kept.every((e) => e.verdict) ? 'proposed' : 'assessing',
    };
    await this.store.commit([this.store.put(K.change(next), next, cv.v)], [
      this.hub.ev(actor, {
        type: 'change.rebased',
        summary: `${id} rebased on scope v${project.goalVersion} by ${actor.seatId}: ${carried} verdict${carried === 1 ? '' : 's'} carried over, ${kept.length - carried} ticket${kept.length - carried === 1 ? '' : 's'} need a new look`,
        projectId: cr.projectId,
        data: { changeId: id, base: project.goalVersion },
      }),
    ]);
    const dropped = cr.impact.filter((o) => !kept.some((k) => k.ticketId === o.ticketId)).map((o) => o.ticketId);
    if (dropped.length) await this.markSuspect(actor, next, dropped, false);
    const newOnes = kept.filter((k) => !cr.impact.some((o) => o.ticketId === k.ticketId)).map((k) => k.ticketId);
    if (newOnes.length) await this.markSuspect(actor, next, newOnes, true);
    return next;
  }

  async rejectChange(actor: Actor, p: ActionPayloads['change.reject']): Promise<ChangeRequest> {
    this.requireOngoing();
    const cv = await this.requireChange(p.changeId);
    const inContest = cv.value.status === 'approved' && (cv.value.contestUntil ?? 0) > this.now();
    if (!OPEN_CHANGE.includes(cv.value.status) && !inContest) fail('conflict', `${p.changeId} is ${cv.value.status}`);
    if (inContest && actor.kind !== 'human') fail('forbidden', `${p.changeId} was approved by an agent; only a human can stop it now`);
    await this.assertMayDecide(actor, cv.value.projectId);
    const next: ChangeRequest = { ...cv.value, status: 'rejected', decidedBy: actor.seatId, decidedByKind: actor.kind, decidedAt: this.now() };
    const stopped = inContest && cv.value.decisionId ? await this.store.get<DecisionRecord>(K.record(cv.value.decisionId)) : undefined;
    const recOps = stopped ? [this.store.put(K.record(stopped.value.id), { ...stopped.value, status: 'superseded', choice: `${stopped.value.choice} (stopped by ${actor.seatId} before it applied${p.reason ? `: ${p.reason}` : ''})` }, stopped.v)] : [];
    await this.store.commit([this.store.put(K.change(next), next, cv.v), ...recOps], [
      this.hub.ev(actor, { type: 'change.rejected', summary: `${p.changeId} rejected by ${actor.seatId}${p.reason ? `: ${truncate(p.reason, 120)}` : ''}; its tickets are no longer suspect`, projectId: next.projectId, data: { changeId: p.changeId } }),
    ]);
    await this.markSuspect(actor, next, next.impact.map((e) => e.ticketId), false);
    await this.closeReplan(next, 'dropped', actor);
    return next;
  }

  private async assertMayDecide(actor: Actor, projectId: string): Promise<void> {
    const epic = (await this.hub.requireProject(projectId)).value.epic;
    if (epic?.decisionMode === 'owners' && epic.owners.length && !epic.owners.includes(actor.seatId))
      fail('forbidden', `only the owners of ${projectId} (${epic.owners.join(', ')}) decide its change requests`);
  }

  async approveChange(actor: Actor, p: ActionPayloads['change.approve']): Promise<ChangeRequest> {
    this.requireOngoing();
    const cv = await this.requireChange(p.changeId);
    const cr = cv.value;
    if (cr.status === 'applying' || cr.status === 'applied') return cr;
    if (cr.status === 'approved') {
      if (actor.kind !== 'human') return cr;
      await this.store.commit([this.store.put(K.change(cr), { ...cr, status: 'applying', contestUntil: this.now() }, cv.v)], [
        this.hub.ev(actor, { type: 'change.confirmed', summary: `${cr.id} confirmed by ${actor.seatId}; applying it now`, projectId: cr.projectId, data: { changeId: cr.id } }),
      ]);
      return this.apply(cr.id, actor);
    }
    if (cr.status !== 'proposed') fail('conflict', `${p.changeId} is ${cr.status}: every impacted ticket needs a verdict first (c1 change assess)`);
    await this.assertMayDecide(actor, cr.projectId);
    const project = (await this.hub.requireProject(cr.projectId)).value;
    const needsHuman = needsHumanForChange(cr, await this.hub.tickets(cr.projectId), Boolean((await this.hub.goal(cr.projectId))?.statement));
    if (actor.kind === 'agent' && needsHuman.length) fail('forbidden', `${cr.id} needs a human: it ${needsHuman.join('; ')}`, { needsHuman });
    if (project.goalVersion !== cr.baseScopeVersion)
      fail('stale', `${p.changeId} was assessed on scope v${cr.baseScopeVersion}, but ${cr.projectId} is on v${project.goalVersion} now: rebase it (c1 change rebase ${p.changeId}) and check the verdicts again`);
    const counts = verdictCounts(cr);
    const rec = await this.newRecord(actor, {
      projectId: cr.projectId,
      title: cr.title,
      choice: `Apply ${cr.id}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'no ticket changes'}${cr.newTickets.length ? `, ${cr.newTickets.length} new tickets` : ''}`,
      reason: cr.summary ? `${cr.reason}\n\nImpact: ${cr.summary}` : cr.reason,
      refs: cr.addedRefs.filter((r) => r.startsWith('decision:')),
      source: 'change',
      sourceId: cr.id,
    });
    const contestMs = actor.kind === 'agent' ? (await this.hub.settings()).value.defaultContestMin * 60_000 : 0;
    const next: ChangeRequest = {
      ...cr,
      status: contestMs ? 'approved' : 'applying',
      needsHuman,
      decidedBy: actor.seatId,
      decidedByKind: actor.kind,
      decidedAt: this.now(),
      decisionId: rec.id,
      ...(contestMs ? { contestUntil: this.now() + contestMs } : {}),
    };
    const when = contestMs ? new Date(this.now() + contestMs).toISOString().slice(11, 16) : '';
    await this.store.commit([this.store.put(K.change(next), next, cv.v), this.store.putNew(K.record(rec.id), rec)], [
      this.hub.ev(actor, {
        type: 'change.approved',
        summary: contestMs ? `${cr.id} approved by agent ${actor.seatId}; it applies at ${when}Z unless a human rejects it (c1 change reject ${cr.id})` : `${cr.id} approved by ${actor.seatId}; applying it now`,
        projectId: cr.projectId,
        to: contestMs ? 'humans' : undefined,
        data: { changeId: cr.id, recordId: rec.id, contestUntil: next.contestUntil ?? null },
      }),
      this.recordEvent(actor, rec),
    ]);
    return contestMs ? next : this.apply(cr.id, actor);
  }

  /** Starts applying an agent-approved change request once its contest window has passed. */
  private async applyAfterContest(cv: Versioned<ChangeRequest>): Promise<void> {
    if (cv.value.status !== 'approved' || (cv.value.contestUntil ?? 0) > this.now()) return;
    await this.store.commit([this.store.put(K.change(cv.value), { ...cv.value, status: 'applying' }, cv.v)]);
    await this.apply(cv.value.id);
  }

  /** Applies an approved change request. Every step is idempotent, so the sweep can resume it after a failure. */
  async apply(id: string, actor: Actor | 'system' = 'system'): Promise<ChangeRequest> {
    let cv = await this.requireChange(id);
    if (cv.value.status !== 'applying') return cv.value;
    const save = async (next: ChangeRequest, ops: TxItem[] = [], events: EnvelopeInput[] = []): Promise<void> => {
      await this.store.commit([this.store.put(K.change(next), next, cv.v), ...ops], events);
      cv = { value: next, v: cv.v + 1 };
    };

    if (cv.value.appliedScopeVersion === undefined) {
      const pv = await this.hub.requireProject(cv.value.projectId);
      const prev = pv.value.goalVersion ? (await this.store.get<Goal>(K.goal(pv.value.id, pv.value.goalVersion)))?.value : undefined;
      const version = pv.value.goalVersion + 1;
      const s = cv.value.scope ?? {};
      const dod = s.definitionOfDone ? assignDodIds(prev ? dodOf(prev) : undefined, s.definitionOfDone) : dodOf(prev);
      const goal: Goal = {
        projectId: pv.value.id,
        version,
        statement: s.statement ?? prev?.statement ?? pv.value.name,
        definitionOfDone: dod.map((d) => d.text),
        dod,
        demoScript: prev?.demoScript ?? '',
        nonGoals: s.nonGoals ?? prev?.nonGoals ?? [],
        ...((s.refs ?? prev?.refs) ? { refs: s.refs ?? prev?.refs } : {}),
        changeId: id,
        createdBy: typeof actor === 'string' ? 'system' : actor.seatId,
        createdAt: this.now(),
      };
      await save(
        { ...cv.value, appliedScopeVersion: version },
        [this.store.put(K.project(pv.value.id), { ...pv.value, goalVersion: version }, pv.v), this.store.putNew(K.goal(pv.value.id, version), goal)],
        [this.hub.ev(actor, { type: 'epic.scope_changed', summary: `${pv.value.id} scope v${version} by ${id}`, projectId: pv.value.id, data: { version, changeId: id } })],
      );
    }

    if (!cv.value.created) {
      const groups = reworkGroups(cv.value);
      const n = cv.value.newTickets.length + groups.length;
      const ids = n ? await this.store.nextIds('ticket', n) : [];
      const created: Record<string, string> = {};
      cv.value.newTickets.forEach((nt, i) => (created[nt.key] = prefixedId('T', ids[i])));
      groups.forEach((g, i) => (created[`rework:${g.key}`] = prefixedId('T', ids[cv.value.newTickets.length + i])));
      await save({ ...cv.value, created });
    }

    const scopeVersion = cv.value.appliedScopeVersion as number;
    const created = cv.value.created as Record<string, string>;
    const author: Actor = typeof actor === 'string' ? { seatId: cv.value.decidedBy ?? 'system', kind: 'human' } : actor;
    for (const nt of cv.value.newTickets) await this.createOnce(cv.value, created[nt.key], () => this.ticketFromChange(cv.value, nt, created, scopeVersion, author));
    for (const g of reworkGroups(cv.value)) {
      const originals = await Promise.all(g.entries.map(async (e) => (await this.store.get<Ticket>(K.ticketPk(e.ticketId)))?.value as Ticket));
      await this.createOnce(cv.value, created[`rework:${g.key}`], () => this.reworkTicket(cv.value, g, originals, created[`rework:${g.key}`], scopeVersion, author));
    }

    for (let i = 0; i < cv.value.impact.length; i++) {
      const e = cv.value.impact[i];
      if (e.applied) continue;
      await this.applyVerdict(cv.value, e, scopeVersion, actor);
      const impact = cv.value.impact.map((x, j) => (j === i ? { ...x, applied: true } : x));
      await save({ ...cv.value, impact });
    }

    const counts = verdictCounts(cv.value);
    const done: ChangeRequest = { ...cv.value, status: 'applied', counts: { ...counts, created: cv.value.newTickets.length, rework: reworkGroups(cv.value).length } };
    await save(done, [], [
      this.hub.ev(actor, {
        type: 'change.applied',
        summary: `${id} applied to ${done.projectId} (scope v${scopeVersion}): ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'no ticket changes'}${done.newTickets.length ? `, ${done.newTickets.length} new` : ''}${done.counts?.rework ? `, ${done.counts.rework} rework ticket${done.counts.rework === 1 ? '' : 's'}` : ''}`,
        projectId: done.projectId,
        data: { changeId: id, scopeVersion, counts: done.counts, created: Object.values(created) },
      }),
    ]);
    return done;
  }

  private async createOnce(cr: ChangeRequest, id: string, build: () => Ticket): Promise<void> {
    if (await this.store.get<Ticket>(K.ticketPk(id))) return;
    const t = build();
    await this.store.commit([this.store.putNew(K.ticket(t), t)], [
      this.hub.ev('system', { type: 'ticket.added', summary: `${t.id} added by ${cr.id} (${t.status}): ${t.title}`, projectId: t.projectId, ticketId: t.id, data: { status: t.status, lanes: t.lanes, changeId: cr.id } }),
    ]);
  }

  private ticketFromChange(cr: ChangeRequest, nt: ChangeTicket, created: Record<string, string>, scopeVersion: number, author: Actor): Ticket {
    const id = created[nt.key];
    const base = this.hub.ticketFromInput(
      id,
      cr.projectId,
      { ...nt, description: `${nt.description}${nt.description ? '\n\n' : ''}Created by ${cr.id}: ${cr.title}`, status: 'ready' } as Parameters<Hub['ticketFromInput']>[2],
      author,
      'ready',
      nt.deps.map((d) => created[d] ?? d),
    );
    return { ...base, scopeVersion, ...(nt.supersedes?.length ? { supersedes: nt.supersedes } : {}) };
  }

  private reworkTicket(cr: ChangeRequest, g: ReworkGroup, originals: Ticket[], id: string, scopeVersion: number, author: Actor): Ticket {
    const revert = g.entries.every((e) => e.verdict === 'revert');
    const files = [...new Set(originals.flatMap((t) => (t.files?.length ? t.files : t.pathsOwned)))].slice(0, 50);
    const changed = cr.changedRefs;
    const retired = originals.flatMap((t) => (t.refs?.some((r) => changed.some((c) => refCovers(r, c))) ? t.acceptance.map((a) => `${t.id}: ${a.criterion}`) : []));
    const acceptance: Acceptance[] = g.entries.flatMap((e) => e.acceptance ?? []);
    const lines = [
      `${revert ? 'Revert' : 'Rework'} merged code after ${cr.id}: ${cr.title}`,
      '',
      cr.reason,
      '',
      '## Merged work this changes',
      ...originals.map((t) => `- ${t.id} "${t.title}"${t.mergeSha ? ` merged as ${t.mergeSha}` : ''}${t.prUrl ? ` (${t.prUrl})` : ''}${t.files?.length ? `; files: ${t.files.slice(0, 20).join(', ')}` : ''}`),
      ...(revert ? ['', `Plan: revert ${originals.map((t) => t.mergeSha ?? t.id).join(', ')} with git revert, then make sure nothing else relied on it.`] : []),
      '',
      '## What changed',
      ...changed.map((c) => `- ${c} (old meaning no longer holds)`),
      ...cr.addedRefs.map((c) => `- ${c} (new)`),
      ...(retired.length ? ['', '## Acceptance criteria to retire (change or remove their tests)', ...retired.map((r) => `- ${r}`)] : []),
      ...g.entries.flatMap((e) => (e.note ? ['', `Note on ${e.ticketId}: ${e.note}`] : [])),
    ];
    const t = this.hub.ticketFromInput(
      id,
      cr.projectId,
      {
        repo: originals[0].repo,
        title: `${revert ? 'Revert' : 'Rework'}: ${truncate(cr.title, 150)}`,
        description: truncate(lines.join('\n'), 7900),
        type: 'rework',
        lanes: [...new Set(originals.flatMap((o) => o.lanes))],
        deps: [],
        pathsOwned: files.length ? files : originals[0].pathsOwned,
        acceptance: acceptance.length ? acceptance : [{ criterion: `The merged code follows ${[...changed, ...cr.addedRefs].join(', ') || cr.title}; tests for the retired criteria are changed or removed` }],
        priority: Math.min(...originals.map((o) => o.priority)),
        refs: [...new Set([...originals.flatMap((o) => o.refs ?? []), ...cr.addedRefs])].slice(0, 30),
        status: 'ready',
      } as Parameters<Hub['ticketFromInput']>[2],
      author,
      'ready',
      [],
    );
    return { ...t, scopeVersion, reworks: originals.map((o) => o.id), ...(originals[0].milestone ? { milestone: originals[0].milestone } : {}) };
  }

  private async applyVerdict(cr: ChangeRequest, e: ImpactEntry, scopeVersion: number, actor: Actor | 'system'): Promise<void> {
    const created = cr.created ?? {};
    const replacements = cr.newTickets.filter((nt) => nt.supersedes?.includes(e.ticketId)).map((nt) => created[nt.key]);
    const group = e.verdict === 'rework' || e.verdict === 'revert' ? created[`rework:${groupKey(e)}`] : undefined;
    await this.updateTicket(e.ticketId, (t) => {
      if (t.log.some((l) => l.text.startsWith(`${cr.id} applied`))) return undefined;
      const base: Ticket = { ...t, scopeVersion };
      const suspectBy = (t.suspectBy ?? []).filter((x) => x !== cr.id);
      if (suspectBy.length) base.suspectBy = suspectBy;
      else delete base.suspectBy;
      const note = (text: string): Ticket['log'] => this.hub.log(t, actor, `${cr.id} applied: ${text}${e.note ? ` (${truncate(e.note, 200)})` : ''}`);
      const tellOwner = (summary: string): EnvelopeInput[] =>
        t.booking ? [this.hub.ev(actor, { type: 'ticket.changed', summary, projectId: t.projectId, ticketId: t.id, to: t.booking.seatId, data: { changeId: cr.id, verdict: e.verdict } })] : [];
      const stopWork = (next: Ticket): { ticket: Ticket; ops: TxItem[] } => {
        const ops = t.booking && isActive(t) ? this.hub.lockOps(t, 'delete') : [];
        delete next.booking;
        delete next.review;
        return { ticket: next, ops };
      };
      switch (e.verdict) {
        case 'keep': {
          const dependent = e.why.find((w) => w.startsWith('depends on'));
          return { ticket: { ...base, log: note(dependent ? `kept; check it still fits (${dependent})` : 'kept') } };
        }
        case 'amend': {
          const a = e.amend ?? {};
          const pathsLocked = isActive(t) && a.pathsOwned && JSON.stringify(a.pathsOwned) !== JSON.stringify(t.pathsOwned);
          const next: Ticket = {
            ...base,
            ...(a.title ? { title: a.title } : {}),
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.acceptance ? { acceptance: a.acceptance } : {}),
            ...(a.refs ? { refs: a.refs } : {}),
            ...(a.pathsOwned && !pathsLocked ? { pathsOwned: a.pathsOwned } : {}),
            ...(a.pathsRead ? { pathsRead: a.pathsRead } : {}),
            ...(a.milestone ? { milestone: a.milestone } : {}),
            ...(a.priority !== undefined ? { priority: a.priority } : {}),
            log: note(`amended${pathsLocked ? '; owned paths kept because the ticket is booked: release it to take the new paths' : ''}`),
          };
          return { ticket: next, events: tellOwner(`${t.id} was amended by ${cr.id}: re-read it (c1 ticket show ${t.id}) before you continue`) };
        }
        case 'supersede':
        case 'obsolete': {
          if (t.status === 'done') return { ticket: { ...base, log: note(`${e.verdict} ignored: the ticket is already done`) } };
          const r = stopWork({
            ...base,
            status: 'dropped',
            dropReason: e.verdict === 'supersede' ? `superseded by ${cr.id}${replacements.length ? ` → ${replacements.join(', ')}` : ''}` : `obsolete after ${cr.id}`,
            ...(replacements.length ? { supersededBy: replacements } : {}),
            log: note(e.verdict === 'supersede' ? `superseded${replacements.length ? ` by ${replacements.join(', ')}` : ''}` : 'obsolete'),
          });
          return {
            ...r,
            events: tellOwner(`${t.id} was ${e.verdict === 'supersede' ? `replaced${replacements.length ? ` by ${replacements.join(', ')}` : ''}` : 'dropped as obsolete'} by ${cr.id}: stop, push your work-in-progress branch and pick other work`),
          };
        }
        case 'defer': {
          const active = isActive(t);
          const r = active ? stopWork({ ...base, status: 'ready', deferred: true, log: note('deferred; booking released') }) : { ticket: { ...base, deferred: true, log: note('deferred') }, ops: [] };
          return { ...r, events: tellOwner(`${t.id} was deferred by ${cr.id}: push your work-in-progress branch and pick other work`) };
        }
        case 'rework':
        case 'revert':
          return { ticket: { ...base, log: note(`${e.verdict} in ${group ?? 'a rework ticket'}`) } };
        default:
          return { ticket: { ...base, log: note('no verdict') } };
      }
    });
  }

  // ---------- change log and decision log ----------

  /** What happened to an epic's plan and why, newest first: scope versions, change requests and decisions. */
  async changelog(projectId: string): Promise<{ entries: { at: number; kind: string; id: string; text: string; by?: string }[] }> {
    const project = (await this.hub.requireProject(projectId)).value;
    const [goals, changes, records] = await Promise.all([
      this.store.queryPk<Goal>(`PROJECT#${projectId}`, 'GOAL#'),
      this.listChanges(projectId),
      this.listRecords(projectId),
    ]);
    const entries: { at: number; kind: string; id: string; text: string; by?: string }[] = [];
    for (const { value: g } of goals) entries.push({ at: g.createdAt, kind: 'scope', id: `v${g.version}`, by: g.createdBy, text: `Scope v${g.version}${g.changeId ? ` from ${g.changeId}` : ''}: ${g.statement}` });
    for (const c of changes) {
      entries.push({ at: c.createdAt, kind: 'change.opened', id: c.id, by: c.createdBy, text: `${c.id} opened (${c.trigger.kind}${c.trigger.ref ? ` ${c.trigger.ref}` : ''}): ${c.title}. ${c.impact.length} tickets affected.` });
      if (c.decidedAt)
        entries.push({
          at: c.decidedAt,
          kind: `change.${c.status === 'rejected' ? 'rejected' : 'applied'}`,
          id: c.id,
          by: `${c.decidedBy}${c.decidedByKind ? ` (${c.decidedByKind})` : ''}`,
          text: `${c.id} ${c.status === 'rejected' ? 'rejected' : c.status}${c.appliedScopeVersion ? ` → scope v${c.appliedScopeVersion}` : ''}: ${Object.entries(c.counts ?? verdictCounts(c)).map(([k, n]) => `${n} ${k}`).join(', ') || 'no ticket changes'}${c.summary ? `. Impact: ${c.summary}` : ''}`,
        });
    }
    for (const r of records) entries.push({ at: r.at, kind: 'decision', id: r.id, by: r.by, text: `${r.id} ${r.title} → ${r.choice}${r.status === 'superseded' ? ` (superseded by ${r.supersededBy})` : ''}` });
    return { entries: entries.filter((e) => e.at >= project.createdAt - 1).sort((a, b) => b.at - a.at) };
  }

  // ---------- sweep, board, export ----------

  async sweep(): Promise<{ changes: number }> {
    let changes = 0;
    for (const cr of await this.listChanges(undefined, 'approved')) {
      try {
        await this.applyAfterContest(await this.requireChange(cr.id));
      } catch (e) {
        if (!(e instanceof DomainError && e.code === 'conflict')) throw e;
      }
    }
    for (const cr of await this.listChanges(undefined, 'applying')) {
      try {
        await this.apply(cr.id);
        changes++;
      } catch (e) {
        if (!(e instanceof DomainError && e.code === 'conflict')) throw e;
      }
    }
    return { changes };
  }

  async boardData(selected: string | undefined, perProject: { p: Project; tickets: Ticket[] }[]): Promise<Record<string, unknown>> {
    const [catalog, inputs, records, changes] = await Promise.all([this.catalog(), this.listInputs(), this.listRecords(), this.listChanges()]);
    return {
      catalog,
      inputs,
      records: records.sort((a, b) => b.at - a.at).slice(0, 100),
      changes: changes
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((c) => (c.projectId === selected || OPEN_CHANGE.includes(c.status) ? c : { ...c, impact: [], newTickets: [] })),
      roadmap: perProject.map(({ p, tickets }) => {
        const live = tickets.filter((t) => t.status !== 'dropped' && !t.deferred && t.type !== 'replan');
        return {
          projectId: p.id,
          name: p.name,
          epic: p.epic ?? null,
          scopeVersion: p.goalVersion,
          total: live.length,
          done: live.filter((t) => t.status === 'done').length,
          suspect: live.filter((t) => t.suspectBy?.length).length,
          deferred: tickets.filter((t) => t.deferred && t.status !== 'dropped' && t.status !== 'done').length,
          milestones: (p.epic?.milestones ?? []).map((m) => {
            const mt = live.filter((t) => t.milestone === m.id);
            return { ...m, total: mt.length, done: mt.filter((t) => t.status === 'done').length };
          }),
        };
      }),
    };
  }

  async exportAll(): Promise<Record<string, unknown>> {
    const projects = await this.hub.projects();
    const perProject = await Promise.all(
      projects.map(async (p) => ({
        project: p,
        goals: (await this.store.queryPk<Goal>(`PROJECT#${p.id}`, 'GOAL#')).map((g) => g.value),
        tickets: await this.hub.tickets(p.id),
        changes: (await this.store.queryGsi<ChangeRequest>(`PROJECT#${p.id}#CHANGES`)).map((c) => c.value),
      })),
    );
    const inputs = await Promise.all((await this.listInputs()).map(async (i) => ({ ...i, versions: (await this.store.queryPk<InputVersion>(`INPUT#${i.id}`, 'V#')).map((v) => v.value) })));
    return { exportedAt: new Date(this.now()).toISOString(), mode: this.hub.mode, catalog: await this.catalog(), epics: perProject, inputs, decisions: await this.listRecords() };
  }
}

interface ReworkGroup {
  key: string;
  entries: ImpactEntry[];
}

const groupKey = (e: ImpactEntry): string => e.group ?? e.ticketId.toLowerCase();

const reworkGroups = (cr: ChangeRequest): ReworkGroup[] => {
  const map = new Map<string, ImpactEntry[]>();
  for (const e of cr.impact) if (e.verdict === 'rework' || e.verdict === 'revert') map.set(groupKey(e), [...(map.get(groupKey(e)) ?? []), e]);
  return [...map.entries()].map(([key, entries]) => ({ key, entries }));
};

const verdictCounts = (cr: ChangeRequest): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of cr.impact) if (e.verdict) out[e.verdict] = (out[e.verdict] ?? 0) + 1;
  return out;
};
