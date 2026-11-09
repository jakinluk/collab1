import { randomUUID } from 'node:crypto';
import { jitteredBackoff } from './util.mjs';

export const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const authHeader = (httpHost, token) => ({ host: httpHost, Authorization: token });

export const subprotocols = (httpHost, token) => ['aws-appsync-event-ws', `header-${b64url(JSON.stringify(authHeader(httpHost, token)))}`];

export const channelsFor = ({ seatId }) => ['/h1/all', '/h1/p/*', `/h1/s/${seatId}`];

/**
 * Minimal AppSync Events client.
 * opts: { httpHost, realtimeUrl, token, channels, WebSocketImpl?, onEvent(env), onReady()?, onStatus(s)?, log?(msg) }
 */
export class AppSyncClient {
  constructor(opts) {
    this.o = opts;
    this.WS = opts.WebSocketImpl ?? globalThis.WebSocket;
    this.ws = null;
    this.attempt = 0;
    this.stopped = false;
    this.kaTimer = null;
    this.timeoutMs = 300000;
    this.subs = new Map();
    this.pending = 0;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.kaTimer);
    try {
      this.ws?.close(1000);
    } catch {
      /* already closed */
    }
  }

  status(s) {
    this.o.onStatus?.(s);
  }

  connect() {
    if (this.stopped) return;
    this.status('connecting');
    let ws;
    try {
      ws = new this.WS(this.o.realtimeUrl, subprotocols(this.o.httpHost, this.o.token));
    } catch (e) {
      this.o.log?.(`websocket failed: ${e?.message ?? e}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.send({ type: 'connection_init' });
    ws.onmessage = (m) => this.handleFrame(typeof m.data === 'string' ? m.data : String(m.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(this.kaTimer);
      if (this.stopped) return;
      this.status('offline');
      this.scheduleReconnect();
    };
  }

  send(obj) {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }

  armKeepAlive() {
    clearTimeout(this.kaTimer);
    this.kaTimer = setTimeout(() => {
      this.o.log?.('no keep-alive from AppSync; reconnecting');
      try {
        this.ws?.close(4000);
      } catch {
        /* ignore */
      }
    }, this.timeoutMs);
    this.kaTimer.unref?.();
  }

  handleFrame(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.type) {
      case 'connection_ack': {
        this.timeoutMs = m.connectionTimeoutMs || 300000;
        this.armKeepAlive();
        this.subs.clear();
        this.pending = 0;
        for (const channel of this.o.channels) {
          const id = randomUUID();
          this.subs.set(id, channel);
          this.pending++;
          this.send({ type: 'subscribe', id, channel, authorization: authHeader(this.o.httpHost, this.o.token) });
        }
        break;
      }
      case 'ka':
        this.armKeepAlive();
        break;
      case 'subscribe_success':
        this.pending--;
        if (this.pending <= 0) {
          this.attempt = 0;
          this.status('live');
          this.o.onReady?.();
        }
        break;
      case 'data': {
        const items = Array.isArray(m.event) ? m.event : [m.event];
        for (const it of items) {
          try {
            const env = typeof it === 'string' ? JSON.parse(it) : it;
            if (env && typeof env.seq === 'number') this.o.onEvent(env);
          } catch {
            /* skip malformed event */
          }
        }
        break;
      }
      case 'subscribe_error':
      case 'connection_error':
      case 'error':
      case 'broadcast_error':
        this.o.log?.(`appsync ${m.type}: ${(m.errors ?? []).map((e) => e.errorType || e.message).join(', ') || 'unknown'}`);
        if (m.type !== 'broadcast_error') {
          try {
            this.ws?.close(4001);
          } catch {
            /* ignore */
          }
        }
        break;
      default:
        break;
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.attempt = Math.min(this.attempt + 1, 10);
    const t = setTimeout(() => this.connect(), jitteredBackoff(this.attempt));
    t.unref?.();
  }
}

/** One-shot connectivity probe used by `h1 doctor`. Resolves with ack timeout info or rejects. */
export function probeAck({ httpHost, realtimeUrl, token, timeoutMs = 8000, WebSocketImpl = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    let ws;
    const timer = setTimeout(() => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      reject(new Error('no connection_ack within ' + timeoutMs / 1000 + 's'));
    }, timeoutMs);
    try {
      ws = new WebSocketImpl(realtimeUrl, subprotocols(httpHost, token));
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (m) => {
      let f;
      try {
        f = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (f.type === 'connection_ack') {
        clearTimeout(timer);
        try {
          ws.close(1000);
        } catch {
          /* ignore */
        }
        resolve(f);
      } else if (/error/.test(f.type)) {
        clearTimeout(timer);
        reject(new Error(`${f.type}: ${(f.errors ?? []).map((e) => e.errorType || e.message).join(', ')}`));
      }
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      clearTimeout(timer);
      reject(new Error(`closed (${e?.code ?? '?'}) before acknowledgement`));
    };
  });
}
