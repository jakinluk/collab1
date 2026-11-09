import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

function tarOf(files) {
  const blocks = [];
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'h1');
const TOKEN = 'h1a_' + 'A'.repeat(43);

function mockHub() {
  const calls = [];
  const tickets = {
    T1: { id: 'T1', projectId: 'p1', repo: 'mono', title: 'Offline queue', status: 'ready', lanes: ['mobile'], priority: 10, pathsOwned: ['apps/mobile/src/queue/**'], acceptance: [{ criterion: 'works' }], attempts: 0 },
  };
  const events = [{ seq: 1, ts: Date.now(), stream: 'tasks', type: 'ticket.ready', projectId: 'p1', from: 'system', fromKind: 'system', summary: 'T1 ready (mobile): Offline queue', data: { lanes: ['mobile'] } }];
  let seat = { id: 'lukasz', name: 'Łukasz', lanes: ['mobile'], projects: ['p1'], pinned: true, plan: 'ultra', workMode: 'solo', autopilot: true };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/^\/api\/v1/, '');
      const json = body ? JSON.parse(body) : undefined;
      calls.push({ method: req.method, path: p, query: url.search, body: json, auth: req.headers.authorization });
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const authed = req.headers.authorization === `Bearer ${TOKEN}`;
      if (p === '/health') return send(200, { ok: true, version: 'test' });
      if (p === '/join' && req.method === 'POST') {
        if (json.code !== 'ABCD-EFGH') return send(401, { error: { code: 'unauthorized', message: 'join code is invalid' } });
        const base = `http://127.0.0.1:${server.address().port}`;
        return send(201, { token: TOKEN, tokenId: 'tk1', seatId: 'lukasz', projectId: 'p1', apiUrl: `${base}/api/v1`, boardUrl: base, events: { httpHost: 'h.example', realtimeUrl: 'wss://r.example/event/realtime', namespace: 'h1' }, expiresAt: Date.now() + 864e5 });
      }
      if (!authed) return send(401, { error: { code: 'unauthorized', message: 'missing credentials' } });
      if (p === '/me' && req.method === 'GET') return send(200, { seat, actor: { seatId: 'lukasz', kind: 'agent' }, projectId: seat.projects[0], rules: { version: 4, digest: 'B1 contract change → agent quorum' } });
      if (p === '/me' && req.method === 'PATCH') {
        seat = { ...seat, ...json };
        return send(200, seat);
      }
      if (p === '/me/sessions') return send(200, { ok: true });
      if (p === '/tickets/next') {
        const t = Object.values(tickets).find((x) => x.status === 'ready');
        if (!t) return send(200, { booked: [] });
        Object.assign(t, { status: 'booked', branch: 'hack/p1/T1-offline-queue', booking: { seatId: 'lukasz', sessionId: json.sessionId, leaseExpiresAt: Date.now() + 9e5 } });
        return send(200, { booked: [t] });
      }
      let m;
      if ((m = /^\/tickets\/(T\d+)\/status$/.exec(p))) {
        Object.assign(tickets[m[1]], { status: json.status, prUrl: json.prUrl });
        return send(200, tickets[m[1]]);
      }
      if ((m = /^\/tickets\/(T\d+)\/release$/.exec(p))) {
        const t = tickets[m[1]];
        Object.assign(t, { status: 'ready', booking: undefined, attempts: t.attempts + (json.failed ? 1 : 0) });
        return send(200, t);
      }
      if ((m = /^\/tickets\/(T\d+)\/book$/.exec(p))) return send(409, { error: { code: 'path_conflict', message: 'paths overlap with T2' } });
      if ((m = /^\/projects\/(\w+)\/tickets$/.exec(p))) {
        let list = Object.values(tickets);
        if (url.searchParams.get('ready') === 'true') list = list.filter((t) => t.status === 'ready');
        return send(200, { tickets: list });
      }
      if (p === '/events') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const out = events.filter((e) => e.seq > since);
        return send(200, { events: out, lastSeq: out.length ? out[out.length - 1].seq : since });
      }
      if (p === '/proposals' && req.method === 'POST') {
        const base = `http://127.0.0.1:${server.address().port}`;
        return send(201, { executed: false, proposal: { id: 'P1', action: json.action, payload: json.payload, status: 'pending' }, approveUrl: `${base}/#/approve/P1` });
      }
      return send(404, { error: { code: 'not_found', message: `no route ${req.method} ${p}` } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, tickets })));
}

