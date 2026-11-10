/*
 * Local CollabOne hub for end-to-end runs on one machine. NOT for the event.
 *
 * It runs the real Hub and the real API router, authorizer decisions and channel routing,
 * with these stand-ins for the AWS services:
 *   DynamoDB           -> the in-memory FakeDynamo used by the unit tests (optional JSON snapshot)
 *   DynamoDB Stream +
 *   fan-out Lambda     -> every committed EVENT item is pushed to WebSocket subscribers right away
 *   AppSync Events     -> a WebSocket server that speaks the AppSync Events protocol on /event/realtime
 *   Cognito            -> a dev login page plus /oauth2/token issuing HMAC-signed ID tokens
 *   S3 skill bucket    -> an in-memory object map behind /_files/<key>
 *   Scheduler + sweep  -> a timer calling hub.sweep() (and POST /_dev/sweep)
 *   CloudFront         -> this server: it serves board/ and routes /api/v1/*
 *
 * Usage: npx tsx scripts/local-hub.ts [--port 8787] [--mode event|ongoing] [--state ./local-state.json] [--sweep-ms 60000]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Hub } from '../src/app/hub';
import { Store } from '../src/adapters/store';
import { strip } from '../src/adapters/keys';
import type { SkillFiles } from '../src/adapters/s3';
import { MAX_SKILL_BYTES } from '../src/adapters/s3';
import { API_PREFIX, CLIENT_VERSION_HEADER, dispatch, parseBody, type AuthContext } from '../src/handlers/api';
import { eventsDecision, resolveIdentity, type EventsAuthorizerEvent, type Identity } from '../src/handlers/authorizer';
import { channelFor } from '../src/core/envelope';
import type { Envelope } from '../src/shared/types';
import { FakeDynamo } from '../test/fake-dynamo';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PORT = Number(arg('port', process.env.PORT ?? '8787'));
const HOST = arg('host', '127.0.0.1');
const BASE = `http://localhost:${PORT}`;
const STATE = arg('state', '');
const SWEEP_MS = Number(arg('sweep-ms', '60000'));
const MODE = arg('mode', process.env.HUB_MODE ?? 'event') === 'ongoing' ? 'ongoing' : 'event';
const TOOL_REPO = arg('tool-repo', process.env.TOOL_REPO_URL ?? '');
const BOARD_DIR = path.resolve(__dirname, '../../board');
const DEV_SECRET = randomBytes(32);
const CLIENT_ID = 'local-board';

let clockOffset = 0;
const now = (): number => Date.now() + clockOffset;

class StreamingDynamo extends FakeDynamo {
  constructor(private readonly onEvent: (env: Envelope) => void, private readonly onChange: () => void) {
    super();
  }

  override async send(cmd: Parameters<FakeDynamo['send']>[0]): Promise<Record<string, unknown>> {
    const out = await super.send(cmd);
    if (cmd.constructor.name === 'TransactWriteCommand' || cmd.constructor.name === 'UpdateCommand') this.onChange();
    if (cmd.constructor.name === 'TransactWriteCommand') {
      const ops = (cmd.input.TransactItems ?? []) as Record<string, { Item?: Record<string, unknown> }>[];
      for (const op of ops) {
        const item = op.Put?.Item;
        if (item && item.PK === 'EVENT') this.onEvent(strip<Envelope>(structuredClone(item)));
      }
    }
    return out;
  }
}

// ---------- AppSync Events stand-in ----------

interface Sub {
  id: string;
  channel: string;
}
const sockets = new Map<WebSocket, { identity: Identity; subs: Sub[] }>();

const channelMatches = (subscribed: string, published: string): boolean =>
  subscribed === published || (subscribed.endsWith('/*') && published.startsWith(subscribed.slice(0, -1)) && !published.slice(subscribed.length - 1).includes('/'));

const publish = (env: Envelope): void => {
  const channel = channelFor(env);
  const payload = JSON.stringify(env);
  for (const [ws, st] of sockets)
    for (const s of st.subs) if (channelMatches(s.channel, channel)) ws.send(JSON.stringify({ type: 'data', id: s.id, event: payload }));
};

// ---------- persistence ----------

let saveTimer: NodeJS.Timeout | undefined;
const db: StreamingDynamo = new StreamingDynamo(publish, () => {
  if (!STATE) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(STATE, JSON.stringify([...db.items.entries()])), 200);
});
if (STATE && fs.existsSync(STATE)) for (const [k, v] of JSON.parse(fs.readFileSync(STATE, 'utf8')) as [string, Record<string, unknown>][]) db.items.set(k, v);

// ---------- S3 stand-in ----------

const objects = new Map<string, Buffer>();
const fileSig = (key: string, op: string, exp: number, bytes: string): string => createHmac('sha256', DEV_SECRET).update(`${op}|${key}|${exp}|${bytes}`).digest('hex').slice(0, 32);
const fileUrl = (key: string, op: 'put' | 'get', bytes = ''): string => {
  const exp = now() + 300_000;
  return `${BASE}/_files/${encodeURIComponent(key)}?op=${op}&exp=${exp}&bytes=${bytes}&sig=${fileSig(key, op, exp, bytes)}`;
};
const files = {
  // Like S3 with a signed content-length: the PUT must carry exactly `bytes` bytes.
  uploadUrl: async (key: string, bytes: number) => fileUrl(key, 'put', String(bytes)),
  downloadUrl: async (key: string) => fileUrl(key, 'get'),
  inspect: async (key: string) => ({ exists: objects.has(key), bytes: objects.get(key)?.length ?? 0, contentType: 'application/gzip' }),
  remove: async (key: string) => void objects.delete(key),
} as unknown as SkillFiles;

// ---------- hub ----------

const hub = new Hub({
  store: new Store('c1', { mode: MODE, dataTtlDays: 21, eventDays: 90 }, db.asClient(), now),
  files,
  pepper: async () => 'local-pepper',
  runtime: async () => ({
    boardUrl: `${BASE}/`,
    apiUrl: `${BASE}${API_PREFIX}`,
    userPoolId: 'local',
    clientId: CLIENT_ID,
    region: 'local',
    events: { httpHost: `localhost:${PORT}`, realtimeUrl: `ws://localhost:${PORT}/event/realtime`, namespace: 'c1' },
  }),
  mode: MODE,
  eventEndsAt: MODE === 'event' ? Date.parse(process.env.EVENT_ENDS_AT ?? new Date(Date.now() + 3 * 86_400_000).toISOString()) : undefined,
  tokenTtlDays: Number(process.env.TOKEN_TTL_DAYS ?? '30'),
  now,
  toolRepoUrl: TOOL_REPO || undefined,
});

// ---------- Cognito stand-in ----------

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const signJwt = (claims: Record<string, unknown>): string => {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'local' }));
  const body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${b64u(createHmac('sha256', DEV_SECRET).update(`${head}.${body}`).digest())}`;
};
const verifyJwt = (t: string): { sub: string; email?: string } | undefined => {
  const [head, body, sig] = t.split('.');
  if (!head || !body || !sig || b64u(createHmac('sha256', DEV_SECRET).update(`${head}.${body}`).digest()) !== sig) return undefined;
  const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sub: string; email?: string; exp: number; aud: string; token_use: string };
  if (c.exp * 1000 < Date.now() || c.aud !== CLIENT_ID || c.token_use !== 'id') return undefined;
  return { sub: c.sub, email: c.email };
};
const codes = new Map<string, { sub: string; email: string; challenge: string; redirectUri: string }>();
const refresh = new Map<string, { sub: string; email: string }>();
const idTokenFor = (sub: string, email: string): string => {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ sub, email, aud: CLIENT_ID, token_use: 'id', iss: `${BASE}/_cognito`, iat, exp: iat + 3600 });
};
const subFor = (email: string): string => `local-${createHmac('sha256', 'sub').update(email.toLowerCase()).digest('hex').slice(0, 12)}`;

const deps = {
  agent: (t: string) => hub.authenticateAgentToken(t),
  human: async (t: string) => verifyJwt(t),
  seatForSub: (sub: string) => hub.seatForSub(sub),
};

// ---------- HTTP ----------

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const readBody = (req: http.IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const send = (res: http.ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
};

const loginPage = (q: URLSearchParams): string => `<!doctype html><meta charset="utf-8"><title>CollabOne local sign-in</title>
<style>body{font:15px system-ui;max-width:420px;margin:12vh auto;padding:0 16px}input,button{font:inherit;padding:8px;width:100%;box-sizing:border-box;margin:6px 0}</style>
<c1>Local sign-in</c1><p>This is the local test hub. Any email signs in; there is no password.</p>
<form method="post" action="/_cognito/login">
${[...q.entries()].map(([k, v]) => `<input type="hidden" name="${k.replace(/"/g, '')}" value="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`).join('')}
<label>Email <input name="email" type="email" required autofocus value="${(q.get('login_hint') ?? '').replace(/"/g, '')}"></label>
<button type="submit">Sign in</button></form>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', BASE);
    const p = url.pathname;

    if (p.startsWith(API_PREFIX)) {
      const method = req.method ?? 'GET';
      const raw = method === 'GET' || method === 'DELETE' ? '' : (await readBody(req, 300 * 1024)).toString('utf8');
      let body: unknown = {};
      try {
        body = raw ? parseBody({ body: raw, isBase64Encoded: false }) : {};
      } catch (e) {
        return send(res, 400, JSON.stringify({ error: { code: 'invalid', message: e instanceof Error ? e.message : 'bad body' } }));
      }
      const id = await resolveIdentity(req.headers.authorization, deps);
      const rel = p.slice(API_PREFIX.length) || '/';
      const isPublic = (method === 'GET' && rel === '/health') || (method === 'POST' && rel === '/join');
      if (!id && !isPublic) return send(res, 401, JSON.stringify({ message: 'Unauthorized' }));
      const auth: AuthContext = id ? { seatId: id.seatId || undefined, kind: id.kind, workerId: id.workerId, sub: id.sub, email: id.email } : {};
      const clientVersion = String(req.headers[CLIENT_VERSION_HEADER] ?? '').slice(0, 20) || undefined;
      const r = await dispatch(hub, { method, path: rel, params: {}, query: Object.fromEntries(url.searchParams), body, auth, clientVersion });
      console.log(`${method} ${rel} -> ${r.statusCode}${id ? ` (${id.kind} ${id.seatId || id.sub})` : ''}`);
      return send(res, r.statusCode ?? 200, String(r.body ?? ''));
    }

    if (p.startsWith('/_files/')) {
      const key = decodeURIComponent(p.slice('/_files/'.length));
      const op = url.searchParams.get('op') ?? '';
      const exp = Number(url.searchParams.get('exp'));
      const bytes = url.searchParams.get('bytes') ?? '';
      if (url.searchParams.get('sig') !== fileSig(key, op, exp, bytes) || exp < now()) return send(res, 403, 'SignatureDoesNotMatch', 'text/plain');
      if (op === 'put' && req.method === 'PUT') {
        const body = await readBody(req, MAX_SKILL_BYTES + 1);
        if (body.length !== Number(bytes)) return send(res, 403, 'SignatureDoesNotMatch', 'text/plain');
        objects.set(key, body);
        return send(res, 200, '', 'text/plain');
      }
      if (op === 'get' && req.method === 'GET') return objects.has(key) ? send(res, 200, objects.get(key) as Buffer, 'application/gzip') : send(res, 404, 'NoSuchKey', 'text/plain');
      return send(res, 405, 'MethodNotAllowed', 'text/plain');
    }

    if (p === '/_cognito/oauth2/authorize') return send(res, 200, loginPage(url.searchParams), 'text/html; charset=utf-8');
    if (p === '/_cognito/login' && req.method === 'POST') {
      const f = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'));
      const email = (f.get('email') ?? '').trim().toLowerCase();
      const redirectUri = f.get('redirect_uri') ?? '';
      if (!email || f.get('client_id') !== CLIENT_ID || !redirectUri.startsWith(BASE)) return send(res, 400, 'bad login request', 'text/plain');
      const code = randomUUID();
      codes.set(code, { sub: subFor(email), email, challenge: f.get('code_challenge') ?? '', redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      if (f.get('state')) back.searchParams.set('state', f.get('state') as string);
      return send(res, 302, '', 'text/plain', { location: back.toString() });
    }
    if (p === '/_cognito/oauth2/token' && req.method === 'POST') {
      const f = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'));
      const cors = { 'access-control-allow-origin': BASE };
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const verifier = f.get('code_verifier') ?? '';
        const challenge = b64u(createHash('sha256').update(verifier).digest());
        if (!c || c.challenge !== challenge || c.redirectUri !== f.get('redirect_uri')) return send(res, 400, JSON.stringify({ error: 'invalid_grant' }), undefined, cors);
        const rt = randomUUID();
        refresh.set(rt, { sub: c.sub, email: c.email });
        return send(res, 200, JSON.stringify({ id_token: idTokenFor(c.sub, c.email), refresh_token: rt, token_type: 'Bearer', expires_in: 3600 }), undefined, cors);
      }
      if (f.get('grant_type') === 'refresh_token') {
        const r = refresh.get(f.get('refresh_token') ?? '');
        if (!r) return send(res, 400, JSON.stringify({ error: 'invalid_grant' }), undefined, cors);
        return send(res, 200, JSON.stringify({ id_token: idTokenFor(r.sub, r.email), token_type: 'Bearer', expires_in: 3600 }), undefined, cors);
      }
      return send(res, 400, JSON.stringify({ error: 'unsupported_grant_type' }), undefined, cors);
    }
    if (p === '/_cognito/logout') return send(res, 302, '', 'text/plain', { location: url.searchParams.get('logout_uri') ?? `${BASE}/` });

    if (p === '/_dev/sweep' && req.method === 'POST') return send(res, 200, JSON.stringify(await hub.sweep()));
    if (p === '/_dev/advance' && req.method === 'POST') {
      clockOffset += Number(url.searchParams.get('ms') ?? '0');
      return send(res, 200, JSON.stringify({ offsetMs: clockOffset, now: new Date(now()).toISOString(), sweep: await hub.sweep() }));
    }
    if (p === '/_dev/token' && req.method === 'POST') {
      const email = (url.searchParams.get('email') ?? '').toLowerCase();
      if (!email) return send(res, 400, JSON.stringify({ error: 'email required' }));
      return send(res, 200, JSON.stringify({ idToken: idTokenFor(subFor(email), email), sub: subFor(email) }));
    }

    if (p === '/config.json')
      return send(res, 200, JSON.stringify({
        apiBase: `${BASE}${API_PREFIX}`,
        cognito: { domain: `${BASE}/_cognito`, clientId: CLIENT_ID, redirectUri: `${BASE}/`, logoutUri: `${BASE}/` },
        events: { httpHost: `localhost:${PORT}`, realtimeUrl: `ws://localhost:${PORT}/event/realtime`, namespace: 'c1' },
      }));

    const file = path.join(BOARD_DIR, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(BOARD_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream');
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    console.error('local-hub error', e);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: { code: 'internal', message: 'local hub error' } }));
  }
});

// ---------- WebSocket (AppSync Events protocol) ----------

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => (protocols.has('aws-appsync-event-ws') ? 'aws-appsync-event-ws' : false),
});

const headerFromProtocols = (protocols: string[]): Record<string, string> => {
  const h = protocols.find((x) => x.startsWith('header-'));
  if (!h) return {};
  try {
    return JSON.parse(Buffer.from(h.slice('header-'.length), 'base64url').toString('utf8')) as Record<string, string>;
  } catch {
    return {};
  }
};

const authorizeWs = async (token: string | undefined, operation: EventsAuthorizerEvent['requestContext']['operation'], channel?: string): Promise<Identity | undefined> => {
  const identity = await resolveIdentity(token, deps);
  const ev: EventsAuthorizerEvent = { authorizationToken: token ?? '', requestContext: { apiId: 'local', accountId: '0', requestId: randomUUID(), operation, channel: channel ?? null, channelNamespaceName: 'c1' } };
  return eventsDecision(ev, identity).isAuthorized ? identity : undefined;
};

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', BASE).pathname !== '/event/realtime') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
  const header = headerFromProtocols(protocols);
  const connected = authorizeWs(header.Authorization ?? header.authorization, 'EVENT_CONNECT');
  let ka: NodeJS.Timeout | undefined;
  ws.on('message', async (raw) => {
    let m: { type?: string; id?: string; channel?: string; authorization?: Record<string, string> };
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === 'connection_init') {
      const identity = await connected;
      if (!identity) {
        ws.send(JSON.stringify({ type: 'connection_error', errors: [{ errorType: 'UnauthorizedException', message: 'You are not authorized to make this call.' }] }));
        return ws.close(4001);
      }
      sockets.set(ws, { identity, subs: [] });
      ws.send(JSON.stringify({ type: 'connection_ack', connectionTimeoutMs: 300000 }));
      ka = setInterval(() => ws.send(JSON.stringify({ type: 'ka' })), 60_000);
      return;
    }
    const st = sockets.get(ws);
    if (!st) return;
    if (m.type === 'subscribe' && m.id && m.channel) {
      const ok = await authorizeWs(m.authorization?.Authorization ?? m.authorization?.authorization, 'EVENT_SUBSCRIBE', m.channel);
      if (!ok) return ws.send(JSON.stringify({ type: 'subscribe_error', id: m.id, errors: [{ errorType: 'UnauthorizedException', message: 'You are not authorized to make this call.' }] }));
      st.subs.push({ id: m.id, channel: m.channel });
      return ws.send(JSON.stringify({ type: 'subscribe_success', id: m.id }));
    }
    if (m.type === 'unsubscribe' && m.id) {
      st.subs = st.subs.filter((s) => s.id !== m.id);
      return ws.send(JSON.stringify({ type: 'unsubscribe_success', id: m.id }));
    }
    if (m.type === 'publish') return ws.send(JSON.stringify({ type: 'publish_error', id: m.id, errors: [{ errorType: 'UnauthorizedException', message: 'clients cannot publish' }] }));
    return undefined;
  });
  ws.on('close', () => {
    clearInterval(ka);
    sockets.delete(ws);
  });
});

setInterval(() => void hub.sweep().catch((e) => console.error('sweep failed', e)), SWEEP_MS).unref();

server.listen(PORT, HOST, () => {
  console.log(`CollabOne local hub (${MODE} mode) on ${BASE}`);
  console.log(`  board:    ${BASE}/            (local sign-in: any email)`);
  console.log(`  api:      ${BASE}${API_PREFIX}`);
  console.log(`  realtime: ws://localhost:${PORT}/event/realtime`);
  console.log(`  sweep every ${SWEEP_MS / 1000}s${STATE ? `, state in ${STATE}` : ', state in memory only'}`);
});
