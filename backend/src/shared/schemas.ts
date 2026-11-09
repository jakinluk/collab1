import { z } from 'zod';

export const ID_RE = /^[a-z0-9-]{2,40}$/;
export const TICKET_ID_RE = /^T\d+$/;

const id = z.string().regex(ID_RE, 'must match [a-z0-9-]{2,40}');
const text = (max: number) => z.string().trim().min(1).max(max);
const lanes = z.array(z.string().trim().min(1).max(40)).max(20);

export const ticketStatusSchema = z.enum(['planned', 'ready', 'booked', 'in_progress', 'review', 'done', 'blocked', 'dropped']);
export const ticketTypeSchema = z.enum(['contract', 'slice', 'glue', 'test', 'review', 'spike', 'chore']);
export const workModeSchema = z.enum(['solo', 'subagents', 'multi_session', 'factory']);
export const resolverSchema = z.enum(['self', 'any_agent', 'owner', 'agent_quorum', 'any_human', 'human_quorum', 'human_named']);
export const quorumRuleSchema = z.enum(['majority', 'two_thirds', 'unanimous', 'consent']);

const glob = z.string().trim().min(1).max(200);
const command = z.string().trim().min(1).max(500);
const branch = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._\/-]+$/, 'invalid branch name');
export const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => u.startsWith('https://'), 'must be an https:// URL');

export const repoSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/),
  url: z.string().trim().min(1).max(300),
  baseBranch: branch.default('main'),
  integrationBranch: branch.optional(),
  hotPaths: z.array(glob).max(50).default([]),
  contractPaths: z.array(glob).max(50).default([]),
  setup: z.array(command).max(10).default([]),
  verify: z.array(z.object({ name: z.string().trim().min(1).max(40), cmd: command })).max(10).default([]),
  instructionsPath: z.string().trim().min(1).max(200).optional(),
  laneMap: z.array(z.object({ glob, lane: z.string().trim().min(1).max(40) })).max(30).default([]),
  prLabels: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  notes: z.string().max(2000).optional(),
});
export type RepoInput = z.infer<typeof repoSchema>;

export const reposSchema = z
  .array(repoSchema)
  .min(1)
  .max(10)
  .superRefine((repos, ctx) => {
    const seen = new Set<string>();
    for (const [i, r] of repos.entries()) {
      if (seen.has(r.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'name'], message: `duplicate repo name ${r.name}` });
      seen.add(r.name);
    }
  });

export const projectDemoSchema = z.object({
  url: httpsUrl.optional(),
  stage: z.string().trim().max(80).optional(),
  notes: z.string().max(2000).optional(),
});
export const projectLinkSchema = z.object({ label: z.string().trim().min(1).max(80), url: httpsUrl });
const projectMeta = {
  description: z.string().max(2000).optional(),
  demo: projectDemoSchema.optional(),
  links: z.array(projectLinkSchema).max(20),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
};

export const acceptanceSchema = z.object({
  cmd: z.string().max(500).optional(),
  criterion: text(500),
});

export const ticketInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/),
  title: text(200),
  description: z.string().max(8000).default(''),
  type: ticketTypeSchema.default('slice'),
  lanes: lanes.default([]),
  deps: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)).max(50).default([]),
  pathsOwned: z.array(z.string().min(1).max(300)).min(1).max(50),
  pathsRead: z.array(z.string().min(1).max(300)).max(50).optional(),
  acceptance: z.array(acceptanceSchema).min(1).max(20),
  priority: z.number().int().min(0).max(1000).default(100),
  wave: z.number().int().min(0).max(100).optional(),
  dodRefs: z.array(z.number().int().min(0).max(100)).max(20).optional(),
  status: z.enum(['ready', 'planned']).optional(),
});
export type TicketInput = z.infer<typeof ticketInputSchema>;

export const joinSchema = z.object({
  code: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
  machine: z.string().max(120).default('unknown'),
  sessionLabel: z.string().max(120).optional(),
});

