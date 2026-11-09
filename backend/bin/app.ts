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

const eventEndsAt = ctx('eventEndsAt');
if (Number.isNaN(Date.parse(eventEndsAt))) throw new Error(`eventEndsAt must be an ISO timestamp, got "${eventEndsAt}"`);
const domainPrefix = ctx('domainPrefix');
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domainPrefix) || /aws|amazon|cognito/.test(domainPrefix))
  throw new Error('domainPrefix must be lowercase letters, digits and dashes, and must not contain aws, amazon or cognito');

const stack = new C1Stack(app, ctx('stackName', 'CollabOne'), {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'CollabOne hub: board, API, push events and auth for a Claude Code team hackathon',
  eventEndsAt: new Date(eventEndsAt).toISOString(),
  domainPrefix,
  dataTtlDays: Number(ctx('dataTtlDays', '21')),
  removalPolicy: ctx('removalPolicy', 'destroy') === 'retain' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  version: ctx('version', '0.4.0'),
  toolRepoUrl: ctx('toolRepoUrl', 'https://github.com/jakinluk/collab1.git'),
  boardDir: path.resolve(__dirname, '..', '..', 'board'),
});
Tags.of(stack).add('project', 'collabone');
