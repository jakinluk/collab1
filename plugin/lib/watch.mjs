import { execFile } from 'node:child_process';
import { clientFromConfig, enc } from './api.mjs';
import { loadConfig, loadState, readToken, saveState } from './config.mjs';
import { classify, RateLimiter, SeqGate } from './monitor.mjs';
import { AppSyncClient, channelsFor } from './realtime.mjs';
import { syncSkills } from './skills.mjs';

const WORKING = new Set(['booked', 'in_progress', 'review', 'blocked']);

export function notify(text) {
  if (process.platform !== 'darwin') return;
  const safe = String(text).replace(/["\\]/g, "'").slice(0, 180);
  execFile('osascript', ['-e', `display notification "${safe}" with title "CollabOne"`], { timeout: 5000 }, () => {});
}

const sleepForever = () => new Promise(() => setInterval(() => {}, 1 << 30));

export async function watch({ print = (l) => process.stdout.write(l + '\n'), WebSocketImpl } = {}) {
  let cfg = loadConfig();
  let token = cfg && readToken(cfg.seatId);
  if (!cfg?.events?.realtimeUrl || !token) {
    while (!cfg?.events?.realtimeUrl || !token) {
      await new Promise((r) => setTimeout(r, 60000));
      cfg = loadConfig();
      token = cfg && readToken(cfg.seatId);
    }
  }
  const { api } = clientFromConfig({ timeoutMs: 10000 });
  const state = loadState();
  const gate = new SeqGate(state.lastSeq ?? 0);
  const limiter = new RateLimiter(Number(process.env.C1_MONITOR_MAX_PER_MIN) || 20);
  const ctx = { seatId: cfg.seatId, projectId: cfg.projectId, lanes: cfg.lanes ?? [], myTickets: new Set() };

  const refreshMe = async () => {
    try {
      const me = await api.get('/me');
      ctx.projectId = me.projectId ?? ctx.projectId;
      ctx.projects = me.mode === 'ongoing' ? (me.projects ?? me.seat?.projects ?? []) : [];
      ctx.lanes = me.seat?.lanes ?? ctx.lanes;
      const pids = [...new Set([ctx.projectId, ...ctx.projects].filter(Boolean))];
      const lists = await Promise.all(pids.map((pid) => api.get(`/projects/${enc(pid)}/tickets`).then((r) => r.tickets ?? [])));
      ctx.myTickets = new Set(lists.flat().filter((t) => t.booking?.seatId === ctx.seatId && WORKING.has(t.status)).map((t) => t.id));
    } catch {
      /* keep the previous context */
    }
  };

  let syncing = false;
  const doSync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const r = await syncSkills(api, { ...cfg, projectId: ctx.projectId });
      for (const s of [...r.added, ...r.updated]) print(`[c1] skill ${s} synced to ~/.claude/skills`);
      for (const s of r.removed) print(`[c1] skill ${s} retired and removed`);
    } catch {
      /* next skill event retries */
    } finally {
      syncing = false;
    }
  };

  let persistTimer = null;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => saveState({ lastSeq: gate.lastSeq }), 1000);
  };

  const apply = (env) => {
    gate.advance(env.seq);
    persist();
    if (env.type === 'ticket.booked' && (env.from === ctx.seatId || String(env.from).startsWith(`${ctx.seatId}/`)) && env.ticketId) ctx.myTickets.add(env.ticketId);
    const c = classify(env, ctx);
    if (['ticket.done', 'ticket.released', 'ticket.blocked'].includes(env.type) && env.ticketId) ctx.myTickets.delete(env.ticketId);
    if (env.type === 'seat.pinned' && env.from === ctx.seatId) refreshMe();
    if (!c) return;
    for (const line of limiter.push(c.line, env.seq)) print(line);
    if (c.human) notify(env.summary);
    if (c.syncSkills) doSync();
  };

  let catching = null;
  const catchUp = async () => {
    if (catching) return catching;
    catching = (async () => {
      try {
        for (let guard = 0; guard < 50; guard++) {
          const { events, lastSeq } = await api.get(`/events?since=${gate.lastSeq}&limit=500`);
          for (const env of events ?? []) if (gate.check(env.seq) !== 'dup') apply(env);
          if ((events?.length ?? 0) < 500) {
            gate.advance(lastSeq ?? 0);
            persist();
            break;
          }
          if (lastSeq <= gate.lastSeq) break;
        }
      } catch {
        /* retried on the next gap or reconnect */
      } finally {
        catching = null;
      }
    })();
    return catching;
  };

  let gapTimer = null;
  const onEvent = (env) => {
    const s = gate.check(env.seq);
    if (s === 'dup') return;
    if (s === 'apply') return apply(env);
    clearTimeout(gapTimer);
    gapTimer = setTimeout(catchUp, 400);
  };

  await refreshMe();
  await doSync();
  const client = new AppSyncClient({
    httpHost: cfg.events.httpHost,
    realtimeUrl: cfg.events.realtimeUrl,
    token,
    channels: channelsFor({ seatId: cfg.seatId }),
    WebSocketImpl,
    onEvent,
    onReady: () => catchUp(),
    onStatus: (s) => {
      if (s === 'offline') print('[c1] hub connection lost; reconnecting');
    },
    log: (m) => process.stderr.write(`c1 watch: ${m}\n`),
  });
  client.start();
  const refresher = setInterval(refreshMe, 5 * 60000);
  refresher.unref?.();
  await sleepForever();
}
