export type TicketStatus = 'planned' | 'ready' | 'booked' | 'in_progress' | 'review' | 'done' | 'blocked' | 'dropped';
export type TicketType = 'contract' | 'slice' | 'glue' | 'test' | 'review' | 'spike' | 'chore' | 'rework' | 'replan';
export type HubMode = 'event' | 'ongoing';
export type WorkMode = 'solo' | 'subagents' | 'multi_session' | 'factory';
export type Resolver = 'self' | 'any_agent' | 'owner' | 'agent_quorum' | 'any_human' | 'human_quorum' | 'human_named';
export type ActorKind = 'agent' | 'human';
export type QuorumRule = 'majority' | 'two_thirds' | 'unanimous' | 'consent';
export type Electorate = 'all_seats' | 'humans' | 'affected_seats' | 'agents';
export type Plan = 'pro' | 'max' | 'ultra';

export interface RepoVerify {
  name: string;
  cmd: string;
}

export interface LaneHint {
  glob: string;
  lane: string;
}

export interface Repo {
  name: string;
  url: string;
  baseBranch: string;
  integrationBranch: string;
  hotPaths: string[];
  contractPaths: string[];
  setup: string[];
  verify: RepoVerify[];
  instructionsPath?: string;
  laneMap: LaneHint[];
  prLabels: string[];
  notes?: string;
  /** Copied from the hub's repo catalog; catalog changes are pushed to it. */
  fromCatalog?: boolean;
}

export interface ProjectLink {
  label: string;
  url: string;
}

export interface ProjectDemo {
  url?: string;
  stage?: string;
  notes?: string;
}

export type EpicState = 'proposed' | 'planned' | 'in_progress' | 'release' | 'done' | 'paused' | 'archived';

export interface Milestone {
  id: string;
  name: string;
  targetDate?: string;
  done?: boolean;
}

/** Ongoing-mode fields of a project, which the board shows as an epic. */
export interface EpicInfo {
  state: EpicState;
  startDate?: string;
  targetDate?: string;
  milestones: Milestone[];
  owners: string[];
  priority: number;
  decisionMode: 'owners' | 'open';
  pausedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  repos: Repo[];
  lanes: string[];
  status: 'active' | 'frozen' | 'demo' | 'archived';
  phase: 'plan' | 'build' | 'freeze' | 'demo';
  goalVersion: number;
  createdBy: string;
  createdAt: number;
  description?: string;
  demo?: ProjectDemo;
  links: ProjectLink[];
  tags: string[];
  epic?: EpicInfo;
}

export interface DodItem {
  id: string;
  text: string;
}

export interface Goal {
  projectId: string;
  version: number;
  statement: string;
  definitionOfDone: string[];
  demoScript: string;
  nonGoals: string[];
  /** Definition of done with stable ids, so tickets can cite an item after the list changes. */
  dod?: DodItem[];
  /** Inputs and decisions this scope rests on. */
  refs?: string[];
  /** The change request that produced this version. */
  changeId?: string;
  contact?: string;
  createdBy: string;
  createdAt: number;
}

export interface Acceptance {
  cmd?: string;
  criterion: string;
}

export interface Booking {
  seatId: string;
  workerId?: string;
  sessionId?: string;
  leaseExpiresAt: number;
}

export interface ReviewLease {
  seatId: string;
  workerId?: string;
  leaseExpiresAt: number;
}

export interface LogEntry {
  ts: number;
  who: string;
  kind: ActorKind;
  text: string;
}

export interface Ticket {
  id: string;
  projectId: string;
  repo: string;
  title: string;
  description: string;
  type: TicketType;
  lanes: string[];
  deps: string[];
  pathsOwned: string[];
  pathsRead?: string[];
  acceptance: Acceptance[];
  priority: number;
  wave?: number;
  status: TicketStatus;
  booking?: Booking;
  review?: ReviewLease;
  branch?: string;
  prUrl?: string;
  attempts: number;
  createdBy: string;
  createdByAgent: boolean;
  dodRefs?: number[];
  /** Stable references: dod:d1, input:I1#anchor, input:I1, decision:R1. */
  refs?: string[];
  /** Scope version of the epic this ticket was planned or last confirmed on. */
  scopeVersion?: number;
  milestone?: string;
  /** Open change requests that may change this ticket; while set, nobody can book or merge it. */
  suspectBy?: string[];
  deferred?: boolean;
  supersedes?: string[];
  supersededBy?: string[];
  reworks?: string[];
  dropReason?: string;
  mergeSha?: string;
  /** Files the merged PR changed, reported at merge. */
  files?: string[];
  /** A re-plan ticket the hub created for this change request; it is done when the assessment is in. */
  forChange?: string;
  log: LogEntry[];
  updatedAt: number;
  version: number;
}

