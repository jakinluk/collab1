import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, list, truncate } from '../lib/util.mjs';
import { globToRegExp, guardDecision, matchesGlob, overlaps, relativeToRoot } from '../lib/paths.mjs';
import { classify, RateLimiter, SeqGate } from '../lib/monitor.mjs';
import { decideStop } from '../lib/hooks.mjs';
import { scanSecrets } from '../lib/secrets.mjs';
import { unsafeEntries, skillFolderName } from '../lib/skills.mjs';
import { b64url, channelsFor, subprotocols } from '../lib/realtime.mjs';

test('parseArgs handles positionals, flags, booleans, arrays and =', () => {
  const { positional, flags } = parseArgs(['ticket', 'next', '--n', '3', '--lanes=a,b', '--json', '--option', 'x', '--option', 'y', '--failed=false', 'T1']);
  assert.deepEqual(positional, ['ticket', 'next', 'T1']);
  assert.equal(flags.n, '3');
  assert.equal(flags.lanes, 'a,b');
  assert.equal(flags.json, true);
  assert.equal(flags.failed, false);
  assert.deepEqual(flags.option, ['x', 'y']);
  assert.deepEqual(list(flags.lanes), ['a', 'b']);
  assert.deepEqual(parseArgs(['-h']).flags, { help: true });
});

test('truncate keeps lines short', () => {
  assert.equal(truncate('a'.repeat(10), 5), 'aaaa…');
  assert.equal(truncate('  hi  there ', 50), 'hi there');
});

test('glob matching', () => {
  assert.ok(matchesGlob('services/note/src/a.ts', 'services/note/**'));
  assert.ok(matchesGlob('services/note', 'services/note/**'));
  assert.ok(!matchesGlob('services/notex/a.ts', 'services/note/**'));
  assert.ok(matchesGlob('apps/mobile/src/x.tsx', 'apps/mobile/src/*.tsx'));
  assert.ok(!matchesGlob('apps/mobile/src/a/x.tsx', 'apps/mobile/src/*.tsx'));
  assert.ok(matchesGlob('services/a/project.json', '**/project.json'));
  assert.ok(matchesGlob('project.json', '**/project.json'));
  assert.ok(matchesGlob('services/x/serverless.dev.yml', '**/serverless*.yml'));
  assert.ok(matchesGlob('libs/shared', 'libs/shared'));
  assert.ok(matchesGlob('libs/shared/api/x.ts', 'libs/shared'));
  assert.ok(!matchesGlob('services/a/package.json', 'package.json'));
  assert.equal(globToRegExp('a/**/b').test('a/b'), true);
  assert.equal(globToRegExp('a/**/b').test('a/x/y/b'), true);
});

test('overlap and relative paths', () => {
  assert.ok(overlaps('a/b/**', 'a/b/c.ts'));
  assert.ok(overlaps('a/b/**', 'a/**'));
  assert.ok(!overlaps('a/b/**', 'a/c/**'));
  assert.equal(relativeToRoot('/repo/services/a.ts', '/repo'), 'services/a.ts');
  assert.equal(relativeToRoot('/other/a.ts', '/repo'), null);
  assert.equal(relativeToRoot('services/a.ts', '/repo'), 'services/a.ts');
});

test('guard decisions', () => {
  const protect = { hotPaths: ['package.json', 'nx.json', '**/project.json'], contractPaths: ['libs/shared/**'] };
  const mine = [{ id: 'T1', type: 'slice', pathsOwned: ['services/note/**'] }];
  const others = [{ id: 'T2', pathsOwned: ['apps/mobile/**'], booking: { seatId: 'ania' } }];
  assert.equal(guardDecision('services/note/src/x.ts', mine, others, protect).action, 'allow');
  assert.equal(guardDecision('anything.ts', [], others, protect).action, 'allow');
  const hot = guardDecision('package.json', mine, others, protect);
  assert.equal(hot.action, 'block');
  assert.equal(hot.rule, 'B2');
  assert.match(hot.reason, /h1 raise blocker --rule B2/);
  const nested = guardDecision('apps/web/project.json', mine, others, protect);
  assert.equal(nested.action, 'block');
  const shared = guardDecision('libs/shared/api-interfaces/x.ts', mine, others, protect);
  assert.equal(shared.action, 'block');
  assert.equal(shared.rule, 'B1');
  const taken = guardDecision('apps/mobile/src/a.ts', mine, others, protect);
  assert.equal(taken.action, 'block');
  assert.match(taken.reason, /owned by T2 \(ania\)/);
  assert.equal(guardDecision('docs/readme.md', mine, others, protect).action, 'warn');
  assert.equal(guardDecision(null, mine, others, protect).action, 'allow');
  const contractTicket = [{ id: 'T0', type: 'contract', pathsOwned: ['libs/shared/api-interfaces/**'] }];
  assert.equal(guardDecision('libs/shared/api-interfaces/x.ts', contractTicket, others, protect).action, 'allow');
  assert.equal(guardDecision('libs/shared/event-interfaces/y.ts', contractTicket, others, protect).action, 'warn');
  const glue = [{ id: 'T3', type: 'glue', pathsOwned: ['services/x/**'] }];
  assert.equal(guardDecision('package.json', glue, others, protect).action, 'block');
  assert.equal(guardDecision('package.json', mine, others, {}).action, 'warn', 'no repo metadata: hot paths not enforced');
});

