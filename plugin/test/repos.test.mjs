import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-repos-'));
process.env.C1_HOME = home;

const repos = await import('../lib/repos.mjs');
const { buildProjectPayload, parseRepoSpec } = await import('../lib/commands.mjs');

test('remote URLs normalize across ssh, https, .git and case', () => {
  const forms = [
    'git@github.com:acme/platform.git',
    'https://github.com/acme/platform',
    'https://user@GitHub.com/acme/platform.git/',
    'ssh://git@github.com/acme/platform.git',
  ];
  const norm = forms.map((f) => repos.normalizeRemote(f));
  assert.equal(new Set(norm).size, 1, norm.join(' | '));
  assert.ok(repos.sameRemote(forms[0], forms[1]));
  assert.ok(!repos.sameRemote('git@github.com:acme/platform.git', 'git@github.com:acme/mobile.git'));
});

test('local links are stored per project and resolved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-checkout-'));
  repos.linkRepo('p1', 'platform', dir);
  assert.equal(repos.linkedPath('p1', 'platform'), path.resolve(dir));
  assert.equal(repos.linkedPath('p2', 'platform'), null);
  const r = repos.resolveRepoPath('p1', { name: 'platform', url: 'git@github.com:x/y.git' });
  assert.equal(r.via, 'link');
  assert.ok(repos.unlinkRepo('p1', 'platform'));
  assert.equal(repos.linkedPath('p1', 'platform'), null);
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'repos.json'), 'utf8'));
  assert.deepEqual(stored, {});
});

test('identifyRepo matches a checkout by its origin remote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-git-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/mobile.git']);
  fs.mkdirSync(path.join(dir, 'src'));
  const projectRepos = [
    { name: 'platform', url: 'https://github.com/acme/platform' },
    { name: 'mobile', url: 'https://github.com/acme/Mobile'.replace('acme/Mobile', 'acme/mobile') },
  ];
  const found = repos.identifyRepo(path.join(dir, 'src'), 'p1', projectRepos);
  assert.equal(found?.repo.name, 'mobile');
  assert.equal(found?.via, 'remote');
  assert.equal(fs.realpathSync(found.root), fs.realpathSync(dir));
  assert.equal(repos.identifyRepo(os.tmpdir(), 'p1', projectRepos), null);
});

test('presets fill only unset repo fields and defaults are applied', () => {
  const r = repos.completeRepo({ name: 'platform', url: 'git@github.com:x/platform.git', setup: ['pnpm i'] }, 'offline-capture', 'nx-monorepo');
  assert.equal(r.baseBranch, 'main');
  assert.equal(r.integrationBranch, 'hack/offline-capture');
  assert.deepEqual(r.setup, ['pnpm i'], 'explicit setup kept');
  assert.ok(r.hotPaths.includes('nx.json'));
  assert.deepEqual(r.contractPaths, ['libs/shared/**']);
  assert.ok(r.verify.some((v) => v.cmd === 'npm run type:check'));
  assert.match(r.notes, /Never run builds/);
  const plain = repos.withDefaults({ name: 'x', url: 'u' }, 'p');
  assert.deepEqual(plain.hotPaths, []);
  assert.throws(() => repos.preset('nope'), /unknown preset/);
});

test('project payloads from flags and files', () => {
  assert.deepEqual(parseRepoSpec('mobile=git@github.com:x/mobile.git@hack/custom'), { name: 'mobile', url: 'git@github.com:x/mobile.git', integrationBranch: 'hack/custom' });
  assert.deepEqual(parseRepoSpec('platform=git@github.com:x/platform.git'), { name: 'platform', url: 'git@github.com:x/platform.git' });
  const p = buildProjectPayload({
    name: 'Offline capture',
    repo: ['platform=git@github.com:x/platform.git'],
    preset: 'nx-monorepo',
    link: ['Slack=https://slack.com/app_redirect?channel=hack'],
    'demo-url': 'https://demo.example.com',
    stage: 'hack-int',
    tag: ['mobile'],
    description: 'Offline note capture',
  });
  assert.equal(p.id, 'offline-capture');
  assert.equal(p.repos[0].integrationBranch, 'hack/offline-capture');
  assert.ok(p.repos[0].hotPaths.length > 0);
  assert.deepEqual(p.links, [{ label: 'Slack', url: 'https://slack.com/app_redirect?channel=hack' }]);
  assert.deepEqual(p.demo, { url: 'https://demo.example.com', stage: 'hack-int' });
  assert.deepEqual(p.tags, ['mobile']);
  assert.throws(() => buildProjectPayload({ name: 'X', repo: ['a=u'], link: ['Bad=http://insecure'] }), /https/);
  assert.throws(() => buildProjectPayload({ name: 'X' }), /at least one repo/);
  const file = path.join(home, 'project.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'Repair cart', repos: [{ name: 'platform', url: 'u', preset: 'node-app' }] }));
  const fromFile = buildProjectPayload({ file });
  assert.equal(fromFile.id, 'repair-cart');
  assert.ok(fromFile.repos[0].verify.some((v) => v.cmd === 'npm test'));
  const upd = buildProjectPayload({ description: 'new text' }, { forUpdate: true, projectId: 'repair-cart' });
  assert.deepEqual(upd, { projectId: 'repair-cart', description: 'new text' });
});
