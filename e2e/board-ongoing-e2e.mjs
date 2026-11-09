#!/usr/bin/env node
// Board in ongoing mode: roadmap, change requests (approve and reject from the board), inputs, decision log, change log.
// Starts its own hub with --mode ongoing on PORT (default 8794) and drives a real browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8794);
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/v1`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-board-ongoing-'));
const SHOTS = path.join(WORK, 'screenshots');
fs.mkdirSync(SHOTS);
let pass = 0;
let fail = 0;

const hub = spawn('npx', ['tsx', 'scripts/local-hub.ts', '--port', String(PORT), '--mode', 'ongoing', '--sweep-ms', '600000'], { cwd: path.join(ROOT, 'backend'), stdio: ['ignore', fs.openSync(path.join(WORK, 'hub.log'), 'w'), 'inherit'] });
const stop = () => hub.kill();
process.on('exit', stop);
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${API}/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const call = async (token, method, p, body) => {
  const r = await fetch(API + p, { method, headers: { authorization: `Bearer ${token}`, 'x-c1-client-version': '1.0.0', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const step = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${String(e.message ?? e).split('\n')[0]}`);
    if (globalThis.debugPage) await globalThis.debugPage.screenshot({ path: path.join(SHOTS, `fail-${fail}.png`), fullPage: true }).catch(() => {});
  }
};

