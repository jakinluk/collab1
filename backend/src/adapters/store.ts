import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Envelope, EnvelopeInput } from '../shared/types';
import { DomainError } from '../core/errors';
import { finalize } from '../core/envelope';
import { K, strip, type Keys } from './keys';

export type TxItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export interface Versioned<T> {
  value: T;
  v: number;
}

const MAX_TX_ITEMS = 100;

export class Store {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    private readonly ttlDays: number,
    doc?: DynamoDBDocumentClient,
    private readonly now: () => number = Date.now,
  ) {
    this.doc = doc ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  }

  ttl(): number {
    return Math.floor(this.now() / 1000) + this.ttlDays * 86_400;
  }

  async get<T>(keys: Keys, consistent = true): Promise<Versioned<T> | undefined> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { PK: keys.PK, SK: keys.SK }, ConsistentRead: consistent }));
    if (!r.Item) return undefined;
    return { value: strip<T>(r.Item), v: Number(r.Item._v ?? 0) };
  }

  async queryPk<T>(pk: string, skPrefix?: string): Promise<Versioned<T>[]> {
    return this.paginate<T>({
      TableName: this.table,
      KeyConditionExpression: skPrefix ? 'PK = :pk AND begins_with(SK, :sk)' : 'PK = :pk',
      ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':sk': skPrefix } : { ':pk': pk },
      ConsistentRead: true,
    });
  }

  async queryGsi<T>(gsi1pk: string, skPrefix?: string): Promise<Versioned<T>[]> {
    return this.paginate<T>({
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: skPrefix ? 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)' : 'GSI1PK = :pk',
      ExpressionAttributeValues: skPrefix ? { ':pk': gsi1pk, ':sk': skPrefix } : { ':pk': gsi1pk },
    });
  }

  private async paginate<T>(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Versioned<T>[]> {
    const out: Versioned<T>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({ ...input, ExclusiveStartKey: start }));
      for (const item of r.Items ?? []) out.push({ value: strip<T>(item), v: Number(item._v ?? 0) });
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async events(since: number, limit: number): Promise<Envelope[]> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND SK > :since',
        ExpressionAttributeValues: { ':pk': 'EVENT', ':since': K.event(since).SK },
        Limit: limit,
        ConsistentRead: true,
      }),
    );
    return (r.Items ?? []).map((i) => strip<Envelope>(i));
  }

  async lastSeq(): Promise<number> {
    const c = await this.get<{ seq: number }>(K.counter('event'));
    return c?.value.seq ?? 0;
  }

  async nextIds(counter: string, n = 1): Promise<number[]> {
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: K.counter(counter),
        UpdateExpression: 'ADD #n :n',
        ExpressionAttributeNames: { '#n': 'n' },
        ExpressionAttributeValues: { ':n': n },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const last = Number(r.Attributes?.n ?? n);
    return Array.from({ length: n }, (_, i) => last - n + 1 + i);
  }

  put(keys: Keys, value: object, expectedV?: number): TxItem {
    const item: Record<string, unknown> = { ...value, ...keys, ttl: this.ttl(), _v: (expectedV ?? 0) + 1 };
    if (expectedV === undefined) return { Put: { TableName: this.table, Item: item } };
    if (expectedV === 0) return { Put: { TableName: this.table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } };
    return {
      Put: { TableName: this.table, Item: item, ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': '_v' }, ExpressionAttributeValues: { ':v': expectedV } },
    };
  }

  putNew(keys: Keys, value: object): TxItem {
    return this.put(keys, value, 0);
  }

  delete(keys: Keys, expectedV?: number): TxItem {
    const base = { TableName: this.table, Key: { PK: keys.PK, SK: keys.SK } };
    if (expectedV === undefined) return { Delete: base };
    return { Delete: { ...base, ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': '_v' }, ExpressionAttributeValues: { ':v': expectedV } } };
  }

  check(keys: Keys, expectedV: number): TxItem {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: { PK: keys.PK, SK: keys.SK },
        ConditionExpression: expectedV === 0 ? 'attribute_not_exists(PK)' : '#v = :v',
        ...(expectedV === 0 ? {} : { ExpressionAttributeNames: { '#v': '_v' }, ExpressionAttributeValues: { ':v': expectedV } }),
      },
    };
  }

  async commit(ops: TxItem[], events: EnvelopeInput[] = []): Promise<Envelope[]> {
    if (ops.length + events.length + 1 > MAX_TX_ITEMS) throw new DomainError('invalid', 'change set too large for one transaction');
    if (ops.length === 0 && events.length === 0) return [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const prev = events.length ? await this.lastSeq() : 0;
      const ts = this.now();
      const finals = events.map((e, i) => finalize(e, prev + i + 1, ts));
      const counterOp: TxItem[] = events.length
        ? [
            {
              Update: {
                TableName: this.table,
                Key: K.counter('event'),
                UpdateExpression: 'SET seq = :next',
                ConditionExpression: 'attribute_not_exists(seq) OR seq = :prev',
                ExpressionAttributeValues: { ':next': prev + events.length, ':prev': prev },
              },
            },
          ]
        : [];
      const eventOps: TxItem[] = finals.map((e) => ({ Put: { TableName: this.table, Item: { ...e, ...K.event(e.seq), ttl: this.ttl() } } }));
      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: [...counterOp, ...ops, ...eventOps] }));
        return finals;
      } catch (err) {
        if (!(err instanceof TransactionCanceledException)) throw err;
        const reasons = err.CancellationReasons ?? [];
        const failed = reasons.map((r, i) => ({ i, code: r.Code })).filter((r) => r.code && r.code !== 'None');
        const onlyCounter = events.length > 0 && failed.length > 0 && failed.every((f) => f.i === 0);
        const conflictRetry = failed.some((f) => f.code === 'TransactionConflict');
        if (onlyCounter || (conflictRetry && failed.every((f) => f.code === 'TransactionConflict'))) {
          await new Promise((r) => setTimeout(r, 15 + Math.random() * 40 * (attempt + 1)));
          continue;
        }
        throw new DomainError('conflict', 'the record changed while you were updating it; re-read and retry', { reasons: failed.map((f) => f.code) });
      }
    }
    throw new DomainError('conflict', 'too much contention on the event log; retry');
  }

  async commitChunked(opChunks: TxItem[][], events: EnvelopeInput[]): Promise<Envelope[]> {
    for (let i = 0; i < opChunks.length - 1; i++) await this.commit(opChunks[i], []);
    return this.commit(opChunks[opChunks.length - 1] ?? [], events);
  }
}

export const chunk = <T>(xs: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out.length ? out : [[]];
};
