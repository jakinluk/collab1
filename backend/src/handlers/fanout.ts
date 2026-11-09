import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { Envelope } from '../shared/types';
import { strip } from '../adapters/keys';
import { EventsPublisher, MAX_EVENTS_PER_PUBLISH } from '../adapters/publisher';
import { channelFor } from '../core/envelope';
import { requireEnv } from '../adapters/config';

let publisher: EventsPublisher | undefined;

export const envelopesFrom = (event: DynamoDBStreamEvent): { seqNo: string; envelope: Envelope }[] =>
  event.Records.flatMap((r) => {
    const img = r.dynamodb?.NewImage as Record<string, AttributeValue> | undefined;
    if (!img || r.eventName === 'REMOVE' || img.PK?.S !== 'EVENT') return [];
    return [{ seqNo: r.dynamodb?.SequenceNumber ?? '', envelope: strip<Envelope>(unmarshall(img)) }];
  });

export const batches = (items: { seqNo: string; envelope: Envelope }[]): { firstSeqNo: string; channel: string; events: string[] }[] => {
  const out: { firstSeqNo: string; channel: string; events: string[] }[] = [];
  for (const it of items) {
    const channel = channelFor(it.envelope);
    const last = out[out.length - 1];
    if (last && last.channel === channel && last.events.length < MAX_EVENTS_PER_PUBLISH) last.events.push(JSON.stringify(it.envelope));
    else out.push({ firstSeqNo: it.seqNo, channel, events: [JSON.stringify(it.envelope)] });
  }
  return out;
};

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  publisher ??= new EventsPublisher(requireEnv('EVENTS_HTTP_HOST'), requireEnv('AWS_REGION'));
  const items = envelopesFrom(event).sort((a, b) => a.envelope.seq - b.envelope.seq);
  for (const b of batches(items)) {
    try {
      await publisher.publish(b.channel, b.events);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', where: 'fanout', channel: b.channel, message: e instanceof Error ? e.message : String(e) }));
      return { batchItemFailures: [{ itemIdentifier: b.firstSeqNo }] };
    }
  }
  return { batchItemFailures: [] };
};