const ctx = { seatId: 'lukasz', projectId: 'p1', lanes: ['mobile'], myTickets: new Set(['T5']) };
const env = (o) => ({ seq: 1, ts: 0, stream: 'tasks', from: 'ania', fromKind: 'agent', summary: 'x', ...o });

test('monitor classify filters and formats', () => {
  assert.match(classify(env({ type: 'ticket.ready', projectId: 'p1', data: { lanes: ['mobile'] }, summary: 'T7 ready (mobile): Cache' }), ctx).line, /^\[h1\] T7 ready .* → \/h1:ticket next$/);
  assert.equal(classify(env({ type: 'ticket.ready', projectId: 'p1', data: { lanes: ['api'] } }), ctx), null);
  assert.equal(classify(env({ type: 'ticket.ready', projectId: 'p2', data: { lanes: ['mobile'] } }), ctx), null);
  assert.equal(classify(env({ type: 'ticket.booked', projectId: 'p1', ticketId: 'T9' }), ctx), null);
  assert.ok(classify(env({ type: 'ticket.changes_requested', projectId: 'p1', ticketId: 'T5' }), ctx));
  const vote = classify(env({ type: 'decision.opened', projectId: 'p1', data: { decisionId: 'D3', eligible: ['lukasz'] }, summary: 'VOTE D3 by 14:20Z: A or B?' }), ctx);
  assert.match(vote.line, /→ \/h1:decide D3$/);
  assert.equal(classify(env({ type: 'decision.opened', projectId: 'p1', data: { decisionId: 'D4', eligible: ['ania'] } }), ctx), null);
  const human = classify(env({ type: 'escalation.raised', projectId: 'p2', to: 'humans', summary: 'E4 B6 needs access' }), ctx);
  assert.equal(human.human, true);
  const skill = classify(env({ type: 'skill.published', stream: 'knowledge', summary: 'skill h1-run-ios-sim v2' }), ctx);
  assert.equal(skill.syncSkills, true);
  assert.match(skill.line, /^\[h1\] SKILL /);
  assert.equal(classify(env({ type: 'message', to: 'kasia' }), ctx), null);
  assert.match(classify(env({ type: 'message', to: 'lukasz', summary: 'ania → lukasz: hi' }), ctx).line, /^\[h1\] DM /);
  assert.equal(classify(env({ type: 'message', from: 'lukasz' }), ctx), null);
  assert.ok(classify(env({ type: 'proposal.approved', to: 'lukasz' }), ctx));
  assert.equal(classify(env({ type: 'seat.connected' }), ctx), null);
  assert.ok(classify(env({ type: 'rules.updated', summary: 'Rules v5' }), ctx));
  const long = classify(env({ type: 'goal.set', projectId: 'p1', summary: 'x'.repeat(500) }), ctx);
  assert.ok(long.line.length <= 200);
});

test('rate limiter caps lines and summarises', () => {
  let t = 0;
  const rl = new RateLimiter(3, 60000, () => t);
  const out = [];
  for (let i = 1; i <= 6; i++) out.push(...rl.push(`l${i}`, i));
  assert.deepEqual(out, ['l1', 'l2', 'l3']);
  t = 61000;
  const next = rl.push('l7', 7);
  assert.equal(next.length, 2);
  assert.match(next[0], /3 more events were hidden \(h1 events --since 3\)/);
  assert.equal(next[1], 'l7');
});

test('seq gate orders events', () => {
  const g = new SeqGate(5);
  assert.equal(g.check(5), 'dup');
  assert.equal(g.check(6), 'apply');
  assert.equal(g.check(8), 'gap');
  g.advance(8);
  assert.equal(g.check(7), 'dup');
});

