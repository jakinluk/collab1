import { truncate } from './util.mjs';

const SKILL_EVENTS = new Set(['skill.published', 'skill.updated', 'skill.retired']);
const KNOWLEDGE_EVENTS = new Set(['tip.shared', 'playbook.shared', 'knowledge.retired', ...SKILL_EVENTS]);
const BROADCAST_EVENTS = new Set(['goal.set', 'rules.updated', 'phase.changed', 'project.created', 'project.updated', 'plan.loaded', 'settings.updated', 'epic.state_changed', 'epic.dates_moved', 'epic.scope_changed', 'decision.recorded', 'input.version_approved']);
const ESCALATION_EVENTS = /^escalation\./;

const lanesMatch = (ticketLanes, seatLanes) => !seatLanes?.length || !ticketLanes?.length || ticketLanes.some((l) => seatLanes.includes(l));

/**
 * ctx: { seatId, projectId, lanes, myTickets:Set<string> }
 * Returns null (ignore) or { line, human, syncSkills }.
 */
export function classify(env, ctx) {
  const t = env.type;
  const mine = env.projectId === undefined || env.projectId === ctx.projectId || (ctx.projects ?? []).includes(env.projectId);
  const fromMe = env.from === ctx.seatId || String(env.from ?? '').startsWith(`${ctx.seatId}/`);
  const toMe = env.to === ctx.seatId;
  const toHumans = env.to === 'humans';
  let hint = '';
  let human = false;

  if (t === 'message') {
    if (fromMe) return null;
    if (env.to && !toMe) return null;
    return out(env, toMe ? 'DM' : 'MSG', '', false);
  }
  if (t === 'tool.released') return out(env, 'UPDATE', '→ /c1:update, then /reload-plugins', true);
  if (t.startsWith('change.')) {
    if (!mine) return null;
    const id = env.data?.changeId ?? '';
    if (t === 'change.opened') return out(env, 'CHANGE', env.data?.replanTicket ? `→ c1 ticket book ${env.data.replanTicket}, then /c1:assess ${id}` : '', false);
    if (t === 'change.assessed') return out(env, 'CHANGE', env.data?.status === 'proposed' ? (env.data?.needsHuman?.length ? '→ a human decides in the board' : `→ c1 change approve ${id}`) : '', Boolean(env.data?.needsHuman?.length));
    if (t === 'change.approved') return out(env, 'CHANGE', '', toHumans);
    return out(env, 'CHANGE', '', false);
  }
  if (t === 'input.added' || t === 'input.version_added') return mine ? out(env, 'INPUT', '', toHumans) : null;
  if (t === 'ticket.ready' || (t === 'ticket.added' && env.data?.status === 'ready')) {
    if (!mine || !lanesMatch(env.data?.lanes, ctx.lanes)) return null;
    hint = '→ /c1:ticket next';
    return out(env, '', hint, false);
  }
  if (t === 'ticket.review_needed') {
    if (!mine || fromMe) return null;
    return out(env, 'REVIEW', '→ c1 review next', false);
  }
  if (t.startsWith('ticket.')) {
    if (env.ticketId && ctx.myTickets?.has(env.ticketId) && !fromMe) return out(env, '', '', false);
    if (toMe && !fromMe) return out(env, '', '', false);
    return null;
  }
  if (t === 'decision.opened') {
    const eligible = env.data?.eligible;
    const forMe = toHumans || (Array.isArray(eligible) ? eligible.includes(ctx.seatId) : mine);
    if (!forMe) return null;
    const id = env.data?.decisionId ?? '';
    return out(env, '', id ? `→ /c1:decide ${id}` : '', toHumans);
  }
  if (t === 'decision.made' || t === 'decision.defaulted') return mine ? out(env, '', '', false) : null;
  if (ESCALATION_EVENTS.test(t)) {
    if (toMe || toHumans) {
      human = toHumans;
      return out(env, '', toHumans ? '→ needs a human in the board' : '', human);
    }
    if (env.ticketId && ctx.myTickets?.has(env.ticketId)) return out(env, '', '', false);
    if (t === 'escalation.raised' && mine && env.data?.resolver && /agent|self/.test(env.data.resolver) && !fromMe)
      return out(env, 'HELP?', env.data?.escalationId ? `→ c1 answer ${env.data.escalationId}` : '', false);
    return null;
  }
  if (KNOWLEDGE_EVENTS.has(t)) {
    if (!mine) return null;
    const r = out(env, SKILL_EVENTS.has(t) ? 'SKILL' : 'KB', SKILL_EVENTS.has(t) && t !== 'skill.retired' ? '→ synced; use it before figuring it out yourself' : '', false);
    r.syncSkills = SKILL_EVENTS.has(t);
    return r;
  }
  if (BROADCAST_EVENTS.has(t)) return mine ? out(env, '', '', false) : null;
  if (t === 'proposal.created') return toHumans ? out(env, '', '→ approve in the board', true) : null;
  if (t === 'proposal.approved' || t === 'proposal.rejected' || t === 'proposal.expired') return toMe ? out(env, '', '', false) : null;
  if (t === 'session.state' && toHumans && !fromMe) return out(env, '', '', true);
  return null;
}

function out(env, tag, hint, human) {
  const prefix = tag ? `[c1] ${tag} ` : '[c1] ';
  const tail = hint ? ` ${hint}` : '';
  const room = 200 - prefix.length - tail.length;
  return { line: `${prefix}${truncate(env.summary, room)}${tail}`, human, syncSkills: false };
}

export class RateLimiter {
  constructor(max = 20, windowMs = 60000, now = () => Date.now()) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.start = now();
    this.count = 0;
    this.suppressed = 0;
    this.firstSuppressedSeq = null;
  }

  /** Returns the lines to print for this event (0, 1 or 2 lines). */
  push(line, seq) {
    const t = this.now();
    const lines = [];
    if (t - this.start >= this.windowMs) {
      if (this.suppressed) lines.push(`[c1] … ${this.suppressed} more events were hidden (c1 events --since ${this.firstSuppressedSeq - 1})`);
      this.start = t;
      this.count = 0;
      this.suppressed = 0;
      this.firstSuppressedSeq = null;
    }
    if (this.count < this.max) {
      this.count++;
      lines.push(line);
    } else {
      if (!this.suppressed) this.firstSuppressedSeq = seq;
      this.suppressed++;
    }
    return lines;
  }
}

/** Orders events by seq; asks for catch-up on gaps. */
export class SeqGate {
  constructor(lastSeq = 0) {
    this.lastSeq = lastSeq;
  }

  /** 'apply' | 'dup' | 'gap' */
  check(seq) {
    if (seq <= this.lastSeq) return 'dup';
    if (seq === this.lastSeq + 1) return 'apply';
    return 'gap';
  }

  advance(seq) {
    if (seq > this.lastSeq) this.lastSeq = seq;
  }
}
