import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { Envelope } from '../shared/types';
import { channelFor } from '../core/envelope';

export const MAX_EVENTS_PER_PUBLISH = 5;

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const envCredentials = async (): Promise<Credentials> => {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('AWS credentials are not available in the environment');
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
};

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const groupByChannel = (events: readonly Envelope[]): { channel: string; events: string[] }[] => {
  const batches: { channel: string; events: string[] }[] = [];
  for (const e of events) {
    const channel = channelFor(e);
    const last = batches[batches.length - 1];
    if (last && last.channel === channel && last.events.length < MAX_EVENTS_PER_PUBLISH) last.events.push(JSON.stringify(e));
    else batches.push({ channel, events: [JSON.stringify(e)] });
  }
  return batches;
};

export class EventsPublisher {
  private readonly signer: SignatureV4;

  constructor(
    private readonly httpHost: string,
    region: string,
    credentials: () => Promise<Credentials> = envCredentials,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {
    this.signer = new SignatureV4({ service: 'appsync', region, credentials, sha256: Sha256 });
  }

  async publish(channel: string, events: string[]): Promise<void> {
    const body = JSON.stringify({ channel, events });
    const request = new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: this.httpHost,
      path: '/event',
      headers: { host: this.httpHost, 'content-type': 'application/json; charset=UTF-8', accept: 'application/json, text/javascript' },
      body,
    });
    const signed = await this.signer.sign(request);
    const res = await this.fetchImpl(`https://${this.httpHost}/event`, { method: 'POST', headers: signed.headers as Record<string, string>, body });
    if (!res.ok) throw new Error(`AppSync Events publish to ${channel} failed: ${res.status} ${await res.text()}`);
  }

  async publishEnvelopes(events: readonly Envelope[]): Promise<number> {
    let n = 0;
    for (const batch of groupByChannel(events)) {
      await this.publish(batch.channel, batch.events);
      n += batch.events.length;
    }
    return n;
  }
}