export interface SessionInfo {
  sessionId: string;
  state: 'working' | 'idle' | 'needs_input' | 'ended';
  ticketId?: string;
  lastTool?: string;
  at: number;
}

export interface Usage {
  fiveHourPct?: number;
  sevenDayPct?: number;
  at: number;
}

export interface Seat {
  id: string;
  name: string;
  machine?: string;
  lanes: string[];
  projects: string[];
  pinned: boolean;
  plan: Plan;
  workMode: WorkMode;
  maxConcurrentBookings?: number;
  autopilot: boolean;
  lastSeen?: number;
  usage?: Usage;
  cognitoSub?: string;
  sessions?: SessionInfo[];
}

export interface BlockerRule {
  code: string;
  name: string;
  trigger: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  resolver: Resolver;
  resolverNote?: string;
  quorumRule?: QuorumRule;
  timeoutMin?: number;
  contestMin?: number;
  defaultOnTimeout: string;
  stopScope: 'none' | 'ticket' | 'dependents' | 'all';
  maxAttempts?: number;
  notify: 'affected' | 'all' | 'humans';
  version: number;
}

export type EscalationKind = 'blocker' | 'issue' | 'urgent' | 'help';
export type EscalationStatus = 'open' | 'resolved_pending_contest' | 'resolved' | 'contested' | 'defaulted';

export interface Escalation {
  id: string;
  kind: EscalationKind;
  projectId: string;
  ticketId?: string;
  ruleCode: string;
  ruleVersion: number;
  summary: string;
  detail: string;
  proposed?: string[];
  status: EscalationStatus;
  raisedBy: string;
  raisedByKind: ActorKind;
  resolution?: { text: string; by: string; at: number; contestUntil?: number };
  decisionId?: string;
  deadline?: number;
  parksTicket?: boolean;
  createdAt: number;
}

export interface Vote {
  seat: string;
  option: string;
  by: ActorKind;
  why: string;
  ts: number;
}

export interface Decision {
  id: string;
  projectId?: string;
  escalationId?: string;
  question: string;
  options: string[];
  context: string;
  electorate: Electorate;
  eligible: string[];
  rule: QuorumRule;
  quorum: number;
  deadline: number;
  defaultOption: string;
  votes: Vote[];
  status: 'open' | 'made' | 'defaulted';
  outcome?: string;
}

export type KnowledgeScope = 'global' | { projectId: string };

export interface KnowledgeItem {
  id: string;
  kind: 'tip' | 'playbook' | 'skill';
  name: string;
  version: number;
  author: string;
  tags: string[];
  scope: KnowledgeScope;
  body?: string;
  s3Key?: string;
  status: 'active' | 'retired';
  createdAt: number;
}

export type HumanAction =
  | 'project.create'
  | 'project.update'
  | 'project.status'
  | 'project.phase'
  | 'goal.set'
  | 'plan.load'
  | 'rules.set'
  | 'rules.override'
  | 'escalation.resolve'
  | 'escalation.contest'
  | 'settings.set'
  | 'token.worker'
  | 'release.publish'
  | 'epic.update'
  | 'repo.set'
  | 'repo.remove'
  | 'input.approve'
  | 'decision.record'
  | 'change.approve'
  | 'change.reject'
  | 'retention.apply';

export interface Proposal {
  id: string;
  action: HumanAction;
  payload: unknown;
  summary: string;
  proposedBy: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedBy?: string;
  createdAt: number;
  expiresAt: number;
  result?: unknown;
}

export type Stream = 'tasks' | 'knowledge' | 'escalations' | 'decisions' | 'broadcast' | 'presence' | 'dm';

export interface Envelope {
  seq: number;
  ts: number;
  stream: Stream;
  type: string;
  projectId?: string;
  from: string;
  fromKind: 'agent' | 'human' | 'system';
  ticketId?: string;
  to?: string;
  summary: string;
  data?: Record<string, unknown>;
}

export type EnvelopeInput = Omit<Envelope, 'seq' | 'ts'>;

export interface Settings {
  leaseTtlSec: number;
  /** Prefix of ticket branches; defaults to hack/ in event mode and c1/ in ongoing mode. */
  branchPrefix?: string;
  /** Actions an agent may take without a human; unset means the mode's default. */
  agentActions?: HumanAction[];
  maxBookingsPerSeat?: number;
  defaultContestMin: number;
  rulesVersion: number;
  /** Git URL of the CollabOne repo itself; the fix queue project points at it. */
  toolRepoUrl?: string;
}

