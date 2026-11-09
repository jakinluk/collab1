import { Hub } from '../app/hub';
import { Store } from '../adapters/store';
import type { HubMode } from '../shared/types';
import { SkillFiles } from '../adapters/s3';
import { requireEnv, runtimeConfig, secretString } from '../adapters/config';

let hub: Hub | undefined;

const hubMode = (): HubMode => (process.env.HUB_MODE === 'ongoing' ? 'ongoing' : 'event');

export const getHub = (): Hub => {
  if (hub) return hub;
  const mode = hubMode();
  const dataTtlDays = Number(process.env.DATA_TTL_DAYS ?? '21');
  hub = new Hub({
    store: new Store(requireEnv('TABLE_NAME'), { mode, dataTtlDays, eventDays: Number(process.env.EVENT_RETENTION_DAYS ?? '90') }),
    files: new SkillFiles(process.env.SKILLS_BUCKET ?? ''),
    pepper: () => secretString(requireEnv('PEPPER_SECRET_ARN')),
    runtime: () => runtimeConfig(requireEnv('RUNTIME_PARAM')),
    mode,
    eventEndsAt: mode === 'event' ? Date.parse(requireEnv('EVENT_ENDS_AT')) : undefined,
    tokenTtlDays: Number(process.env.TOKEN_TTL_DAYS ?? '30'),
    toolRepoUrl: process.env.TOOL_REPO_URL || undefined,
  });
  return hub;
};

export const originSecret = (): Promise<string> => secretString(requireEnv('ORIGIN_SECRET_ARN'));

export const safeEqual = (a: string | undefined, b: string): boolean => {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
