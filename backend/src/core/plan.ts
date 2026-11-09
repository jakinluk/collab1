import type { TicketInput } from '../shared/schemas';
import type { Repo, Ticket } from '../shared/types';
import { TICKET_ID_RE } from '../shared/schemas';
import { pathSetsOverlap } from './paths';
import { lanesFromMap, protectedPathErrors } from './repos';

export interface PlannedTicket {
  id: string;
  isNew: boolean;
  input: TicketInput;
  deps: string[];
}

export interface PlanResult {
  errors: string[];
  tickets: PlannedTicket[];
}

const findCycle = (graph: Map<string, string[]>): string[] | undefined => {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    const s = state.get(node);
    if (s === 'done') return undefined;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = visit(next);
      if (c) return c;
    }
    stack.pop();
    state.set(node, 'done');
    return undefined;
  };
  for (const node of graph.keys()) {
    const c = visit(node);
    if (c) return c;
  }
  return undefined;
};

const dependsOn = (a: string, b: string, graph: Map<string, string[]>): boolean => {
  const seen = new Set<string>();
  const todo = [...(graph.get(a) ?? [])];
  while (todo.length) {
    const n = todo.pop() as string;
    if (n === b) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    todo.push(...(graph.get(n) ?? []));
  }
  return false;
};

export const validatePlan = (
  inputs: readonly TicketInput[],
  existing: readonly Ticket[],
  repos: readonly Repo[],
  allocateId: () => string,
): PlanResult => {
  const errors: string[] = [];
  const existingIds = new Set(existing.map((t) => t.id));
  const keyToId = new Map<string, string>();
  const planned: PlannedTicket[] = [];

  for (const [i, input] of inputs.entries()) {
    const label = input.id ?? `#${i + 1}`;
    let id: string;
    let isNew = true;
    if (input.id && TICKET_ID_RE.test(input.id) && existingIds.has(input.id)) {
      id = input.id;
      isNew = false;
    } else {
      id = allocateId();
    }
    if (input.id) {
      if (keyToId.has(input.id)) errors.push(`duplicate ticket key ${input.id}`);
      keyToId.set(input.id, id);
    }
    const repo = repos.find((r) => r.name === input.repo);
    let filled = input;
    if (!repo) errors.push(`${label}: unknown repo "${input.repo}" (project repos: ${repos.map((r) => r.name).join(', ')})`);
    else {
      errors.push(...protectedPathErrors(label, input.type, input.pathsOwned, repo));
      if (input.lanes.length === 0) {
        const lanes = lanesFromMap(input.pathsOwned, repo);
        if (lanes.length) filled = { ...input, lanes };
      }
    }
    if (input.acceptance.length === 0) errors.push(`${label}: needs at least one acceptance item`);
    planned.push({ id, isNew, input: filled, deps: [] });
  }

  const allIds = new Set([...existingIds, ...planned.map((p) => p.id)]);
  for (const p of planned) {
    p.deps = p.input.deps.map((d) => keyToId.get(d) ?? d);
    for (const d of p.deps) if (!allIds.has(d)) errors.push(`${p.input.id ?? p.id}: unknown dependency ${d}`);
    if (p.deps.includes(p.id)) errors.push(`${p.input.id ?? p.id}: depends on itself`);
  }

  const graph = new Map<string, string[]>();
  for (const t of existing) graph.set(t.id, [...t.deps]);
  for (const p of planned) graph.set(p.id, p.deps);
  const cycle = findCycle(graph);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' → ')}`);

  if (!cycle) {
    for (let i = 0; i < planned.length; i++) {
      for (let j = i + 1; j < planned.length; j++) {
        const a = planned[i];
        const b = planned[j];
        if (a.input.repo !== b.input.repo) continue;
        if (a.input.wave === undefined || a.input.wave !== b.input.wave) continue;
        if (!pathSetsOverlap(a.input.pathsOwned, b.input.pathsOwned)) continue;
        if (dependsOn(a.id, b.id, graph) || dependsOn(b.id, a.id, graph)) continue;
        errors.push(
          `${a.input.id ?? a.id} and ${b.input.id ?? b.id} are in wave ${a.input.wave} with overlapping pathsOwned and no dependency between them`,
        );
      }
    }
  }

  return { errors, tickets: planned };
};
