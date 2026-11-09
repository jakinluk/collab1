import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Actor } from '../shared/types';
import { DomainError, fail, httpStatusFor } from '../core/errors';
import type { Hub } from '../app/hub';
import { getHub, originSecret, safeEqual } from './context';

export const API_PREFIX = '/api/v1';
const MAX_BODY = 256 * 1024;

export interface AuthContext {
  seatId?: string;
  kind?: 'agent' | 'human';
  workerId?: string;
  sub?: string;
  email?: string;
}

export interface Request {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  auth: AuthContext;
  /** Plugin version the caller runs, from the x-c1-client-version header. */
  clientVersion?: string;
}

export const CLIENT_VERSION_HEADER = 'x-c1-client-version';

type Handler = (hub: Hub, req: Request, actor: () => Actor) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  public?: boolean;
  status?: number;
  handler: Handler;
}

const routes: Route[] = [];
const route = (method: string, path: string, handler: Handler, opts: { public?: boolean; status?: number } = {}): void => {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/\{(\w+)\}/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
  routes.push({ method, pattern, keys, handler, ...opts });
};

const num = (v: string | undefined, d: number): number => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d);

route('GET', '/health', async () => ({ ok: true, version: process.env.C1_VERSION ?? 'dev' }), { public: true });
route('POST', '/join', (hub, r) => hub.join(r.body), { public: true, status: 201 });

route('GET', '/me', (hub, _r, a) => hub.me(a()));
route('PATCH', '/me', (hub, r, a) => hub.patchMe(a(), r.body));
route('POST', '/me/sessions', async (hub, r, a) => (await hub.session(a(), r.body), { ok: true }));
route('GET', '/board', (hub, r, a) => (a(), hub.board(r.query.projectId)));

route('GET', '/projects', async (hub, _r, a) => (a(), { projects: await hub.projects() }));
route('GET', '/projects/{pid}', async (hub, r, a) => (a(), (await hub.requireProject(r.params.pid)).value));
route('GET', '/projects/{pid}/goal', async (hub, r, a) => (a(), { goal: (await hub.goal(r.params.pid)) ?? null }));
route('GET', '/projects/{pid}/tickets', async (hub, r, a) => (a(), { tickets: await hub.listTickets(r.params.pid, r.query.status, r.query.ready === 'true') }));
route('POST', '/projects/{pid}/tickets', (hub, r, a) => hub.createTicket(a(), r.params.pid, r.body), { status: 201 });

route('POST', '/tickets/next', (hub, r, a) => hub.next(a(), r.body));
route('GET', '/tickets/{tid}', (hub, r, a) => (a(), hub.ticketView(r.params.tid)));
route('POST', '/tickets/{tid}/book', (hub, r, a) => hub.book(a(), r.params.tid, r.body));
route('POST', '/tickets/{tid}/heartbeat', (hub, r, a) => hub.heartbeat(a(), r.params.tid, r.body));
route('POST', '/tickets/{tid}/status', (hub, r, a) => hub.setStatus(a(), r.params.tid, r.body));
route('POST', '/tickets/{tid}/release', (hub, r, a) => hub.release(a(), r.params.tid, r.body));
route('POST', '/tickets/{tid}/review/book', (hub, r, a) => hub.reviewBook(a(), r.params.tid, r.body));
route('POST', '/tickets/{tid}/review/done', (hub, r, a) => hub.reviewDone(a(), r.params.tid, r.body));

route('POST', '/escalations', (hub, r, a) => hub.raise(a(), r.body), { status: 201 });
route('GET', '/escalations', async (hub, r, a) => (a(), { escalations: await hub.escalations(r.query.status) }));
route('GET', '/escalations/{eid}', async (hub, r, a) => (a(), (await hub.requireEscalation(r.params.eid)).value));
route('POST', '/escalations/{eid}/answer', (hub, r, a) => hub.answer(a(), r.params.eid, r.body));
route('POST', '/escalations/{eid}/resolve', (hub, r, a) => hub.resolve(a(), r.params.eid, r.body));
route('POST', '/escalations/{eid}/contest', (hub, r, a) => hub.contest(a(), r.params.eid, r.body));

route('GET', '/decisions', async (hub, r, a) => (a(), { decisions: await hub.decisions(r.query.status ?? 'open') }));
route('GET', '/decisions/{did}', async (hub, r, a) => (a(), (await hub.requireDecision(r.params.did)).value));
route('POST', '/decisions/{did}/vote', (hub, r, a) => hub.vote(a(), r.params.did, r.body));

route('POST', '/knowledge', (hub, r, a) => hub.share(a(), r.body), { status: 201 });
route('POST', '/knowledge/skills/upload-url', (hub, r, a) => hub.skillUploadUrl(a(), r.body));
route('GET', '/knowledge', async (hub, r, a) => (a(), { items: await hub.knowledge(r.query.status ?? 'active', num(r.query.since, 0)) }));
route('GET', '/knowledge/{kid}/download-url', (hub, r, a) => (a(), hub.skillDownloadUrl(r.params.kid)));
route('POST', '/knowledge/{kid}/retire', (hub, r, a) => hub.retire(a(), r.params.kid));

