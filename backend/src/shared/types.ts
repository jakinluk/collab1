export type TicketStatus = 'planned' | 'ready' | 'booked' | 'in_progress' | 'review' | 'done' | 'blocked' | 'dropped';
export type TicketType = 'contract' | 'slice' | 'glue' | 'test' | 'review' | 'spike' | 'chore';
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
}

export interface Goal {
  projectId: string;
  version: number;
  statement: string;
  definitionOfDone: string[];
  demoScript: string;
  nonGoals: string[];
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
  | 'release.publish';

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
  maxBookingsPerSeat?: number;
  defaultContestMin: number;
  rulesVersion: number;
  /** Git URL of the HackathonOne repo itself; the fix queue project points at it. */
  toolRepoUrl?: string;
}

/** The latest published HackathonOne plugin version, announced to every connected Mac. */
export interface Release {
  latest: string;
  /** Clients below this version may only read until they update. */
  minimum?: string;
  notes: string;
  publishedAt: number;
  by: string;
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
  | 'rate_limited';