test('autopilot stop decisions', () => {
  assert.equal(decideStop({ autopilot: false, myWorking: [{ id: 'T1', title: 'x', status: 'in_progress' }] }).block, false);
  const work = decideStop({ autopilot: true, myWorking: [{ id: 'T1', title: 'Queue', status: 'in_progress' }], seq: 10 });
  assert.equal(work.block, true);
  assert.match(work.reason, /T1/);
  assert.equal(decideStop({ autopilot: true, myWorking: [{ id: 'T1', title: 'Queue', status: 'in_progress' }], last: { reason: work.reason, seq: 10 }, seq: 10 }).block, false);
  assert.equal(decideStop({ autopilot: true, myWorking: [{ id: 'T1', title: 'Queue', status: 'in_progress' }], last: { reason: work.reason, seq: 10 }, seq: 12 }).block, true);
  const ready = decideStop({ autopilot: true, readyForMe: [{ id: 'T3', title: 'Next' }], activeCount: 0, seq: 1 });
  assert.equal(ready.block, true);
  assert.match(ready.reason, /h1 ticket next/);
  assert.equal(decideStop({ autopilot: true, readyForMe: [{ id: 'T3', title: 'Next' }], activeCount: 2, limit: 2 }).block, false);
  assert.equal(decideStop({ autopilot: true }).block, false);
});

test('secret scanner', () => {
  assert.ok(scanSecrets('key AKIAABCDEFGHIJKLMNOP here').some((f) => f.type === 'aws-access-key-id'));
  assert.ok(scanSecrets('ghp_' + 'a'.repeat(36)).some((f) => f.type === 'github-token'));
  assert.ok(scanSecrets('sk-ant-api03-' + 'x'.repeat(30)).some((f) => f.type === 'anthropic-api-key'));
  assert.ok(scanSecrets('-----BEGIN OPENSSH PRIVATE KEY-----').length);
  assert.ok(scanSecrets('password = "Zx9!kQ2#pL7$vR4w"').length);
  assert.equal(scanSecrets('password = ${DB_PASSWORD}').length, 0);
  assert.equal(scanSecrets('run npx nx run note:unit').length, 0);
});

test('tar entry sanitization and skill folder names', () => {
  assert.deepEqual(unsafeEntries(['./', './SKILL.md', 'scripts/run.sh']), []);
  assert.equal(unsafeEntries(['/etc/passwd']).length, 1);
  assert.equal(unsafeEntries(['../../.zshrc']).length, 1);
  assert.equal(unsafeEntries(['a/../../b']).length, 1);
  assert.equal(skillFolderName('H1 Run iOS sim!'), 'h1--h1-run-ios-sim');
});

test('appsync helpers', () => {
  assert.equal(b64url('{"a":"b?"}'), Buffer.from('{"a":"b?"}').toString('base64url'));
  const [p0, p1] = subprotocols('h.appsync-api.us-east-1.amazonaws.com', 'h1a_tok');
  assert.equal(p0, 'aws-appsync-event-ws');
  assert.deepEqual(JSON.parse(Buffer.from(p1.slice(7), 'base64url').toString()), { host: 'h.appsync-api.us-east-1.amazonaws.com', Authorization: 'h1a_tok' });
  assert.deepEqual(channelsFor({ seatId: 'lukasz' }), ['/h1/all', '/h1/p/*', '/h1/s/lukasz']);
});

test('version helpers compare releases and tell where the plugin loads from', async () => {
  const { compareVersions, updateState, installKind } = await import('../lib/version.mjs');
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2', '0.2.1'), -1);
  assert.equal(updateState('0.3.0', null), 'current');
  assert.equal(updateState('0.3.0', { latest: '0.3.0' }), 'current');
  assert.equal(updateState('0.3.0', { latest: '0.3.1' }), 'behind');
  assert.equal(updateState('0.3.0', { latest: '0.4.0', minimum: '0.4.0' }), 'blocked');
  assert.equal(installKind('/Users/a/.claude/plugins/cache/hackathonone/h1/0.3.0'), 'cache');
  assert.equal(installKind('/Users/a/workspace/hc/hakatonOne/plugin'), 'in_place');
});

test('monitor announces releases to humans and new ready tickets like ready ones', () => {
  const ctx = { seatId: 'lukasz', projectId: 'p1', lanes: ['mobile'], myTickets: new Set() };
  const env = (o) => ({ seq: 1, ts: 1, stream: 'broadcast', from: 'ania', fromKind: 'human', summary: 's', ...o });
  const rel = classify(env({ type: 'tool.released', summary: 'HackathonOne 0.3.1 released: fix' }), ctx);
  assert.equal(rel.human, true);
  assert.match(rel.line, /^\[h1\] UPDATE HackathonOne 0\.3\.1 .* → \/h1:update/);
  assert.match(classify(env({ type: 'ticket.added', projectId: 'p1', data: { status: 'ready', lanes: ['mobile'] }, summary: 'T9 added (ready): x' }), ctx).line, /T9 added .* → \/h1:ticket next/);
  assert.equal(classify(env({ type: 'ticket.added', projectId: 'p1', data: { status: 'planned', lanes: ['mobile'] } }), ctx), null);
});
