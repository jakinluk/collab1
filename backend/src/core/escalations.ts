import type { Actor, BlockerRule, Decision, Escalation, Ticket } from '../shared/types';
import { fail } from './errors';
import { defaultQuorum } from './quorum';

const MIN = 60_000;

export const isQuorumResolver = (r: BlockerRule): boolean => r.resolver === 'agent_quorum' || r.resolver === 'human_quorum';
export const isHumanResolver = (r: BlockerRule): boolean =>
  r.resolver === 'any_human' || r.resolver === 'human_quorum' || r.resolver === 'human_named';
export const parksTicket = (r: BlockerRule): boolean => r.stopScope !== 'none';

export const affectedSeats = (
  ticket: Ticket | undefined,
  all: readonly Ticket[],
  raiser: string,
  members: readonly string[],
  addNeutral: boolean,
): string[] => {
  const seats = new Set<string>([raiser]);
  if (ticket) {
    if (ticket.booking) seats.add(ticket.booking.seatId);
    for (const t of all) {
      const linked = t.deps.includes(ticket.id) || ticket.deps.includes(t.id);
      if (linked && t.booking) seats.add(t.booking.seatId);
    }
  }
  const others = members.filter((m) => !seats.has(m));
  if (seats.size < 2 && others.length) seats.add(others[0]);
  if (addNeutral) {
    const neutral = members.find((m) => !seats.has(m));
    if (neutral) seats.add(neutral);
  }
  return [...seats];
};

export const decisionOptions = (rule: BlockerRule, proposed: readonly string[] | undefined): string[] => {
  const opts = [...new Set((proposed ?? []).map((p) => p.trim()).filter(Boolean))];
  if (!opts.includes(rule.defaultOnTimeout)) opts.push(rule.defaultOnTimeout);
  if (opts.length < 2) opts.unshift('Proceed as proposed by the raiser');
  return opts.slice(0, 7);
};

export interface EscalationPlan {
  escalation: Omit<Escalation, 'id'>;
  decision?: Omit<Decision, 'id'>;
  parkTicket: boolean;
}

export const planEscalation = (args: {
  kind: Escalation['kind'];
  projectId: string;
  ticket?: Ticket;
  rule: BlockerRule;
  rulesVersion: number;
  summary: string;
  detail: string;
  proposed?: string[];
  actor: Actor;
  allTickets: readonly Ticket[];
  members: readonly string[];
  humanSeats: readonly string[];
  now: number;
}): EscalationPlan => {
  const { rule, now } = args;
  const deadline = rule.timeoutMin ? now + rule.timeoutMin * MIN : undefined;
  const escalation: Omit<Escalation, 'id'> = {
    kind: args.kind,
    projectId: args.projectId,
    ticketId: args.ticket?.id,
    ruleCode: rule.code,
    ruleVersion: args.rulesVersion,
    summary: args.summary,
    detail: args.detail,
    proposed: args.proposed,
    status: 'open',
    raisedBy: args.actor.seatId,
    raisedByKind: args.actor.kind,
    deadline,
    createdAt: now,
  };
  let decision: Omit<Decision, 'id'> | undefined;
  if (isQuorumResolver(rule)) {
    const humans = rule.resolver === 'human_quorum';
    const eligible = humans
      ? [...args.humanSeats]
      : affectedSeats(args.ticket, args.allTickets, args.actor.seatId, args.members, rule.code === 'B9');
    decision = {
      projectId: args.projectId,
      question: `${rule.code} ${rule.name}: ${args.summary}`,
      options: decisionOptions(rule, args.proposed),
      context: args.detail.slice(0, 4000),
      electorate: humans ? 'humans' : 'affected_seats',
      eligible,
      rule: rule.quorumRule ?? 'majority',
      quorum: defaultQuorum(eligible.length),
      deadline: deadline ?? now + 10 * MIN,
      defaultOption: rule.defaultOnTimeout,
      votes: [],
      status: 'open',
    };
  }
  return { escalation, decision, parkTicket: Boolean(args.ticket) && parksTicket(rule) };
};

