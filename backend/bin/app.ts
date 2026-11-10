import * as path from 'node:path';
import { App, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { C1Stack } from '../lib/c1-stack';

const app = new App();
const ctx = (key: string, fallback?: string): string => {
  const v = app.node.tryGetContext(key) as string | undefined;
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`missing context value "${key}" (pass -c ${key}=...)`);
    return fallback;
  }
  return String(v);
};

const mode = ctx('mode', 'event');
if (mode !== 'event' && mode !== 'ongoing') throw new Error(`mode must be event or ongoing, got "${mode}"`);
const eventEndsAt = mode === 'event' ? ctx('eventEndsAt') : undefined;
if (eventEndsAt !== undefined && Number.isNaN(Date.parse(eventEndsAt))) throw new Error(`eventEndsAt must be an ISO timestamp, got "${eventEndsAt}"`);
const LOG_RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];
const logRetentionDays = Number(ctx('logRetentionDays', '7'));
if (!LOG_RETENTION_DAYS.includes(logRetentionDays)) throw new Error(`logRetentionDays must be one of ${LOG_RETENTION_DAYS.join(', ')}`);
const sweepMinutes = Number(ctx('sweepMinutes', mode === 'ongoing' ? '5' : '1'));
if (!Number.isInteger(sweepMinutes) || sweepMinutes < 1 || sweepMinutes > 60) throw new Error('sweepMinutes must be a whole number from 1 to 60');
const waf = ctx('waf', 'off');
if (waf !== 'on' && waf !== 'off') throw new Error(`waf must be on or off, got "${waf}"`);
const lambdaConcurrency = ctx('lambdaConcurrency', 'on');
if (lambdaConcurrency !== 'on' && lambdaConcurrency !== 'off') throw new Error(`lambdaConcurrency must be on or off, got "${lambdaConcurrency}"`);
const domainPrefix = ctx('domainPrefix');
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domainPrefix) || /aws|amazon|cognito/.test(domainPrefix))
  throw new Error('domainPrefix must be lowercase letters, digits and dashes, and must not contain aws, amazon or cognito');

const stack = new C1Stack(app, ctx('stackName', 'CollabOne'), {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: `CollabOne hub (${mode} mode): board, API, push events and auth for teams of Claude Code agents`,
  mode,
  eventEndsAt: eventEndsAt ? new Date(eventEndsAt).toISOString() : undefined,
  tokenTtlDays: Number(ctx('tokenTtlDays', '30')),
  eventRetentionDays: Number(ctx('eventRetentionDays', '90')),
  logRetentionDays,
  sweepMinutes,
  waf: waf === 'on',
  lambdaConcurrency: lambdaConcurrency === 'on',
  domainPrefix,
  dataTtlDays: Number(ctx('dataTtlDays', '21')),
  removalPolicy: ctx('removalPolicy', mode === 'ongoing' ? 'retain' : 'destroy') === 'retain' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  version: ctx('version', '0.5.0'),
  toolRepoUrl: ctx('toolRepoUrl', 'https://github.com/jakinluk/collab1.git'),
  boardDir: path.resolve(__dirname, '..', '..', 'board'),
});
Tags.of(stack).add('project', 'collabone');
