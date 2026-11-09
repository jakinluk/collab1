import type { BlockerRule } from '../shared/types';

export const DEFAULT_RULES: readonly BlockerRule[] = [
  {
    code: 'B1',
    name: 'Contract change',
    trigger: 'Needs to change a shared interface, schema, event, or an API another ticket uses',
    severity: 'P1',
    resolver: 'agent_quorum',
    resolverNote: 'affected seats',
    quorumRule: 'majority',
    timeoutMin: 10,
    defaultOnTimeout: 'Keep the current contract and add an adapter on your side',
    stopScope: 'dependents',
    notify: 'affected',
    version: 1,
  },
  {
    code: 'B2',
    name: 'Outside owned paths',
    trigger: 'Needs to edit a file outside pathsOwned (package.json, lockfile, shared config, another ticket\'s area)',
    severity: 'P2',
    resolver: 'owner',
    resolverNote: 'owner of that path or ticket',
    timeoutMin: 5,
    defaultOnTimeout: 'Open a glue ticket and continue with a stub',
    stopScope: 'ticket',
    notify: 'affected',
    version: 1,
  },
  {
    code: 'B3',
    name: 'Env / tooling broken',
    trigger: 'Simulator, build, emulator, deploy, CI or local service won\'t work',
    severity: 'P2',
    resolver: 'any_agent',
    resolverNote: 'help.requested to all agents, then any human',
    timeoutMin: 10,
    defaultOnTimeout: 'Escalate to any human',
    stopScope: 'ticket',
    maxAttempts: 2,
    notify: 'all',
    version: 1,
  },
  {
    code: 'B4',
    name: 'Ambiguous requirement',
    trigger: 'Acceptance criteria are unclear and the choice changes user-visible behaviour on the demo path',
    severity: 'P2',
    resolver: 'any_human',
    timeoutMin: 10,
    contestMin: 5,
    defaultOnTimeout: 'Simplest option that satisfies the demo script, logged as an assumption',
    stopScope: 'ticket',
    notify: 'humans',
    version: 1,
  },
  {
    code: 'B5',
    name: 'Scope / goal change',
    trigger: 'Ticket can\'t be done as specified, or the goal / definition of done needs to change',
    severity: 'P1',
    resolver: 'any_human',
    resolverNote: 'a contest turns it into a human quorum vote',
    quorumRule: 'majority',
    timeoutMin: 15,
    contestMin: 10,
    defaultOnTimeout: 'Cut the ticket, keep the goal',
    stopScope: 'dependents',
    notify: 'humans',
    version: 1,
  },
  {
    code: 'B6',
    name: 'Secrets / access / money',
    trigger: 'Needs credentials, paid services, production data or third-party accounts',
    severity: 'P0',
    resolver: 'any_human',
    resolverNote: 'any human who has the access',
    contestMin: 5,
    defaultOnTimeout: 'Wait: the ticket stays parked and the agent takes other work',
    stopScope: 'ticket',
    maxAttempts: 0,
    notify: 'humans',
    version: 1,
  },
  {
    code: 'B7',
    name: 'Destructive / irreversible',
    trigger: 'Deleting data, force push, rewriting shared history, deploying to a shared or production environment',
    severity: 'P0',
    resolver: 'any_human',
    resolverNote: 'the action waits until the contest window has passed',
    contestMin: 5,
    defaultOnTimeout: 'Do not do it',
    stopScope: 'all',
    maxAttempts: 0,
    notify: 'humans',
    version: 1,
  },
  {
    code: 'B8',
    name: 'Stuck',
    trigger: 'maxAttempts failed verification cycles, or no progress since the last checkpoint',
    severity: 'P2',
    resolver: 'self',
    resolverNote: 'self, then any agent',
    defaultOnTimeout: 'Release with notes; the next taker continues from the pushed WIP; second time → B5',
    stopScope: 'ticket',
    maxAttempts: 3,
    notify: 'affected',
    version: 1,
  },
  {
    code: 'B9',
    name: 'Disagreement / conflict',
    trigger: 'Two agents\' work conflicts (repeated merge conflicts, contradictory designs)',
    severity: 'P1',
    resolver: 'agent_quorum',
    resolverNote: 'involved seats + one neutral',
    quorumRule: 'majority',
    timeoutMin: 10,
    defaultOnTimeout: 'The ticket earlier in the dependency order wins',
    stopScope: 'dependents',
    notify: 'affected',
    version: 1,
  },
  {
    code: 'U1',
    name: 'Urgent: branch red',
    trigger: 'Integration branch fails type-check, tests or smoke',
    severity: 'P0',
    resolver: 'any_agent',
    resolverNote: 'first to book the fix ticket',
    defaultOnTimeout: 'Revert the offending PR',
    stopScope: 'all',
    notify: 'all',
    version: 1,
  },
];

