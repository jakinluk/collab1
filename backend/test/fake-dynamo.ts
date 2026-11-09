import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown>;
type Input = Record<string, unknown> & {
  TableName?: string;
  Key?: Item;
  Item?: Item;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  KeyConditionExpression?: string;
  IndexName?: string;
  Limit?: number;
  TransactItems?: Record<string, Input>[];
};

const key = (k: Item): string => `${String(k.PK)}|${String(k.SK)}`;

export class FakeDynamo {
  readonly items = new Map<string, Item>();
  transactions = 0;

  private cond(expr: string | undefined, input: Input, existing: Item | undefined): boolean {
    if (!expr) return true;
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    if (expr === 'attribute_not_exists(PK)') return !existing;
    if (expr === '#v = :v') return existing !== undefined && existing[names['#v']] === values[':v'];
    if (expr === 'attribute_not_exists(seq) OR seq = :prev') return !existing || existing.seq === undefined || existing.seq === values[':prev'];
    throw new Error(`fake: unsupported condition ${expr}`);
  }

  private update(input: Input, existing: Item | undefined): Item {
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const item: Item = { ...(existing ?? {}), ...(input.Key as Item) };
    const expr = input.UpdateExpression ?? '';
    let m = /^ADD (#\w+) (:\w+)$/.exec(expr);
    if (m) {
      const attr = names[m[1]];
      item[attr] = Number(item[attr] ?? 0) + Number(values[m[2]]);
      return item;
    }
    m = /^SET (\w+) = (:\w+)$/.exec(expr);
    if (m) {
      item[m[1]] = values[m[2]];
      return item;
    }
    throw new Error(`fake: unsupported update ${expr}`);
  }

  private query(input: Input): Item[] {
    const v = input.ExpressionAttributeValues ?? {};
    const expr = input.KeyConditionExpression ?? '';
    const gsi = input.IndexName === 'GSI1';
    const pkAttr = gsi ? 'GSI1PK' : 'PK';
    const skAttr = gsi ? 'GSI1SK' : 'SK';
    let rows = [...this.items.values()].filter((i) => i[pkAttr] === v[':pk']);
    if (expr.includes('begins_with')) rows = rows.filter((i) => String(i[skAttr] ?? '').startsWith(String(v[':sk'])));
    if (expr.includes('SK > :since')) rows = rows.filter((i) => String(i[skAttr]) > String(v[':since']));
    rows.sort((a, b) => String(a[skAttr]).localeCompare(String(b[skAttr])));
    if (input.Limit) rows = rows.slice(0, input.Limit);
    return rows.map((r) => structuredClone(r));
  }

  async send(cmd: { input: Input; constructor: { name: string } }): Promise<Record<string, unknown>> {
    const input = cmd.input;
    switch (cmd.constructor.name) {
      case 'GetCommand': {
        const it = this.items.get(key(input.Key as Item));
        return { Item: it ? structuredClone(it) : undefined };
      }
      case 'QueryCommand':
        return { Items: this.query(input) };
      case 'UpdateCommand': {
        const k = key(input.Key as Item);
        const next = this.update(input, this.items.get(k));
        this.items.set(k, next);
        return { Attributes: structuredClone(next) };
      }
      case 'TransactWriteCommand': {
        this.transactions++;
        const ops = input.TransactItems ?? [];
        const seen = new Set<string>();
        const reasons = ops.map((op) => {
          const [kind, body] = Object.entries(op)[0];
          const k = key((body.Item ?? body.Key) as Item);
          if (seen.has(k)) throw new Error(`fake: multiple operations on one item ${k}`);
          seen.add(k);
          const ok = this.cond(body.ConditionExpression, body, this.items.get(k));
          return { Code: ok ? 'None' : 'ConditionalCheckFailed', kind };
        });
        if (reasons.some((r) => r.Code !== 'None'))
          throw new TransactionCanceledException({ message: 'Transaction cancelled', $metadata: {}, CancellationReasons: reasons.map((r) => ({ Code: r.Code })) });
        for (const op of ops) {
          const [kind, body] = Object.entries(op)[0];
          if (kind === 'Put') this.items.set(key(body.Item as Item), structuredClone(body.Item as Item));
          else if (kind === 'Delete') this.items.delete(key(body.Key as Item));
          else if (kind === 'Update') {
            const k = key(body.Key as Item);
            this.items.set(k, this.update(body, this.items.get(k)));
          }
        }
        return {};
      }
      default:
        throw new Error(`fake: unsupported command ${cmd.constructor.name}`);
    }
  }

  asClient(): DynamoDBDocumentClient {
    return this as unknown as DynamoDBDocumentClient;
  }
}
