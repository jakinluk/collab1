import { Hub } from '../app/hub';
import { Store } from '../adapters/store';
import { SkillFiles } from '../adapters/s3';
import { requireEnv, runtimeConfig, secretString } from '../adapters/config';

let hub: Hub | undefined;

export const getHub = (): Hub =>
  (hub ??= new Hub({
    store: new Store(requireEnv('TABLE_NAME'), Number(process.env.DATA_TTL_DAYS ?? '21')),
    files: new SkillFiles(process.env.SKILLS_BUCKET ?? ''),
    pepper: () => secretString(requireEnv('PEPPER_SECRET_ARN')),
    runtime: () => runtimeConfig(requireEnv('RUNTIME_PARAM')),
    eventEndsAt: Date.parse(requireEnv('EVENT_ENDS_AT')),
  toolRepoUrl: process.env.TOOL_REPO_URL || undefined,
  }));

export const originSecret = (): Promise<string> => secretString(requireEnv('ORIGIN_SECRET_ARN'));

export const safeEqual = (a: string | undefined, b: string): boolean => {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
