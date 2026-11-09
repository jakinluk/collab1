import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { isAgentToken, stripBearer } from '../core/tokens';
import { runtimeConfig, requireEnv } from '../adapters/config';
import { getHub, originSecret, safeEqual } from './context';

export interface Identity {
  seatId: string;
  kind: 'agent' | 'human';
  workerId?: string;
  sub?: string;
  email?: string;
}

export interface HttpAuthorizerEvent {
  type?: string;
  routeKey?: string;
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  identitySource?: string[];
}

export interface EventsAuthorizerEvent {
  authorizationToken: string;
  requestContext: { apiId: string; accountId: string; requestId: string; operation: 'EVENT_CONNECT' | 'EVENT_SUBSCRIBE' | 'EVENT_PUBLISH'; channelNamespaceName?: string | null; channel?: string | null };
  requestHeaders?: Record<string, string>;
}

type Verifier = { verify: (token: string) => Promise<Record<string, unknown>> };
let verifier: Verifier | undefined;

const cognitoVerifier = async (): Promise<Verifier> => {
  if (verifier) return verifier;
  const rt = await runtimeConfig(requireEnv('RUNTIME_PARAM'));
  verifier = CognitoJwtVerifier.create({ userPoolId: rt.userPoolId, tokenUse: 'id', clientId: rt.clientId }) as unknown as Verifier;
  return verifier;
};

export const resolveIdentity = async (rawToken: string | undefined, deps: { agent: (t: string) => Promise<{ seatId: string; workerId?: string } | undefined>; human: (t: string) => Promise<{ sub: string; email?: string } | undefined>; seatForSub: (sub: string) => Promise<string | undefined> }): Promise<Identity | undefined> => {
  const token = stripBearer(rawToken);
  if (!token) return undefined;
  if (isAgentToken(token)) {
    const a = await deps.agent(token);
    return a ? { seatId: a.seatId, kind: 'agent', workerId: a.workerId } : undefined;
  }
  if (token.startsWith('c1a_')) return undefined;
  const h = await deps.human(token);
  if (!h) return undefined;
  return { seatId: (await deps.seatForSub(h.sub)) ?? '', kind: 'human', sub: h.sub, email: h.email };
};

export const channelAllowed = (channel: string | null | undefined, identity: Identity): boolean => {
  if (!channel || !identity.seatId) return false;
  if (channel === '/c1/all' || channel === '/c1/p/*') return true;
  const p = /^\/c1\/p\/([a-z0-9-]{2,40})$/.exec(channel);
  if (p) return true;
  const s = /^\/c1\/s\/([a-z0-9-]{2,40})$/.exec(channel);
  return Boolean(s && s[1] === identity.seatId);
};

const defaultDeps = () => ({
  agent: (t: string) => getHub().authenticateAgentToken(t),
  human: async (t: string) => {
    try {
      const claims = await (await cognitoVerifier()).verify(t);
      return { sub: String(claims.sub), email: typeof claims.email === 'string' ? claims.email : undefined };
    } catch {
      return undefined;
    }
  },
  seatForSub: (sub: string) => getHub().seatForSub(sub),
});

const isEventsEvent = (e: unknown): e is EventsAuthorizerEvent =>
  typeof e === 'object' && e !== null && 'authorizationToken' in e && typeof (e as EventsAuthorizerEvent).requestContext?.operation === 'string';

export const eventsDecision = (event: EventsAuthorizerEvent, identity: Identity | undefined): { isAuthorized: boolean; ttlOverride: number; handlerContext?: Record<string, string> } => {
  const deny = { isAuthorized: false, ttlOverride: 0 };
  if (!identity) return deny;
  const op = event.requestContext.operation;
  if (op === 'EVENT_PUBLISH') return deny;
  if (op === 'EVENT_SUBSCRIBE' && !channelAllowed(event.requestContext.channel, identity)) return deny;
  return { isAuthorized: true, ttlOverride: 0, handlerContext: { seatId: identity.seatId, kind: identity.kind } };
};

export const handler = async (event: HttpAuthorizerEvent | EventsAuthorizerEvent): Promise<unknown> => {
  const deps = defaultDeps();
  try {
    if (isEventsEvent(event)) return eventsDecision(event, await resolveIdentity(event.authorizationToken, deps));
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (!safeEqual(headers['x-c1-origin-verify'], await originSecret())) return { isAuthorized: false };
    const identity = await resolveIdentity(headers.authorization, deps);
    if (!identity) return { isAuthorized: false };
    return {
      isAuthorized: true,
      context: { seatId: identity.seatId, kind: identity.kind, workerId: identity.workerId ?? '', sub: identity.sub ?? '', email: identity.email ?? '' },
    };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', where: 'authorizer', message: e instanceof Error ? e.message : String(e) }));
    return isEventsEvent(event) ? { isAuthorized: false, ttlOverride: 0 } : { isAuthorized: false };
  }
};
