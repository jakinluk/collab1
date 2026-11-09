// End-to-end run of the board (real browser) against the local hub, with a real h1 CLI seat
// acting as the agent side. Usage: node board-e2e.mjs [--headed]
// Needs Google Chrome (Playwright channel "chrome") and the backend dev dependencies.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8792);
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/v1`;
const H1 = path.join(ROOT, 'plugin/bin/h1');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-board-e2e-'));
const SHOTS = process.env.SHOTS ?? path.join(WORK, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0;
let failed = 0;
const results = [];
const ok = (name) => {
  pass++;
  results.push(`  ok   ${name}`);
  console.log(`  ok   ${name}`);
};
const bad = (name, err) => {
  failed++;
  results.push(`  FAIL ${name}`);
  console.log(`  FAIL ${name}\n       ${String(err?.message ?? err).split('\n').slice(0, 6).join('\n       ')}`);
};
let debugPage = null;
const step = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, e);
    if (debugPage && process.env.DEBUG) console.log('--- rail:\n' + (await debugPage.locator('aside').first().innerText().catch(() => '(no rail)')).slice(0, 1500));
  }
};

const hubLog = fs.openSync(path.join(WORK, 'hub.log'), 'w');
const hub = spawn('npx', ['tsx', 'scripts/local-hub.ts', '--port', String(PORT), '--sweep-ms', '600000'], { cwd: path.join(ROOT, 'backend'), stdio: ['ignore', hubLog, hubLog], detached: true });
const stop = () => {
  try {
    process.kill(-hub.pid);
  } catch {
    /* already gone */
  }
};
process.on('exit', stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${API}/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(200);
}

const seatHome = (seat) => {
  const d = path.join(WORK, seat);
  fs.mkdirSync(path.join(d, 'h1'), { recursive: true });
  fs.mkdirSync(path.join(d, 'home'), { recursive: true });
  return { H1_HOME: path.join(d, 'h1'), HOME: path.join(d, 'home'), H1_TOKEN_FILE: '1' };
};
const cli = (seat, ...args) => execFileSync(H1, args, { env: { ...process.env, ...seatHome(seat) }, encoding: 'utf8', timeout: 30000 });
const devToken = async (email) => (await (await fetch(`${BASE}/_dev/token?email=${email}`, { method: 'POST' })).json()).idToken;
const call = async (token, method, p, body) => {
  const r = await fetch(API + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
const pageErrors = [];
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => pageErrors.push(e.stack ?? e.message));
  return page;
};
const signIn = async (page, email) => {
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.fill('input[name=email]', email);
  await page.click('button[type=submit]');
  await page.waitForLoadState();
};
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const expectText = async (locator, re, timeout = 5000) => {
  await locator.filter({ hasText: re }).first().waitFor({ timeout });
};

console.log(`== board e2e on ${BASE} (work dir ${WORK})`);
const page = await newPage();
debugPage = page;
const body = page.locator('body');

await step('sign-in runs the PKCE code flow and lands on the seat form', async () => {
  await signIn(page, 'ania@example.com');
  await page.getByRole('heading', { name: 'Create your seat' }).waitFor();
  const auth = await page.evaluate(() => sessionStorage.getItem('h1.auth'));
  if (!auth || !JSON.parse(auth).idToken) throw new Error('no ID token in sessionStorage');
  if (new URL(page.url()).search) throw new Error(`callback query left in the URL: ${page.url()}`);
});

await step('creating a seat opens the live board', async () => {
  await page.fill('#seat-id', 'ania');
  await page.fill('#seat-name', 'Ania');
  await page.fill('#seat-lanes', 'api');
  await page.getByRole('button', { name: 'Create my seat' }).click();
  await expectText(body, /No projects yet/);
  await expectText(page.locator('.conn'), /Live/);
  if ((await page.locator('#app').evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).length)) > 0) throw new Error('stray text at the top of the page');
  await shot(page, '01-empty-board');
});

const bobJwt = await devToken('bob@example.com');
await call(bobJwt, 'POST', '/seats/me', { id: 'bob', name: 'Bob', plan: 'ultra', lanes: ['mobile'] });
const { code: bobCode } = await call(bobJwt, 'POST', '/join-codes');
cli('bob', 'join', '--code', bobCode, '--api', BASE);

await step('an agent proposal appears live under "Needs a human"', async () => {
  cli('bob', 'project', 'propose-new', '--name', 'Offline Capture', '--repo', 'mono=git@github.com:acme/mono.git', '--preset', 'nx-monorepo', '--lane', 'api', '--lane', 'mobile', '--link', 'spec=https://example.com/spec');
  await expectText(page.locator('section'), /P1[\s\S]*Create project Offline Capture/);
});

await step('approving P1 in the board creates the project', async () => {
  await page.locator('.item', { hasText: 'P1' }).getByRole('button', { name: /^Approve/ }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) await dialog.getByRole('button', { name: 'Approve' }).click();
  await expectText(body, /main → hack\/offline-capture/);
  await shot(page, '02-project-created');
});

await step('the event log shows history on first load', async () => {
  const fresh = await newPage();
  await signIn(fresh, 'ania@example.com');
  await expectText(fresh.locator('body'), /Project Offline Capture \(offline-capture\) created/);
  await fresh.context().close();
});

cli('bob', 'me', 'pin', 'offline-capture');
fs.writeFileSync(path.join(WORK, 'goal.json'), JSON.stringify({ statement: 'Field techs capture notes offline and sync later', definitionOfDone: ['Note saved offline', 'Sync endpoint accepts batches', 'Demo runs end to end'], demoScript: 'Airplane mode, capture, reconnect' }));
fs.writeFileSync(
  path.join(WORK, 'plan.json'),
  JSON.stringify({
    tickets: [
      { id: 'contracts', repo: 'mono', title: 'Sync contracts', type: 'contract', lanes: ['contract'], pathsOwned: ['libs/shared/api-interfaces/src/note-sync/**'], acceptance: [{ criterion: 'types compile', cmd: 'npm run type:check' }], priority: 1, wave: 1, dodRefs: [1] },
      { id: 'queue', repo: 'mono', title: 'Offline queue', type: 'slice', lanes: ['mobile'], deps: ['contracts'], pathsOwned: ['apps/mobile/src/features/offline-queue/**'], acceptance: [{ criterion: 'queue survives restart' }], priority: 2, wave: 2, dodRefs: [0] },
    ],
  }),
);

await step('goal and plan proposals are approved from the board', async () => {
  cli('bob', 'goal', 'propose', '--file', path.join(WORK, 'goal.json'));
  await page.locator('.item', { hasText: 'P2' }).getByRole('button', { name: /^Approve/ }).click({ timeout: 5000 });
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expectText(body, /Field techs capture notes offline and sync later/);
  cli('bob', 'plan', 'propose', '--file', path.join(WORK, 'plan.json'));
  await page.locator('.item', { hasText: 'P3' }).getByRole('button', { name: /^Approve/ }).click({ timeout: 5000 });
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expectText(body, /Sync contracts/);
  await expectText(body, /0 of 3/);
});

await step('a CLI booking moves the card live', async () => {
  cli('bob', 'ticket', 'next');
  cli('bob', 'ticket', 'start', 'T1');
  await page.waitForFunction(() => [...document.querySelectorAll('section, .col, .column')].some((s) => /In progress/.test(s.textContent ?? '') && /Sync contracts/.test(s.textContent ?? '') && /T1/.test(s.textContent ?? '')), null, { timeout: 5000 });
  await shot(page, '03-ticket-in-progress');
});

await step('a B4 raised by an agent can be resolved in the board', async () => {
  cli('bob', 'raise', 'blocker', '--rule', 'B4', '--ticket', 'T1', '--summary', 'Accept partial batches?', '--option', 'reject batch', '--option', 'accept valid items');
  const item = page.locator('.item', { hasText: 'Accept partial batches?' });
  await item.getByRole('button', { name: 'Resolve' }).click({ timeout: 5000 });
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[value="accept valid items"]').check();
  await dialog.locator('#res-reason').fill('keeps the demo moving');
  await shot(page, '04-resolve-dialog');
  await dialog.getByRole('button', { name: 'Resolve' }).click();
  await expectText(page.locator('.item', { hasText: 'Accept partial batches?' }), /contest closes in/);
});

const cyril = await newPage();
await step('another human contests from a second browser and the humans vote', async () => {
  await signIn(cyril, 'cyril@example.com');
  await cyril.fill('#seat-id', 'cyril');
  await cyril.fill('#seat-name', 'Cyril');
  await cyril.getByRole('button', { name: 'Create my seat' }).click();
  const item = cyril.locator('.item', { hasText: 'Accept partial batches?' });
  await item.getByRole('button', { name: 'Contest' }).click({ timeout: 5000 });
  await cyril.getByRole('dialog').locator('#con-reason').fill('partial sync confuses field techs');
  await cyril.getByRole('dialog').getByRole('button', { name: 'Contest' }).click();
  await expectText(page.locator('section'), /Contested E1/);
  const vote = page.locator('.item', { hasText: 'Contested E1' });
  await vote.getByRole('button', { name: /^Vote uphold/ }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    const why = dialog.locator('textarea, input[type=text]').first();
    if (await why.count()) await why.fill('demo path first');
    await dialog.getByRole('button', { name: /Vote|Save|Submit/ }).last().click();
  }
  await expectText(page.locator('.item', { hasText: 'Contested E1' }), /1\/3|uphold · human/);
  await shot(page, '05-human-vote');
});

await step('rule edits are saved as a new rules version', async () => {
  await page.getByRole('tab', { name: 'Rules' }).click();
  await page.getByRole('button', { name: 'Edit rule B3' }).click();
  await page.fill('#rule-max', '3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expectText(body, /v2|version 2/);
  const rules = await call(await devToken('ania@example.com'), 'GET', '/rules');
  const b3 = (rules.rules ?? rules.rows ?? []).find((r) => r.code === 'B3');
  if (b3?.maxAttempts !== 3) throw new Error(`B3 maxAttempts is ${b3?.maxAttempts}`);
  await shot(page, '06-rules');
});

await step('a join code from the board connects a Mac', async () => {
  await page.getByRole('tab', { name: /Tokens/ }).click();
  await page.getByRole('button', { name: /Create join code|New code/ }).click();
  const code = (await page.locator('.join-code').innerText()).trim();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw new Error(`unexpected join code ${code}`);
  await expectText(page.locator('.cmd code'), new RegExp(`h1 join --code ${code} --api ${BASE}`));
  const out = cli('ania', 'join', '--code', code, '--api', BASE);
  if (!/Joined as ania/.test(out)) throw new Error(out);
  await expectText(page.locator('table.data'), /tk_/);
  if (await page.locator('.join-code').count()) throw new Error('the used join code is still shown');
  await shot(page, '07-tokens');
});

await step('a project created in the board editor is live for agents', async () => {
  await page.getByRole('tab', { name: 'Board' }).click();
  await page.getByRole('button', { name: /New project/ }).first().click();
  const dialog = page.getByRole('dialog').or(page.locator('.project-editor')).first();
  await dialog.getByLabel(/^Name/).fill('Repair Cart');
  await dialog.getByLabel('Repo name').fill('cart');
  await dialog.getByLabel('Git URL').fill('git@github.com:acme/cart.git');
  await dialog.getByLabel('Demo URL').fill('not-a-url');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expectText(dialog, /Demo URL must be an https:\/\/ URL/);
  await dialog.getByLabel('Demo URL').fill('https://cart.example.com');
  await shot(page, '08-project-editor');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expectText(body, /Repair Cart/);
  const out = cli('ania', 'project', 'list');
  if (!/repair-cart/.test(out)) throw new Error(out);
});

await step('the HackathonOne repo is set in Settings and a CLI bug opens the fix queue', async () => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.fill('#set-tool-repo', 'git@github.com:acme/hakatonOne.git');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expectText(page.locator('#toasts'), /Settings saved/);
  const out = cli('ania', 'bug', 'board shows no release banner', '--area', 'board');
  if (!/Filed T\d+ in the HackathonOne fix queue/.test(out)) throw new Error(out);
  await page.getByRole('tab', { name: 'Board' }).click();
  await expectText(body, /HackathonOne fixes/);
});

await step('publishing a release in Settings announces it on every open board', async () => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.fill('#rel-version', '0.3.1');
  await page.fill('#rel-notes', 'Release banner on the board');
  await page.getByRole('button', { name: 'Publish release' }).click();
  await expectText(page.locator('#release-current'), /Latest 0\.3\.1/);
  await expectText(cyril.locator('.release-banner'), /HackathonOne 0\.3\.1 released/);
  await shot(page, '09-release-settings');
  await shot(cyril, '10-release-banner');
  const v = cli('ania', 'version');
  if (!/0\.3\.1 is out|up to date/.test(v)) throw new Error(v);
});

await browser.close();
console.log(pageErrors.length ? `\npage errors:\n${pageErrors.join('\n')}` : '\nno page errors');
if (pageErrors.length) failed++;
console.log(`\n== ${pass} passed, ${failed} failed (screenshots in ${SHOTS})`);
stop();
process.exit(failed ? 1 : 0);
