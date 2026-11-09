import type { Envelope, EnvelopeInput, Stream } from '../shared/types';

export const MAX_SUMMARY = 200;
export const MAX_DATA_BYTES = 2048;

const STREAM_BY_PREFIX: [string, Stream][] = [
  ['ticket.', 'tasks'],
  ['plan.', 'tasks'],
  ['tip.', 'knowledge'],
  ['playbook.', 'knowledge'],
  ['skill.', 'knowledge'],
  ['knowledge.', 'knowledge'],
  ['escalation.', 'escalations'],
  ['decision.', 'decisions'],
  ['vote.', 'decisions'],
  ['session.', 'presence'],
  ['seat.', 'presence'],
  ['message', 'dm'],
];

export const streamFor = (type: string): Stream => STREAM_BY_PREFIX.find(([p]) => type.startsWith(p))?.[1] ?? 'broadcast';

export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const shrinkData = (data: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!data) return undefined;
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') <= MAX_DATA_BYTES) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const candidate = { ...out, [k]: typeof v === 'string' ? truncate(v, 300) : v };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_DATA_BYTES) {
      out.truncated = true;
      break;
    }
    out[k] = candidate[k];
  }
  return out;
};

export const envelope = (e: {
  type: string;
  from: string;
  fromKind: Envelope['fromKind'];
  summary: string;
  projectId?: string;
  ticketId?: string;
  to?: string;
  data?: Record<string, unknown>;
  stream?: Stream;
}): EnvelopeInput => {
  const out: EnvelopeInput = {
    stream: e.stream ?? streamFor(e.type),
    type: e.type,
    from: e.from,
    fromKind: e.fromKind,
    summary: truncate(e.summary.replace(/\s+/g, ' ').trim(), MAX_SUMMARY),
  };
  if (e.projectId) out.projectId = e.projectId;
  if (e.ticketId) out.ticketId = e.ticketId;
  if (e.to) out.to = e.to;
  const data = shrinkData(e.data);
  if (data) out.data = data;
  return out;
};

export const finalize = (input: EnvelopeInput, seq: number, ts: number): Envelope => ({ seq, ts, ...input });

export const NAMESPACE = 'c1';

export const channelFor = (e: Pick<Envelope, 'to' | 'projectId'>): string => {
  if (e.to && e.to !== 'all' && e.to !== 'humans') return `/${NAMESPACE}/s/${e.to}`;
  if (e.projectId) return `/${NAMESPACE}/p/${e.projectId}`;
  return `/${NAMESPACE}/all`;
};