type Clearable = 'timeoutMin' | 'contestMin' | 'maxAttempts';

/** A null in a patch clears that optional field (for example "no timeout"). */
export type RulePatch = Partial<Omit<BlockerRule, 'code' | 'version' | Clearable>> & { [K in Clearable]?: BlockerRule[K] | null };

export interface StoredRule {
  code: string;
  patch: RulePatch;
  version: number;
}

const withoutNulls = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T;

const applyPatch = (base: BlockerRule, patch: RulePatch, version: number): BlockerRule => withoutNulls({ ...base, ...patch, version }) as BlockerRule;

export const mergeRules = (hub: readonly StoredRule[], project: readonly StoredRule[]): BlockerRule[] => {
  const byCode = new Map<string, BlockerRule>(DEFAULT_RULES.map((r) => [r.code, { ...r }]));
  for (const layer of [hub, project]) {
    for (const s of layer) {
      const base = byCode.get(s.code);
      if (base) byCode.set(s.code, applyPatch(base, s.patch, s.version));
      else if (isCompleteRule(s.patch)) byCode.set(s.code, withoutNulls({ ...(s.patch as Omit<BlockerRule, 'code' | 'version'>), code: s.code, version: s.version }));
    }
  }
  return [...byCode.values()].sort((a, b) => ruleSortKey(a.code).localeCompare(ruleSortKey(b.code)));
};

const ruleSortKey = (code: string): string => `${code[0] === 'U' ? 'z' : code[0]}${code.slice(1).padStart(4, '0')}`;

const isCompleteRule = (p: RulePatch): boolean =>
  typeof p.name === 'string' &&
  typeof p.trigger === 'string' &&
  typeof p.severity === 'string' &&
  typeof p.resolver === 'string' &&
  typeof p.defaultOnTimeout === 'string' &&
  typeof p.stopScope === 'string' &&
  typeof p.notify === 'string';

export const findRule = (rules: readonly BlockerRule[], code: string): BlockerRule | undefined => rules.find((r) => r.code === code);

export const rulesDigest = (rules: readonly BlockerRule[], version: number): string =>
  [
    `CollabOne blocker rules v${version}. Classify every problem against these rows before asking anyone; if no row matches, decide yourself and log it.`,
    ...rules.map(
      (r) =>
        `${r.code} ${r.name} [${r.severity}] — ${r.trigger}. Resolver: ${r.resolver}${r.resolverNote ? ` (${r.resolverNote})` : ''}.` +
        `${r.timeoutMin ? ` Timeout ${r.timeoutMin} min →` : ' Default:'} ${r.defaultOnTimeout}. Stop scope: ${r.stopScope}.` +
        `${r.maxAttempts !== undefined ? ` Max self-attempts: ${r.maxAttempts}.` : ''}`,
    ),
    'Non-blockers (decide yourself): naming, file layout, code style, test approach, libraries already in the repo, UI details not in the demo script, creating follow-up tickets.',
  ].join('\n');
