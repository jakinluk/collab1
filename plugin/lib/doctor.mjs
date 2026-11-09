import dns from 'node:dns/promises';
import { createClient, normalizeApiUrl } from './api.mjs';
import { loadConfig, readToken } from './config.mjs';
import { probeAck } from './realtime.mjs';
import { table } from './util.mjs';

async function reach(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e?.name === 'AbortError' ? 'timed out' : e?.cause?.code || e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

export async function doctor({ api: apiFlag } = {}) {
  const cfg = loadConfig();
  const apiUrl = apiFlag ? normalizeApiUrl(apiFlag) : cfg?.apiUrl;
  const checks = [];
  const add = (name, ok, detail, hint = '') => checks.push({ name, ok, detail, hint });

  if (apiUrl) {
    const host = new URL(apiUrl).hostname;
    try {
      const r = await dns.lookup(host);
      add('DNS for the hub', true, `${host} → ${r.address}`);
    } catch (e) {
      add('DNS for the hub', false, `${host}: ${e.code || e.message}`, 'Check the URL, or the network blocks DNS: try the iPhone hotspot.');
    }
    try {
      const h = await createClient({ apiUrl, timeoutMs: 6000 }).get('/health', { noAuth: true });
      add('HTTPS to the hub API', !!h.ok, `version ${h.version ?? '?'}`);
    } catch (e) {
      const portal = /<html/i.test(e.message) || e.status === 302;
      add('HTTPS to the hub API', false, e.message, portal ? 'Captive portal: log in to the Wi-Fi in a browser first.' : 'Check the board URL; if other sites work, try the iPhone hotspot.');
    }
  } else {
    add('Hub configuration', false, 'not joined yet', 'Run /c1:join (c1 join --code XXXX-XXXX --api <board URL>).');
  }

  const token = cfg?.seatId ? readToken(cfg.seatId) : null;
  if (cfg?.events?.realtimeUrl && token) {
    try {
      const ack = await probeAck({ httpHost: cfg.events.httpHost, realtimeUrl: cfg.events.realtimeUrl, token });
      add('WebSocket to AppSync Events', true, `acknowledged (timeout ${Math.round((ack.connectionTimeoutMs ?? 0) / 1000)}s)`);
    } catch (e) {
      add('WebSocket to AppSync Events', false, e.message, 'The network may block WebSockets or long connections: switch to an iPhone Personal Hotspot.');
    }
  } else if (cfg) {
    add('WebSocket to AppSync Events', false, 'no agent token', 'Run c1 join again with a fresh code from the board.');
  }

  const gh = await reach('https://github.com');
  add('GitHub', gh.ok, gh.detail, gh.ok ? '' : 'Git pushes and PRs will fail: check the network or use the hotspot.');
  const an = await reach('https://api.anthropic.com');
  add('Anthropic API', an.ok, an.detail, an.ok ? '' : 'Claude Code cannot work on this network: use the hotspot.');

  return { ok: checks.every((c) => c.ok), checks };
}

export function formatDoctor(r) {
  const rows = r.checks.map((c) => [c.ok ? 'PASS' : 'FAIL', c.name, c.detail, c.hint]);
  return `${table(rows, ['', 'Check', 'Result', 'What to do'])}\n\n${r.ok ? 'All checks passed.' : 'Some checks failed: fix them before starting autopilot.'}`;
}