export const patchMeSchema = z.object({
  lanes: lanes.optional(),
  workMode: workModeSchema.optional(),
  maxConcurrentBookings: z.number().int().min(1).max(50).nullable().optional(),
  autopilot: z.boolean().optional(),
  usage: z
    .object({
      fiveHourPct: z.number().min(0).max(100).optional(),
      sevenDayPct: z.number().min(0).max(100).optional(),
    })
    .optional(),
  machine: z.string().max(120).optional(),
  pinProject: id.optional(),
});

export const sessionSchema = z.object({
  sessionId: z.string().min(1).max(120),
  state: z.enum(['working', 'idle', 'needs_input', 'ended']),
  ticketId: z.string().regex(TICKET_ID_RE).optional(),
  lastTool: z.string().max(80).optional(),
});

export const seatCreateSchema = z.object({
  id,
  name: text(80),
  plan: z.enum(['pro', 'max', 'ultra']).default('ultra'),
  lanes: lanes.default([]),
});

export const nextSchema = z.object({
  projectId: id.optional(),
  lanes: lanes.optional(),
  n: z.number().int().min(1).max(5).default(1),
  workerId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  sessionId: z.string().max(120).optional(),
});

export const bookSchema = z.object({
  workerId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  sessionId: z.string().max(120).optional(),
});

export const heartbeatSchema = z.object({ sessionId: z.string().max(120).optional() });

export const statusSchema = z.object({
  status: z.enum(['in_progress', 'review', 'blocked']),
  note: z.string().max(2000).optional(),
  prUrl: z.string().url().max(500).optional(),
});

export const releaseSchema = z.object({
  reason: text(1000),
  failed: z.boolean().default(false),
});

export const reviewBookSchema = z.object({
  workerId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
});

export const reviewDoneSchema = z.object({
  outcome: z.enum(['merged', 'changes_requested']),
  note: z.string().max(2000).optional(),
  prUrl: z.string().url().max(500).optional(),
});

export const escalationCreateSchema = z.object({
  kind: z.enum(['blocker', 'issue', 'urgent', 'help']),
  projectId: id,
  ticketId: z.string().regex(TICKET_ID_RE).optional(),
  ruleCode: z.string().regex(/^[A-Z][A-Z0-9]{0,5}$/),
  summary: text(200),
  detail: z.string().max(8000).default(''),
  proposed: z.array(text(300)).max(6).optional(),
});

export const answerSchema = z.object({ text: text(4000) });
export const resolveSchema = z.object({ resolution: text(2000), reason: z.string().max(2000).default('') });
export const contestSchema = z.object({ reason: text(2000) });

export const voteSchema = z.object({ option: text(300), why: z.string().max(1000).default('') });

const scopeSchema = z.union([z.literal('global'), z.object({ projectId: id })]).default('global');

export const knowledgeCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tip'),
    name: text(120),
    tags: z.array(z.string().max(40)).max(20).default([]),
    scope: scopeSchema,
    body: text(4000),
  }),
  z.object({
    kind: z.literal('playbook'),
    name: text(120),
    tags: z.array(z.string().max(40)).max(20).default([]),
    scope: scopeSchema,
    body: text(60000),
  }),
  z.object({
    kind: z.literal('skill'),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
    tags: z.array(z.string().max(40)).max(20).default([]),
    scope: scopeSchema,
    s3Key: z.string().min(1).max(300),
  }),
]);

export const skillUploadSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/) });

export const semver = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'use a version like 0.3.1');

export const toolAreaSchema = z.enum(['plugin', 'board', 'backend', 'docs']);

export const toolBugSchema = z.object({
  summary: text(160),
  detail: z.string().max(4000).default(''),
  area: toolAreaSchema.default('plugin'),
  urgent: z.boolean().default(false),
  ticketId: z.string().regex(/^T\d+$/).optional(),
});

