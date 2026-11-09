import { describe, expect, it } from 'vitest';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { channelAllowed, eventsDecision, resolveIdentity, type EventsAuthorizerEvent } from '../src/handlers/authorizer';
import { batches, envelopesFrom } from '../src/handlers/fanout';
import { EventsPublisher, groupByChannel } from '../src/adapters/publisher';
import type { Envelope } from '../src/shared/types';
import { safeEqual } from '../src/handlers/context';
import { parseBody } from '../src/handlers/api';

const agentTok = 'h1a_' + 'b'.repeat(43);
const deps = {
  agent: async (t: string) => (t === agentTok ? { seatId: 'ania', workerId: 'w1' } : undefined),
  human: async (t: string) => (t === 'good.jwt.token' ? { sub: 'sub-1', email: 'b@x' } : undefined),
  seatForSub: async (sub: string) => (sub === 'sub-1' ? 'bob' : undefined),
};

const env = (seq: number, over: Partial<Envelope> = {}): Envelope => ({
  seq,
  ts: 1,
  stream: 'tasks',
  type: 'ticket.booked',
  from: 'ania',
  fromKind: 'agent',
  summary: `e${seq}`,
  projectId: 'p1',
  ...over,
});

describe('authorizer', () => {
  it('resolves agent tokens, Cognito tokens and rejects the rest', async () => {
    expect(await resolveIdentity(`Bearer ${agentTok}`, deps)).toEqual({ seatId: 'ania', kind: 'agent', workerId: 'w1' });
    expect(await resolveIdentity('good.jwt.token', deps)).toEqual({ seatId: 'bob', kind: 'human', sub: 'sub-1', email: 'b@x' });
    expect(await resolveIdentity('h1a_short', deps)).toBeUndefined();
    expect(await resolveIdentity('bad', deps)).toBeUndefined();
    expect(await resolveIdentity(undefined, deps)).toBeUndefined();
  });

  it('allows only own seat channels, project channels and the hub channel', () => {
    const me = { seatId: 'ania', kind: 'agent' as const };
    expect(channelAllowed('/h1/all', me)).toBe(true);
    expect(channelAllowed('/h1/p/offline-capture', me)).toBe(true);
    expect(channelAllowed('/h1/p/*', me)).toBe(true);
    expect(channelAllowed('/h1/s/ania', me)).toBe(true);
    expect(channelAllowed('/h1/s/bob', me)).toBe(false);
    expect(channelAllowed('/h1/s/*', me)).toBe(false);
    expect(channelAllowed('/h1/*', me)).toBe(false);
    expect(channelAllowed('/other/all', me)).toBe(false);
    expect(channelAllowed('/h1/all', { seatId: '', kind: 'human' })).toBe(false);
  });

  it('never authorizes client publishes and never caches', () => {
    const base: EventsAuthorizerEvent = { authorizationToken: 'x', requestContext: { apiId: 'a', accountId: '1', requestId: 'r', operation: 'EVENT_SUBSCRIBE', channel: '/h1/all' } };
    const id = { seatId: 'ania', kind: 'agent' as const };
    expect(eventsDecision(base, id)).toMatchObject({ isAuthorized: true, ttlOverride: 0 });
    expect(eventsDecision({ ...base, requestContext: { ...base.requestContext, operation: 'EVENT_PUBLISH' } }, id).isAuthorized).toBe(false);
    expect(eventsDecision({ ...base, requestContext: { ...base.requestContext, operation: 'EVENT_CONNECT', channel: null } }, id).isAuthorized).toBe(true);
    expect(eventsDecision(base, undefined).isAuthorized).toBe(false);
  });

  it('compares secrets in constant time and rejects mismatches', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abd', 'abc')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('ab', 'abc')).toBe(false);
  });
});

describe('fan-out and publishing', () => {
  it('routes envelopes to channels in batches of at most five', () => {
    const list = [
      ...Array.from({ length: 7 }, (_, i) => env(i + 1)),
      env(8, { to: 'bob' }),
      env(9, { projectId: undefined }),
      env(10, { to: 'humans', projectId: undefined }),
    ];
    expect(groupByChannel(list).map((b) => [b.channel, b.events.length])).toEqual([
      ['/h1/p/p1', 5],
      ['/h1/p/p1', 2],
      ['/h1/s/bob', 1],
      ['/h1/all', 2],
    ]);
    expect(JSON.parse(groupByChannel(list)[0].events[0]).seq).toBe(1);
  });

  it('reads only EVENT inserts from the stream and remembers batch starts', () => {
    const rec = (seq: number, pk = 'EVENT', name: 'INSERT' | 'MODIFY' | 'REMOVE' = 'INSERT') => ({
      eventName: name,
      dynamodb: { SequenceNumber: `n${seq}`, NewImage: marshall({ ...env(seq), PK: pk, SK: String(seq).padStart(12, '0'), ttl: 1 }) as Record<string, AttributeValue> },
    });
    const event = { Records: [rec(2), rec(1), rec(3, 'TICKET#T1'), rec(4, 'EVENT', 'REMOVE')] } as unknown as DynamoDBStreamEvent;
    const items = envelopesFrom(event).sort((a, b) => a.envelope.seq - b.envelope.seq);
    expect(items.map((i) => i.envelope.seq)).toEqual([1, 2]);
    expect(items[0].envelope).not.toHaveProperty('PK');
    expect(batches(items)).toEqual([{ firstSeqNo: 'n1', channel: '/h1/p/p1', events: [expect.any(String), expect.any(String)] }]);
  });

  it('signs publishes with SigV4 for the appsync service', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const p = new EventsPublisher(
      'abc.appsync-api.us-east-1.amazonaws.com',
      'us-east-1',
      async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok' }),
      async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return { ok: true, status: 200, text: async () => '{}' };
      },
    );
    expect(await p.publishEnvelopes([env(1), env(2, { to: 'bob' })])).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://abc.appsync-api.us-east-1.amazonaws.com/event');
    const auth = Object.entries(calls[0].headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/appsync\/aws4_request/);
    expect(JSON.parse(calls[1].body)).toMatchObject({ channel: '/h1/s/bob' });
    expect(typeof JSON.parse(calls[0].body).events[0]).toBe('string');
  });

  it('surfaces publish failures', async () => {
    const p = new EventsPublisher('h', 'us-east-1', async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), async () => ({ ok: false, status: 401, text: async () => 'denied' }));
    await expect(p.publish('/h1/all', ['"x"'])).rejects.toThrow(/401 denied/);
  });
});

describe('api body parsing', () => {
  it('rejects oversized and malformed bodies', () => {
    expect(parseBody({ body: '{"a":1}', isBase64Encoded: false })).toEqual({ a: 1 });
    expect(parseBody({ body: Buffer.from('{"b":2}').toString('base64'), isBase64Encoded: true })).toEqual({ b: 2 });
    expect(() => parseBody({ body: '{', isBase64Encoded: false })).toThrow(/not valid JSON/);
    expect(() => parseBody({ body: JSON.stringify({ x: 'y'.repeat(300 * 1024) }), isBase64Encoded: false })).toThrow(/256 KB/);
  });
});