console.log(`== board in ongoing mode on ${BASE} (work dir ${WORK})`);
const human = (await (await fetch(`${BASE}/_dev/token?email=lukasz@example.com`, { method: 'POST' })).json()).idToken;
await call(human, 'POST', '/seats/me', { id: 'lukasz', name: 'Lukasz' });
const { code } = await call(human, 'POST', '/join-codes');
const { token: agent } = await (await fetch(`${API}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, machine: 'mbp' }) })).json();
const act = (action, payload) => call(human, 'POST', '/actions', { action, payload });
const today = new Date();
const day = (d) => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);

await act('repo.set', { name: 'app', url: 'git@github.com:acme/app.git' });
await act('project.create', { name: 'Customer notifications', repoRefs: ['app'], epic: { startDate: day(-20), targetDate: day(40) } });
await act('project.create', { name: 'Billing', repoRefs: ['app'], epic: { startDate: day(-5), targetDate: day(70), priority: 50 } });
await act('epic.update', { projectId: 'customer-notifications', milestones: [{ name: 'Status emails', targetDate: day(10) }, { name: 'SMS', targetDate: day(35) }] });
await call(agent, 'PATCH', '/me', { pinProject: 'customer-notifications', follow: ['billing'] });
const prd = '# Notifications\n\n## Status email {#status-email}\nEmail on every status change.\n\n## Templates\nBrand template.\n';
const { input } = await call(agent, 'POST', '/inputs', { kind: 'prd', title: 'Notifications PRD', body: prd, projectIds: ['customer-notifications'] });
const { result: ap } = await act('input.approve', { inputId: input.id });
const cr1 = ap.changes[0];
await call(agent, 'POST', `/changes/${cr1}/assessment`, {
  impact: [],
  newTickets: [
    { key: 'send', repo: 'app', title: 'Send status email', pathsOwned: ['services/notify/send/**'], acceptance: [{ criterion: 'sent' }], refs: ['input:I1#status-email'], milestone: 'm1' },
    { key: 'render', repo: 'app', title: 'Render brand template', pathsOwned: ['services/notify/render/**'], acceptance: [{ criterion: 'rendered' }], refs: ['input:I1#templates'], milestone: 'm1' },
  ],
  scope: { statement: 'Customers hear about their jobs', definitionOfDone: ['status emails go out', 'brand templates'] },
  summary: 'First plan from the PRD.',
});
await act('change.approve', { changeId: cr1 });
const { booked } = await call(agent, 'POST', '/tickets/next', { projectId: 'customer-notifications' });
await call(agent, 'POST', `/tickets/${booked[0].id}/status`, { status: 'review', prUrl: 'https://github.com/acme/app/pull/1' });
await call(human, 'POST', `/tickets/${booked[0].id}/review/done`, { outcome: 'merged', mergeSha: 'abc1234', files: ['services/notify/send/index.ts'] });
await call(agent, 'POST', `/inputs/${input.id}/versions`, { body: prd.replace('Email on every status change.', 'One daily digest.') });
const { result: ap2 } = await act('input.approve', { inputId: input.id });
const cr2 = ap2.changes[0];
await call(agent, 'POST', `/changes/${cr2}/assessment`, {
  impact: [{ ticketId: booked[0].id, verdict: 'rework', acceptance: [{ criterion: 'one digest per day' }] }],
  summary: 'Per-change emails become a daily digest; the merged sender is reworked.',
});
await act('decision.record', { projectId: 'customer-notifications', title: 'Opt-out', choice: 'Customers can opt out of email', reason: 'Support tickets', replan: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
globalThis.debugPage = page;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(8000);
await page.goto(`${BASE}/`);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.fill('input[name=email]', 'lukasz@example.com');
await page.click('button[type=submit]');
await page.waitForLoadState();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const tab = (name) => page.getByRole('tab', { name }).click();

await step('ongoing tabs appear and the top bar shows the epic state', async () => {
  await page.getByRole('tab', { name: 'Roadmap' }).waitFor();
  await page.getByText(/Epic: in progress/).waitFor();
});
await step('roadmap shows both epics with progress, milestones and a change marker', async () => {
  await tab('Roadmap');
  await page.getByText('1/2 done').waitFor();
  if ((await page.locator('.rm-row').count()) !== 2) throw new Error('expected two epic rows');
  if ((await page.locator('.rm-ms').count()) !== 2) throw new Error('expected two milestones');
  if ((await page.locator('.rm-cr').count()) < 1) throw new Error('expected a change-request marker');
  await shot('roadmap');
});
await step('epic editor saves a milestone change', async () => {
  await page.locator('.rm-row').first().getByRole('button', { name: 'Edit' }).click();
  const ta = page.locator('dialog textarea[name=ms]');
  await ta.fill((await ta.inputValue()) + `\nLaunch@${day(39)}`);
  await page.locator('dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByText('Epic updated').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.rm-ms').length === 3);
});
await step('changes tab shows the human gate and the impact table', async () => {
  await tab('Changes');
  await page.getByText(/needs a human/).first().waitFor();
  await page.getByText(/reworks merged code/).first().waitFor();
  await page.getByText('Per-change emails become a daily digest', { exact: false }).waitFor();
  await shot('changes');
});
await step('approving a change request from the board applies it and creates the rework ticket', async () => {
  const card = page.locator('.change-card').filter({ hasText: cr2 });
  await card.getByRole('button', { name: 'Approve and apply' }).click();
  await page.getByText(`${cr2} approved`).waitFor();
  const r = await call(human, 'GET', `/changes/${cr2}`);
  if (r.change.status !== 'applied') throw new Error(`status ${r.change.status}`);
});
await step('rejecting the decision re-plan from the board', async () => {
  const card = page.locator('.change-card').filter({ hasText: 'Opt-out' }).first();
  await card.getByRole('button', { name: 'Reject' }).click();
  await page.locator('dialog textarea[name=reason]').fill('not yet');
  await page.locator('dialog').getByRole('button', { name: 'Reject' }).click();
  await page.getByText(/rejected/).first().waitFor();
});
await step('inputs and decision log list the PRD versions and decisions', async () => {
  await tab('Inputs & decisions');
  await page.getByRole('button', { name: 'Notifications PRD' }).waitFor();
  await page.getByText('v2 / v2').waitFor();
  await page.getByText('Customers can opt out of email').waitFor();
  await shot('inputs-decisions');
});
await step('adding and approving an input from the board opens a re-plan', async () => {
  await page.getByRole('button', { name: 'Add input' }).click();
  await page.locator('dialog input[name=title]').fill('Support feedback');
  await page.locator('dialog select[name=kind]').selectOption('feedback');
  await page.locator('dialog input[value=billing]').check();
  await page.locator('dialog textarea[name=body]').fill('## Invoices\nCustomers want PDF invoices.');
  await page.locator('dialog').getByRole('button', { name: 'Add' }).click();
  await page.getByText(/I2 approved/).waitFor();
  const { changes } = await call(human, 'GET', '/changes?projectId=billing&status=open');
  if (changes.length !== 1 || changes[0].trigger.kind !== 'ingest') throw new Error(JSON.stringify(changes.map((c) => c.trigger)));
});
await step('change log tells the story of the epic', async () => {
  await page.locator('select[aria-label="Selected project"]').selectOption('customer-notifications');
  await tab('Log');
  await page.getByText(/change\.applied/).first().waitFor();
  await page.getByText(/change\.rejected/).first().waitFor();
  await shot('log');
});
await step('no page errors', async () => {
  if (errors.length) throw new Error(errors.join(' | '));
});

await browser.close();
console.log(`\n== ${pass} passed, ${fail} failed (screenshots in ${SHOTS})`);
stop();
process.exit(fail ? 1 : 0);
