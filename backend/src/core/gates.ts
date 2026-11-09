import type { ChangeRequest, HubMode, HumanAction, Settings, Ticket } from '../shared/types';

/**
 * Ongoing mode is agent-native: agents may take these actions themselves. A human steps in only when an
 * action meets one of the conditions in needsHumanForChange / needsHumanForEpic, or for hub administration.
 */
export const ONGOING_AGENT_ACTIONS: readonly HumanAction[] = [
  'project.create',
  'project.update',
  'goal.set',
  'plan.load',
  'epic.update',
  'input.approve',
  'decision.record',
  'change.approve',
  'change.reject',
];

export const agentActions = (mode: HubMode, settings: Settings): readonly HumanAction[] =>
  settings.agentActions ?? (mode === 'ongoing' ? ONGOING_AGENT_ACTIONS : []);

/** The conditions under which applying a change request needs a human. */
export const needsHumanForChange = (cr: ChangeRequest, tickets: readonly Ticket[], hasGoal = true): string[] => {
  const reasons: string[] = [];
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const rework = cr.impact.filter((e) => e.verdict === 'rework' || e.verdict === 'revert');
  if (rework.length) reasons.push(`reworks merged code (${rework.map((e) => e.ticketId).join(', ')})`);
  if (hasGoal && (cr.scope?.statement || cr.scope?.definitionOfDone)) reasons.push('changes the epic goal or definition of done');
  const stopped = cr.impact.filter((e) => ['supersede', 'obsolete', 'defer'].includes(e.verdict ?? '') && ['booked', 'in_progress', 'review'].includes(byId.get(e.ticketId)?.status ?? ''));
  if (stopped.length) reasons.push(`stops work in progress (${stopped.map((e) => e.ticketId).join(', ')})`);
  return reasons;
};