export const messageSchema = z.object({
  to: z.union([z.literal('all'), id]),
  projectId: id.optional(),
  text: text(2000),
});

export const humanActionSchema = z.enum([
  'project.create',
  'project.update',
  'project.status',
  'project.phase',
  'goal.set',
  'plan.load',
  'rules.set',
  'rules.override',
  'escalation.resolve',
  'escalation.contest',
  'settings.set',
  'token.worker',
  'release.publish',
]);

export const proposalSchema = z.object({
  action: humanActionSchema,
  payload: z.unknown(),
  summary: z.string().max(300).default(''),
});

export const actionSchema = z.object({ action: humanActionSchema, payload: z.unknown() });

const rulePatchSchema = z
  .object({
    name: text(80),
    trigger: text(1000),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    resolver: resolverSchema,
    resolverNote: z.string().max(300),
    quorumRule: quorumRuleSchema,
    timeoutMin: z.number().int().min(1).max(1440).nullable(),
    contestMin: z.number().int().min(1).max(240).nullable(),
    defaultOnTimeout: text(500),
    stopScope: z.enum(['none', 'ticket', 'dependents', 'all']),
    maxAttempts: z.number().int().min(0).max(20).nullable(),
    notify: z.enum(['affected', 'all', 'humans']),
  })
  .partial();

export const actionPayloadSchemas = {
  'project.create': z.object({
    id: id.optional(),
    name: text(80),
    repos: reposSchema,
    lanes: lanes.default([]),
    description: projectMeta.description,
    demo: projectMeta.demo,
    links: projectMeta.links.default([]),
    tags: projectMeta.tags.default([]),
  }),
  'project.update': z.object({
    projectId: id,
    name: text(80).optional(),
    repos: reposSchema.optional(),
    lanes: lanes.optional(),
    description: projectMeta.description,
    demo: projectMeta.demo,
    links: projectMeta.links.optional(),
    tags: projectMeta.tags.optional(),
  }),
  'project.status': z.object({ projectId: id, status: z.enum(['active', 'frozen', 'demo', 'archived']) }),
  'project.phase': z.object({ projectId: id, phase: z.enum(['plan', 'build', 'freeze', 'demo']) }),
  'goal.set': z.object({
    projectId: id,
    statement: text(1000),
    definitionOfDone: z.array(text(500)).min(1).max(30),
    demoScript: z.string().max(8000).default(''),
    nonGoals: z.array(text(500)).max(30).default([]),
    contact: z.string().max(40).optional(),
  }),
  'plan.load': z.object({ projectId: id, tickets: z.array(ticketInputSchema).min(1).max(200) }),
  'rules.set': z.object({ code: z.string().regex(/^[A-Z][A-Z0-9]{0,5}$/), patch: rulePatchSchema }),
  'rules.override': z.object({ projectId: id, code: z.string().regex(/^[A-Z][A-Z0-9]{0,5}$/), patch: rulePatchSchema }),
  'escalation.resolve': z.object({ escalationId: z.string().regex(/^E\d+$/), resolution: text(2000), reason: z.string().max(2000).default('') }),
  'escalation.contest': z.object({ escalationId: z.string().regex(/^E\d+$/), reason: text(2000) }),
  'settings.set': z.object({
    leaseTtlSec: z.number().int().min(60).max(7200).optional(),
    maxBookingsPerSeat: z.number().int().min(1).max(50).nullable().optional(),
    defaultContestMin: z.number().int().min(1).max(240).optional(),
    toolRepoUrl: z.string().trim().min(1).max(300).nullable().optional(),
  }),
  'token.worker': z.object({ workerId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }),
  'release.publish': z.object({ version: semver, notes: text(500), minimum: semver.optional() }),
} as const;

export type ActionPayloads = { [K in keyof typeof actionPayloadSchemas]: z.infer<(typeof actionPayloadSchemas)[K]> };