function run(args, env, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 20000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('CLI end to end against a mock hub', async (t) => {
  const { server, calls, tickets } = await mockHub();
  t.after(() => server.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-test-'));
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-skills-'));
  const env = { H1_HOME: home, H1_TOKEN_FILE: '1', H1_SKILLS_DIR: skills, H1_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  const base = `http://127.0.0.1:${server.address().port}`;

  const bad = await run(['join', '--code', 'ZZZZ-ZZZZ', '--api', base], env);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /join code is invalid/);

  const joined = await run(['join', '--code', 'abcd-efgh', '--api', base], env);
  assert.equal(joined.code, 0, joined.stderr);
  assert.match(joined.stdout, /Joined as lukasz/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(cfg.apiUrl, `${base}/api/v1`);
  assert.equal(cfg.projectId, 'p1');
  const tokenStat = fs.statSync(path.join(home, 'token'));
  assert.equal(tokenStat.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(home, 'token'), 'utf8').trim(), TOKEN);

  const me = await run(['me', '--json'], env);
  assert.equal(JSON.parse(me.stdout).seat.id, 'lukasz');

  const next = await run(['ticket', 'next', '--session', 'S1'], env);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /Booked T1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'S1.json'), 'utf8')).ticketIds, ['T1']);
  assert.equal(calls.find((c) => c.path === '/tickets/next').body.sessionId, 'S1');

  const none = await run(['ticket', 'next'], env);
  assert.equal(none.code, 2);

  const conflict = await run(['ticket', 'book', 'T1'], env);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /path_conflict/);

  const start = await run(['ticket', 'start', 'T1'], env);
  assert.equal(start.code, 0, start.stderr);
  assert.equal(tickets.T1.status, 'in_progress');

  const stop = await run(['hook', 'autopilot-stop'], env, JSON.stringify({ session_id: 'S1', hook_event_name: 'Stop' }));
  assert.equal(stop.code, 0);
  const decision = JSON.parse(stop.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /T1/);
  const again = await run(['hook', 'autopilot-stop'], env, JSON.stringify({ session_id: 'S1' }));
  assert.equal(again.stdout.trim(), '', 'never blocks twice for the same reason without progress');

  const rel = await run(['ticket', 'release', 'T1', '--reason', 'stuck on simulator', '--failed', '--session', 'S1'], env);
  assert.equal(rel.code, 0, rel.stderr);
  assert.equal(tickets.T1.attempts, 1);
  assert.deepEqual(calls.find((c) => /release$/.test(c.path)).body, { reason: 'stuck on simulator', failed: true });

  const ev = await run(['events', '--since', '0'], env);
  assert.match(ev.stdout, /ticket\.ready/);

  const goalFile = path.join(home, 'goal.json');
  fs.writeFileSync(goalFile, JSON.stringify({ statement: 'Capture offline', definitionOfDone: ['works offline'], demoScript: 'open app', nonGoals: [] }));
  const prop = await run(['goal', 'propose', '--file', goalFile], env);
  assert.equal(prop.code, 0, prop.stderr);
  assert.match(prop.stdout, /#\/approve\/P1/);
  const pc = calls.find((c) => c.path === '/proposals');
  assert.equal(pc.body.action, 'goal.set');
  assert.equal(pc.body.payload.projectId, 'p1');

  const guard = await run(['hook', 'guard'], env, JSON.stringify({ session_id: 'S9', cwd: home, tool_name: 'Write', tool_input: { file_path: path.join(home, 'x.txt') } }));
  assert.equal(guard.code, 0, 'no booking for this session: allowed');

  const booked = await run(['ticket', 'next', '--session', 'S2'], env);
  assert.equal(booked.code, 0, booked.stderr);
  const hookIn = (file) => JSON.stringify({ session_id: 'S2', cwd: home, tool_name: 'Edit', tool_input: { file_path: path.join(home, file) } });
  const own = await run(['hook', 'guard'], env, hookIn('apps/mobile/src/queue/store.ts'));
  assert.equal(own.code, 0, own.stderr);
  const unknownRepo = await run(['hook', 'guard'], env, hookIn('package.json'));
  assert.equal(unknownRepo.code, 0, 'repo not identified and no fallback: hot paths not enforced');
  const hot = await run(['hook', 'guard'], { ...env, H1_GUARD_FALLBACK: 'nx-monorepo' }, hookIn('package.json'));
  assert.equal(hot.code, 2);
  assert.match(hot.stderr, /protected shared path/);
  const warn = await run(['hook', 'guard'], env, hookIn('docs/notes.md'));
  assert.equal(warn.code, 0);
  const warnOut = JSON.parse(warn.stdout);
  assert.equal(warnOut.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(warnOut.hookSpecificOutput.additionalContext, /outside T1 pathsOwned/);

  const unreachable = await run(['hook', 'session-start'], { ...env, H1_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'h1-empty-')) }, '{}');
  assert.equal(unreachable.code, 0);
  assert.equal(unreachable.stdout.trim(), '');
});

test('skill archives with parent references are refused', async () => {
  const { extractSkill } = await import('../lib/skills.mjs');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-tar-'));
  process.env.H1_SKILLS_DIR = path.join(work, 'skills');
  fs.mkdirSync(path.join(work, 'good'));
  fs.writeFileSync(path.join(work, 'good', 'SKILL.md'), '---\nname: x\n---\nhello\n');
  const good = path.join(work, 'good.tgz');
  execFileSync('tar', ['-czf', good, '-C', path.join(work, 'good'), '.']);
  const target = extractSkill(good, 'run-ios-sim');
  assert.ok(fs.existsSync(path.join(target, 'SKILL.md')));
  assert.equal(path.basename(target), 'h1--run-ios-sim');

  const evil = path.join(work, 'evil.tgz');
  fs.writeFileSync(evil, gzipSync(tarOf([['./SKILL.md', 'ok'], ['../pwn.txt', 'x']])));
  assert.throws(() => extractSkill(evil, 'evil'), /parent directory reference/);
  const abs = path.join(work, 'abs.tgz');
  fs.writeFileSync(abs, gzipSync(tarOf([['/tmp/h1-pwn.txt', 'x']])));
  assert.throws(() => extractSkill(abs, 'abs'), /absolute path/);
  assert.ok(!fs.existsSync(path.join(work, 'pwn.txt')));
});
