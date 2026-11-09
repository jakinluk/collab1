import { loadConfig, readToken } from './config.mjs';
import { clientVersion } from './version.mjs';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const CONFLICT_CODES = new Set(['conflict', 'not_ready', 'path_conflict']);
export const UPDATE_EXIT = 3;

export const normalizeApiUrl = (url) => {
  let u = String(url).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  if (!/\/api\/v1$/.test(u)) u = `${u}/api/v1`;
  return u;
};

export function createClient({ apiUrl, token, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  async function request(method, path, body, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? timeoutMs);
    let res;
    try {
      res = await fetchImpl(apiUrl + path, {
        method,
        headers: {
          accept: 'application/json',
          'x-c1-client-version': clientVersion(),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token && !opts.noAuth ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError(0, 'unreachable', e?.name === 'AbortError' ? `hub did not answer within ${Math.round((opts.timeoutMs ?? timeoutMs) / 1000)}s` : `cannot reach hub: ${e?.cause?.code || e?.message || e}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new ApiError(res.status, err.code || (res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : 'error'), err.message || `HTTP ${res.status}`, err.details);
    }
    return data;
  }
  return {
    apiUrl,
    request,
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b = {}, o) => request('POST', p, b, o),
    patch: (p, b = {}, o) => request('PATCH', p, b, o),
    del: (p, o) => request('DELETE', p, undefined, o),
  };
}

export function clientFromConfig(opts = {}) {
  const cfg = loadConfig();
  if (!cfg?.apiUrl) throw new ApiError(0, 'not_joined', 'this Mac is not joined yet: run /c1:join (c1 join --code XXXX-XXXX --api <board URL>)');
  const token = readToken(cfg.seatId);
  if (!token) throw new ApiError(0, 'not_joined', 'no agent token found: run c1 join again with a fresh join code from the board');
  return { cfg, token, api: createClient({ apiUrl: cfg.apiUrl, token, ...opts }) };
}

export const enc = encodeURIComponent;
