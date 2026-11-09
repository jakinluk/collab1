import type { Decision, Escalation, Goal, KnowledgeItem, Project, Proposal, Seat, Settings, Ticket } from '../shared/types';
import { pad, numericPart } from '../core/ids';
import type { StoredRule } from '../core/rules';

export interface Keys {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
}

export type Item = Keys & Record<string, unknown>;

const idSort = (id: string): string => pad(numericPart(id), 8);

export const K = {
  settings: (): Keys => ({ PK: 'HUB', SK: 'SETTINGS' }),
  release: (): Keys => ({ PK: 'HUB', SK: 'RELEASE' }),
  counter: (name: string): Keys => ({ PK: 'HUB', SK: `COUNTER#${name}` }),
  hubRule: (code: string): Keys => ({ PK: 'HUB', SK: `RULE#${code}` }),
  seat: (id: string): Keys => ({ PK: `SEAT#${id}`, SK: 'META', GSI1PK: 'SEATS', GSI1SK: id }),
  sub: (sub: string): Keys => ({ PK: `SUB#${sub}`, SK: 'META' }),
  token: (hash: string, seatId: string, tokenId: string): Keys => ({ PK: `TOKEN#${hash}`, SK: 'META', GSI1PK: `SEAT#${seatId}`, GSI1SK: `TOKEN#${tokenId}` }),
  tokenPk: (hash: string): Keys => ({ PK: `TOKEN#${hash}`, SK: 'META' }),
  join: (hash: string): Keys => ({ PK: `JOIN#${hash}`, SK: 'META' }),
  project: (id: string): Keys => ({ PK: `PROJECT#${id}`, SK: 'META', GSI1PK: 'PROJECTS', GSI1SK: id }),
  goal: (projectId: string, version: number): Keys => ({ PK: `PROJECT#${projectId}`, SK: `GOAL#${pad(version, 4)}` }),
  projectRule: (projectId: string, code: string): Keys => ({ PK: `PROJECT#${projectId}`, SK: `RULE#${code}` }),
  ticket: (t: Pick<Ticket, 'id' | 'projectId'>): Keys => ({
    PK: `TICKET#${t.id}`,
    SK: 'META',
    GSI1PK: `PROJECT#${t.projectId}#TICKETS`,
    GSI1SK: idSort(t.id),
  }),
  ticketPk: (id: string): Keys => ({ PK: `TICKET#${id}`, SK: 'META' }),
  lock: (projectId: string, repo: string, prefix: string): Keys => ({
    PK: `LOCK#${projectId}#${repo}#${prefix}`,
    SK: 'META',
    GSI1PK: `PROJECT#${projectId}#LOCKS`,
    GSI1SK: `${repo}#${prefix}`,
  }),
  escalation: (e: Pick<Escalation, 'id' | 'status'>): Keys => ({ PK: `ESC#${e.id}`, SK: 'META', GSI1PK: 'ESCS', GSI1SK: `${e.status}#${idSort(e.id)}` }),
  decision: (d: Pick<Decision, 'id' | 'status'>): Keys => ({ PK: `DEC#${d.id}`, SK: 'META', GSI1PK: 'DECS', GSI1SK: `${d.status}#${idSort(d.id)}` }),
  knowledge: (k: Pick<KnowledgeItem, 'id' | 'status'>): Keys => ({ PK: `KNOW#${k.id}`, SK: 'META', GSI1PK: 'KNOW', GSI1SK: `${k.status}#${idSort(k.id)}` }),
  proposal: (p: Pick<Proposal, 'id' | 'status'>): Keys => ({ PK: `PROP#${p.id}`, SK: 'META', GSI1PK: 'PROPS', GSI1SK: `${p.status}#${idSort(p.id)}` }),
  event: (seq: number): Keys => ({ PK: 'EVENT', SK: pad(seq, 12) }),
};

export interface TokenRecord {
  tokenId: string;
  seatId: string;
  kind: 'agent' | 'worker';
  workerId?: string;
  machine?: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface JoinRecord {
  seatId: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export interface LockRecord {
  projectId: string;
  repo: string;
  prefix: string;
  ticketId: string;
}

export const ENTITY_KEYS = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'ttl', '_v', 'entity'] as const;

export const strip = <T>(item: Record<string, unknown>): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!(ENTITY_KEYS as readonly string[]).includes(k)) out[k] = v;
  return out as T;
};

export type EntityMap = {
  seat: Seat;
  project: Project;
  goal: Goal;
  ticket: Ticket;
  escalation: Escalation;
  decision: Decision;
  knowledge: KnowledgeItem;
  proposal: Proposal;
  settings: Settings;
  token: TokenRecord;
  join: JoinRecord;
  lock: LockRecord;
  rule: StoredRule;
};