export const resolveByHuman = (esc: Escalation, rule: BlockerRule, actor: Actor, text: string, now: number, defaultContestMin: number): Escalation => {
  if (actor.kind !== 'human') fail('forbidden', 'only a human can resolve an escalation from the board');
  if (esc.status === 'contested') fail('conflict', `${esc.id} is being voted on (${esc.decisionId})`);
  if (esc.status !== 'open') fail('conflict', `${esc.id} is ${esc.status}`);
  const contestMin = rule.contestMin ?? defaultContestMin;
  return { ...esc, status: 'resolved_pending_contest', resolution: { text, by: actor.seatId, at: now, contestUntil: now + contestMin * MIN } };
};

export const answerByAgent = (esc: Escalation, rule: BlockerRule, actor: Actor, text: string, now: number): Escalation => {
  if (esc.status !== 'open') fail('conflict', `${esc.id} is ${esc.status}`);
  if (!['any_agent', 'self', 'owner'].includes(rule.resolver) && actor.kind === 'agent')
    fail('forbidden', `${rule.code} is resolved by ${rule.resolver}; an agent cannot answer it`);
  return { ...esc, status: 'resolved', resolution: { text, by: actor.seatId, at: now } };
};

export const contest = (
  esc: Escalation,
  rule: BlockerRule,
  actor: Actor,
  reason: string,
  humanSeats: readonly string[],
  now: number,
): { escalation: Escalation; decision: Omit<Decision, 'id'> } => {
  if (actor.kind !== 'human') fail('forbidden', 'only a human can contest');
  if (esc.status !== 'resolved_pending_contest' || !esc.resolution) fail('conflict', `${esc.id} has no resolution to contest`);
  const resolution = esc.resolution as NonNullable<Escalation['resolution']>;
  if (resolution.contestUntil !== undefined && now > resolution.contestUntil) fail('conflict', `the contest window for ${esc.id} has closed`);
  const deadline = now + (rule.timeoutMin ?? 10) * MIN;
  return {
    escalation: { ...esc, status: 'contested' },
    decision: {
      projectId: esc.projectId,
      escalationId: esc.id,
      question: `Contested ${esc.id} (${rule.code} ${rule.name}): uphold "${resolution.text.slice(0, 120)}"? Contest: ${reason.slice(0, 200)}`,
      options: ['uphold', 'overturn'],
      context: `Resolved by ${resolution.by}: ${resolution.text}\n\nContested by ${actor.seatId}: ${reason}`,
      electorate: 'humans',
      eligible: [...humanSeats],
      rule: 'majority',
      quorum: defaultQuorum(humanSeats.length),
      deadline,
      defaultOption: 'uphold',
      votes: [],
      status: 'open',
    },
  };
};

export type SweepOutcome =
  | { kind: 'none' }
  | { kind: 'finalized'; escalation: Escalation }
  | { kind: 'defaulted'; escalation: Escalation }
  | { kind: 'to_humans'; escalation: Escalation };

export const sweepEscalation = (esc: Escalation, rule: BlockerRule, now: number): SweepOutcome => {
  if (esc.status === 'resolved_pending_contest' && esc.resolution?.contestUntil !== undefined && now >= esc.resolution.contestUntil)
    return { kind: 'finalized', escalation: { ...esc, status: 'resolved' } };
  if (esc.status === 'open' && esc.deadline !== undefined && now >= esc.deadline && !esc.decisionId) {
    if (rule.resolver === 'any_agent') return { kind: 'to_humans', escalation: { ...esc, deadline: undefined } };
    return {
      kind: 'defaulted',
      escalation: { ...esc, status: 'defaulted', resolution: { text: rule.defaultOnTimeout, by: 'system', at: now } },
    };
  }
  return { kind: 'none' };
};

export const applyDecisionOutcome = (esc: Escalation, decision: Decision, now: number): Escalation => {
  if (decision.status === 'open') return esc;
  if (esc.status === 'contested') {
    if (decision.outcome === 'overturn') return { ...esc, status: 'open', resolution: undefined, decisionId: undefined };
    return { ...esc, status: 'resolved', resolution: esc.resolution ? { ...esc.resolution, contestUntil: undefined } : undefined };
  }
  return {
    ...esc,
    status: decision.status === 'made' ? 'resolved' : 'defaulted',
    resolution: { text: decision.outcome ?? decision.defaultOption, by: 'quorum', at: now },
  };
};

export const isClosed = (esc: Escalation): boolean => esc.status === 'resolved' || esc.status === 'defaulted';
