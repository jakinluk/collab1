import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const TTL_MS = 5 * 60_000;

interface Cached<T> {
  value: T;
  at: number;
}

const cache = new Map<string, Cached<unknown>>();

const cached = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key) as Cached<T> | undefined;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { value, at: Date.now() });
  return value;
};

let sm: SecretsManagerClient | undefined;
let ssm: SSMClient | undefined;

export const secretString = (arn: string): Promise<string> =>
  cached(`secret:${arn}`, async () => {
    sm ??= new SecretsManagerClient({});
    const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!r.SecretString) throw new Error(`secret ${arn} has no string value`);
    return r.SecretString;
  });

export interface RuntimeConfig {
  boardUrl: string;
  apiUrl: string;
  userPoolId: string;
  clientId: string;
  region: string;
  events: { httpHost: string; realtimeUrl: string; namespace: string };
}

export const runtimeConfig = (parameterName: string): Promise<RuntimeConfig> =>
  cached(`param:${parameterName}`, async () => {
    ssm ??= new SSMClient({});
    const r = await ssm.send(new GetParameterCommand({ Name: parameterName }));
    if (!r.Parameter?.Value) throw new Error(`parameter ${parameterName} is empty`);
    return JSON.parse(r.Parameter.Value) as RuntimeConfig;
  });

export const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
};

export const clearConfigCache = (): void => cache.clear();