route('POST', '/messages', async (hub, r, a) => (await hub.message(a(), r.body), { ok: true }), { status: 201 });
route('GET', '/events', (hub, r, a) => hub.events(a(), num(r.query.since, 0), num(r.query.limit, 200)));
route('GET', '/rules', (hub, r, a) => (a(), hub.rules(r.query.projectId)));

route('POST', '/proposals', (hub, r, a) => hub.propose(a(), r.body), { status: 201 });
route('GET', '/proposals', async (hub, r, a) => (a(), { proposals: await hub.proposals(r.query.status ?? 'pending') }));
route('POST', '/proposals/{id}/approve', (hub, r, a) => hub.decideProposal(a(), r.params.id, true));
route('POST', '/proposals/{id}/reject', (hub, r, a) => hub.decideProposal(a(), r.params.id, false));

route('POST', '/seats/me', (hub, r) => {
  if (r.auth.kind !== 'human' || !r.auth.sub) fail('forbidden', 'sign in to the board to create your seat');
  return hub.createSeatForHuman(r.auth.sub as string, r.auth.email, r.body);
}, { status: 201 });
route('POST', '/join-codes', (hub, _r, a) => hub.createJoinCode(a()), { status: 201 });
route('GET', '/tokens', async (hub, _r, a) => ({ tokens: await hub.listTokens(a()) }));
route('DELETE', '/tokens/{tokenId}', async (hub, r, a) => (await hub.revokeToken(a(), r.params.tokenId), { ok: true }));
route('POST', '/actions', async (hub, r, a) => ({ result: await hub.directAction(a(), r.body) }));
route('GET', '/release', async (hub, _r, a) => (a(), { release: (await hub.currentRelease()) ?? null }));
route('POST', '/tool/bugs', (hub, r, a) => hub.fileToolBug(a(), r.body), { status: 201 });

export const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  body: JSON.stringify(body),
});

const error = (statusCode: number, code: string, message: string, details?: Record<string, unknown>): APIGatewayProxyStructuredResultV2 =>
  json(statusCode, { error: { code, message, ...(details ? { details } : {}) } });

export const parseBody = (event: Pick<APIGatewayProxyEventV2, 'body' | 'isBase64Encoded'>): unknown => {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) throw new DomainError('invalid', 'request body is larger than 256 KB');
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError('invalid', 'request body is not valid JSON');
  }
};

export const match = (method: string, path: string): { route: Route; params: Record<string, string> } | undefined => {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(path);
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return undefined;
};

export const actorFrom = (auth: AuthContext): Actor => {
  if (!auth.kind) throw new DomainError('unauthorized', 'missing credentials');
  if (!auth.seatId) throw new DomainError('forbidden', 'you have no seat yet: open the board and create one (POST /seats/me)');
  return { seatId: auth.seatId, kind: auth.kind, workerId: auth.workerId || undefined };
};

export const dispatch = async (hub: Hub, req: Request): Promise<APIGatewayProxyStructuredResultV2> => {
  const found = match(req.method, req.path);
  if (!found) return error(404, 'not_found', `no route ${req.method} ${req.path}`);
  try {
    if (req.method !== 'GET' && !found.route.public && req.auth.kind === 'agent') await hub.requireClientVersion(actorFrom(req.auth), req.clientVersion);
    const result = await found.route.handler(hub, { ...req, params: found.params }, () => actorFrom(req.auth));
    return json(found.route.status ?? 200, result ?? { ok: true });
  } catch (e) {
    if (e instanceof DomainError) return error(httpStatusFor(e.code), e.code, e.message, e.details);
    console.error(JSON.stringify({ level: 'error', route: `${req.method} ${found.route.pattern.source}`, message: e instanceof Error ? e.message : String(e) }));
    return error(500, 'internal', 'internal error');
  }
};

interface AuthorizerShape {
  lambda?: Record<string, string | undefined>;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const rawPath = event.rawPath.startsWith(API_PREFIX) ? event.rawPath.slice(API_PREFIX.length) || '/' : event.rawPath;
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (!safeEqual(headers['x-c1-origin-verify'], await originSecret())) return error(403, 'forbidden', 'use the CollabOne URL, not the API Gateway endpoint');
  let body: unknown;
  try {
    body = method === 'GET' || method === 'DELETE' ? {} : parseBody(event);
  } catch (e) {
    return error(400, 'invalid', e instanceof Error ? e.message : 'bad body');
  }
  const lambdaCtx = ((event.requestContext as unknown as { authorizer?: AuthorizerShape }).authorizer?.lambda ?? {}) as Record<string, string | undefined>;
  const auth: AuthContext = {
    seatId: lambdaCtx.seatId || undefined,
    kind: lambdaCtx.kind === 'agent' || lambdaCtx.kind === 'human' ? lambdaCtx.kind : undefined,
    workerId: lambdaCtx.workerId || undefined,
    sub: lambdaCtx.sub || undefined,
    email: lambdaCtx.email || undefined,
  };
  const clientVersion = headers[CLIENT_VERSION_HEADER]?.slice(0, 20) || undefined;
  return dispatch(getHub(), { method, path: rawPath, params: {}, query: event.queryStringParameters ?? {}, body, auth, clientVersion });
};
