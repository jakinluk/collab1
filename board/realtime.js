/* CollabOne board: AppSync Events subscription (CONTRACT §7). Delivery is not confirmed, so the seq log is the truth. */
(function () {
  'use strict';
  const C1 = (window.C1 = window.C1 || {});

  function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * opts: { httpHost, realtimeUrl, channels: string[], getToken(): Promise<string|null>, onEvent(env), onStatus(status), catchUp(): Promise<void> }
   * status: 'connecting' | 'live' | 'offline'
   */
  function Realtime(opts) {
    this.opts = opts;
    this.ws = null;
    this.attempt = 0;
    this.kaTimer = null;
    this.timeoutMs = 300000;
    this.stopped = false;
    this.subIds = {};
    this.pending = 0;
  }

  Realtime.prototype.start = function () {
    this.stopped = false;
    this.connect();
  };

  Realtime.prototype.stop = function () {
    this.stopped = true;
    clearTimeout(this.kaTimer);
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (e) {
        /* ignore */
      }
    }
  };

  Realtime.prototype.status = function (s) {
    if (this.opts.onStatus) this.opts.onStatus(s);
  };

  Realtime.prototype.connect = async function () {
    if (this.stopped) return;
    this.status('connecting');
    const token = await this.opts.getToken();
    if (!token) {
      this.status('offline');
      return;
    }
    const auth = { host: this.opts.httpHost, Authorization: token };
    let ws;
    try {
      ws = new WebSocket(this.opts.realtimeUrl, ['aws-appsync-event-ws', 'header-' + b64url(JSON.stringify(auth))]);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (msg) => this.onMessage(msg.data, auth);
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      clearTimeout(this.kaTimer);
      if (!this.stopped) {
        this.status('offline');
        this.scheduleReconnect();
      }
    };
  };

  Realtime.prototype.armKeepAlive = function () {
    clearTimeout(this.kaTimer);
    this.kaTimer = setTimeout(() => {
      if (this.ws) {
        try {
          this.ws.close(4000);
        } catch (e) {
          /* ignore */
        }
      }
    }, this.timeoutMs);
  };

  Realtime.prototype.onMessage = async function (raw, auth) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      return;
    }
    switch (m.type) {
      case 'connection_ack':
        this.timeoutMs = m.connectionTimeoutMs || 300000;
        this.armKeepAlive();
        this.subIds = {};
        this.pending = 0;
        (this.opts.channels || [this.opts.channel]).forEach((channel) => {
          const id = uuid();
          this.subIds[id] = channel;
          this.pending++;
          this.ws.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: auth }));
        });
        break;
      case 'ka':
        this.armKeepAlive();
        break;
      case 'subscribe_success':
        this.pending--;
        if (this.pending > 0) break;
        this.attempt = 0;
        this.status('live');
        try {
          await this.opts.catchUp();
        } catch (e) {
          /* the next event retries the catch-up */
        }
        break;
      case 'data': {
        const list = Array.isArray(m.event) ? m.event : [m.event];
        list.forEach((item) => {
          try {
            const env = typeof item === 'string' ? JSON.parse(item) : item;
            if (env && typeof env.seq === 'number') this.opts.onEvent(env);
          } catch (e) {
            /* skip malformed */
          }
        });
        break;
      }
      case 'subscribe_error':
      case 'connection_error':
      case 'error':
        try {
          this.ws.close(4001);
        } catch (e) {
          /* ignore */
        }
        break;
      default:
        break;
    }
  };

  Realtime.prototype.scheduleReconnect = function () {
    if (this.stopped) return;
    this.attempt = Math.min(this.attempt + 1, 8);
    const base = Math.min(30000, 500 * Math.pow(2, this.attempt));
    const delay = base / 2 + Math.random() * (base / 2);
    setTimeout(() => this.connect(), delay);
  };

  C1.Realtime = Realtime;
})();