/** The latest published CollabOne plugin version, announced to every connected Mac. */
export interface Release {
  latest: string;
  /** Clients below this version may only read until they update. */
  minimum?: string;
  notes: string;
  publishedAt: number;
  by: string;
}

export type InputKind = 'prd' | 'feedback' | 'research' | 'note';

export interface InputSection {
  anchor: string;
  title: string;
  level: number;
  hash: string;
}

export interface Input {
  id: string;
  kind: InputKind;
  title: string;
  owner: string;
  projectIds: string[];
  status: 'draft' | 'approved' | 'archived';
  latestVersion: number;
  approvedVersion?: number;
  createdAt: number;
  updatedAt: number;
}

export interface InputVersion {
  inputId: string;
  version: number;
  body: string;
  sections: InputSection[];
  status: 'draft' | 'approved' | 'superseded';
  note?: string;
  createdBy: string;
  createdAt: number;
  approvedBy?: string;
  approvedAt?: number;
}

/** What was decided and why. Votes are a separate record (Decision, shown as a vote). */
export interface DecisionRecord {
  id: string;
  projectId?: string;
  title: string;
  choice: string;
  reason: string;
  by: string;
  at: number;
  status: 'accepted' | 'superseded';
  supersedes?: string;
  supersededBy?: string;
  refs: string[];
  /** Repo and paths of a shared contract this decision changes; other epics using them get a change request. */
  repo?: string;
  contractPaths?: string[];
  source: 'manual' | 'escalation' | 'vote' | 'change' | 'dates';
  sourceId?: string;
}

export type ChangeStatus = 'assessing' | 'proposed' | 'approved' | 'rejected' | 'applying' | 'applied';
export type Verdict = 'keep' | 'amend' | 'supersede' | 'obsolete' | 'defer' | 'rework' | 'revert';

export interface TicketAmend {
  title?: string;
  description?: string;
  acceptance?: Acceptance[];
  refs?: string[];
  pathsOwned?: string[];
  pathsRead?: string[];
  milestone?: string;
  priority?: number;
}

export interface ImpactEntry {
  ticketId: string;
  title: string;
  statusAtOpen: TicketStatus;
  ticketVersion: number;
  why: string[];
  verdict?: Verdict;
  note?: string;
  amend?: TicketAmend;
  /** Done tickets with the same group get one rework ticket. */
  group?: string;
  acceptance?: Acceptance[];
  applied?: boolean;
}

export interface ChangeTicket {
  key: string;
  repo: string;
  title: string;
  description: string;
  type: TicketType;
  lanes: string[];
  deps: string[];
  pathsOwned: string[];
  pathsRead?: string[];
  acceptance: Acceptance[];
  priority: number;
  refs?: string[];
  milestone?: string;
  supersedes?: string[];
}

export interface ScopePatch {
  statement?: string;
  definitionOfDone?: (string | DodItem)[];
  nonGoals?: string[];
  refs?: string[];
}

export interface ChangeRequest {
  id: string;
  projectId: string;
  title: string;
  reason: string;
  trigger: { kind: 'input' | 'decision' | 'contract' | 'manual' | 'resume' | 'ingest'; ref?: string; detail?: string; fromVersion?: number; toVersion?: number };
  /** What picked the impacted tickets; a rebase runs it again. */
  query: { ticketIds?: string[]; milestone?: string; repo?: string; contractPaths?: string[] };
  changedRefs: string[];
  addedRefs: string[];
  baseScopeVersion: number;
  impact: ImpactEntry[];
  newTickets: ChangeTicket[];
  scope?: ScopePatch;
  status: ChangeStatus;
  createdBy: string;
  createdAt: number;
  assessedBy?: string;
  /** The assessor's summary of what the change means for the epic. */
  summary?: string;
  /** Why an agent may not approve this change on its own; empty means an agent may. */
  needsHuman?: string[];
  /** The ticket any participant's agent picks up to assess this change. */
  replanTicket?: string;
  decidedBy?: string;
  decidedByKind?: 'agent' | 'human';
  /** An agent's approval applies after this time unless a human rejects it first. */
  contestUntil?: number;
  decidedAt?: number;
  decisionId?: string;
  appliedScopeVersion?: number;
  created?: Record<string, string>;
  counts?: Record<string, number>;
}

export interface Actor {
  seatId: string;
  kind: ActorKind;
  workerId?: string;
}

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'not_ready'
  | 'path_conflict'
  | 'update_required'
  | 'rate_limited'
  | 'stale';
