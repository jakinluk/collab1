import test from 'node:test';
import assert from 'node:assert/strict';
import { AppSyncClient, probeAck } from '../lib/realtime.mjs';

class FakeSocket {
  static last = null;
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.closed = null;
    FakeSocket.last = this;
    setImmediate(() => this.onopen?.());
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close(code) {
    this.closed = code;
    setImmediate(() => this.onclose?.({ code }));
  }
  frame(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const tick = () => new Promise((r) => setImmediate(r));

test('AppSync client: init, subscribe to all channels, data, ka', async () => {
  const events = [];
  let ready = 0;
  const statuses = [];
  const c = new AppSyncClient({
    httpHost: 'h.example',
    realtimeUrl: 'wss://r.example/event/realtime',
    token: 'h1a_x',
    channels: ['/h1/all', '/h1/p/p1', '/h1/s/me'],
    WebSocketImpl: FakeSocket,
    onEvent: (e) => events.push(e),
    onReady: () => ready++,
    onStatus: (s) => statuses.push(s),
  });
  c.start();
  await tick();
  const ws = FakeSocket.last;
  assert.equal(ws.protocols[0], 'aws-appsync-event-ws');
  assert.deepEqual(ws.sent[0], { type: 'connection_init' });
  ws.frame({ type: 'connection_ack', connectionTimeoutMs: 300000 });
  const subs = ws.sent.filter((m) => m.type === 'subscribe');
  assert.deepEqual(subs.map((s) => s.channel), ['/h1/all', '/h1/p/p1', '/h1/s/me']);
  assert.deepEqual(subs[0].authorization, { host: 'h.example', Authorization: 'h1a_x' });
  for (const s of subs) ws.frame({ type: 'subscribe_success', id: s.id });
  assert.equal(ready, 1);
  assert.ok(statuses.includes('live'));
  ws.frame({ type: 'ka' });
  ws.frame({ type: 'data', id: subs[0].id, event: [JSON.stringify({ seq: 7, type: 'ticket.ready', summary: 's' }), '{bad json', JSON.stringify({ nope: 1 })] });
  assert.deepEqual(events.map((e) => e.seq), [7]);
  c.stop();
});

test('AppSync client reconnects after a subscribe error', async () => {
  const c = new AppSyncClient({ httpHost: 'h', realtimeUrl: 'wss://r', token: 't', channels: ['/h1/all'], WebSocketImpl: FakeSocket, onEvent: () => {} });
  c.start();
  await tick();
  const first = FakeSocket.last;
  first.frame({ type: 'connection_ack' });
  first.frame({ type: 'subscribe_error', errors: [{ errorType: 'UnauthorizedException' }] });
  assert.equal(first.closed, 4001);
  c.stop();
});

test('probeAck resolves on connection_ack', async () => {
  class AckSocket extends FakeSocket {
    send(s) {
      super.send(s);
      setImmediate(() => this.frame({ type: 'connection_ack', connectionTimeoutMs: 300000 }));
    }
  }
  const ack = await probeAck({ httpHost: 'h', realtimeUrl: 'wss://r', token: 't', WebSocketImpl: AckSocket, timeoutMs: 2000 });
  assert.equal(ack.connectionTimeoutMs, 300000);
});
