import type { ActorKind, Decision, Electorate, QuorumRule, Vote } from '../shared/types';
import { fail } from './errors';

export const defaultQuorum = (eligible: number): number => Math.max(1, Math.ceil(eligible / 2));

export const castVote = (decision: Decision, seat: string, by: ActorKind, option: string, why: string, now: number): Decision => {
  if (decision.status !== 'open') fail('conflict', `decision ${decision.id} is closed`);
  if (now > decision.deadline) fail('conflict', `decision ${decision.id} is past its deadline`);
  if (!decision.options.includes(option)) fail('invalid', `option must be one of: ${decision.options.join(' | ')}`);
  if (decision.eligible.length > 0 && !decision.eligible.includes(seat)) fail('forbidden', `seat ${seat} is not eligible to vote on ${decision.id}`);
  if (decision.electorate === 'humans' && by === 'agent') fail('forbidden', `${decision.id} is decided by humans only`);
  const votes = decision.votes.filter((v) => !(v.seat === seat && v.by === by));
  votes.push({ seat, option, by, why, ts: now });
  return { ...decision, votes };
};

export const effectiveVotes = (decision: Decision): Vote[] => {
  const bySeat = new Map<string, Vote>();
  for (const v of decision.votes) {
    if (decision.electorate === 'humans' && v.by !== 'human') continue;
    const prev = bySeat.get(v.seat);
    if (!prev || (v.by === 'human' && prev.by === 'agent') || (v.by === prev.by && v.ts >= prev.ts)) bySeat.set(v.seat, v);
  }
  return [...bySeat.values()];
};

export interface Tally {
  counts: Record<string, number>;
  total: number;
  leader?: string;
  passed: boolean;
  outcome?: string;
}

export const tally = (decision: Decision): Tally => {
  const votes = effectiveVotes(decision);
  const counts: Record<string, number> = Object.fromEntries(decision.options.map((o) => [o, 0]));
  for (const v of votes) counts[v.option] = (counts[v.option] ?? 0) + 1;
  const total = votes.length;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [leader, leadCount] = sorted[0] ?? [undefined, 0];
  const tie = sorted.length > 1 && sorted[1][1] === leadCount;
  const meetsQuorum = total >= decision.quorum;
  const passes = (rule: QuorumRule): { passed: boolean; outcome?: string } => {
    switch (rule) {
      case 'majority':
        return leadCount * 2 > total && !tie && meetsQuorum ? { passed: true, outcome: leader } : { passed: false };
      case 'two_thirds':
        return leadCount * 3 >= total * 2 && !tie && meetsQuorum ? { passed: true, outcome: leader } : { passed: false };
      case 'unanimous':
        return total > 0 && leadCount === total && meetsQuorum ? { passed: true, outcome: leader } : { passed: false };
      case 'consent': {
        const proposal = decision.options[0];
        const objections = total - (counts[proposal] ?? 0);
        return objections === 0 ? { passed: true, outcome: proposal } : { passed: false };
      }
    }
  };
  const r = passes(decision.rule);
  return { counts, total, leader, ...r };
};

const allEligibleHumansVoted = (decision: Decision): boolean =>
  decision.eligible.length > 0 &&
  decision.eligible.every((seat) => decision.votes.some((v) => v.seat === seat && v.by === 'human'));

const allEligibleVoted = (decision: Decision): boolean =>
  decision.eligible.length > 0 && decision.eligible.every((seat) => decision.votes.some((v) => v.seat === seat));

export const canCloseEarly = (decision: Decision): boolean => {
  if (decision.rule === 'consent') return false;
  if (decision.electorate === 'agents') return allEligibleVoted(decision);
  return allEligibleHumansVoted(decision);
};

export const settle = (decision: Decision, now: number): Decision => {
  if (decision.status !== 'open') return decision;
  const early = canCloseEarly(decision);
  if (!early && now < decision.deadline) return decision;
  const t = tally(decision);
  if (t.passed && t.outcome !== undefined) return { ...decision, status: 'made', outcome: t.outcome };
  if (early && now < decision.deadline) return decision;
  return { ...decision, status: 'defaulted', outcome: decision.defaultOption };
};

export const electorateFor = (resolver: string): Electorate => (resolver === 'human_quorum' ? 'humans' : 'affected_seats');
