import type { StatusConfig, Task } from '../types'
import { isTerminalStatus } from '../utils'

export interface DependencyNode {
  id: string
  title: string
  status: string
  dependencies: string[]
  terminal: boolean
  archived?: boolean
  replacedBy?: string
  replaces?: string
}

export interface UnresolvedDependency {
  id: string
  title: string
  missing: boolean
}

export class DependencyBlockedError extends Error {
  constructor(public readonly unresolved: UnresolvedDependency[]) {
    super(`Unresolved dependencies: ${unresolved.map((dependency) => dependency.title).join('; ')}`)
    this.name = 'DependencyBlockedError'
  }
}

export class ReplacementRequiredError extends Error {
  constructor() {
    super('Use Replace task to set the Replaced status and choose its replacement.')
    this.name = 'ReplacementRequiredError'
  }
}

const ACTIVE_STATUS_IDS = new Set(['in-progress', 'doing', 'review'])

function isPlanningStatus(status: string, statuses: StatusConfig[]): boolean {
  if (status === 'todo' || status === 'blocked' || status === 'cancelled') return true
  const first = statuses[0]
  return !!first && status === first.id && !first.complete && !ACTIVE_STATUS_IDS.has(first.id)
}

export function canTransitionTaskStatus(
  task: DependencyNode,
  targetStatus: string,
  nodes: Map<string, DependencyNode>,
  statuses: StatusConfig[],
  dependencyTask: DependencyNode = task
): boolean {
  if (targetStatus === task.status) return true
  if (targetStatus === 'superseded') return false
  if (isPlanningStatus(targetStatus, statuses)) return true
  return getUnresolvedDependencies(dependencyTask, nodes).length === 0
}

export function assertCanTransitionTaskStatus(
  task: DependencyNode,
  targetStatus: string,
  nodes: Map<string, DependencyNode>,
  statuses: StatusConfig[],
  dependencyTask: DependencyNode = task
): void {
  if (targetStatus === 'superseded' && targetStatus !== task.status) throw new ReplacementRequiredError()
  if (canTransitionTaskStatus(task, targetStatus, nodes, statuses, dependencyTask)) return
  throw new DependencyBlockedError(getUnresolvedDependencies(dependencyTask, nodes))
}

export function assertCanMaintainDependencies(
  task: DependencyNode,
  addedDependencyIds: string[],
  nodes: Map<string, DependencyNode>,
  statuses: StatusConfig[]
): void {
  if (addedDependencyIds.length === 0 || task.status === 'superseded') return
  if (isPlanningStatus(task.status, statuses)) return
  const unresolved = getUnresolvedDependencies({ ...task, dependencies: addedDependencyIds }, nodes)
  if (unresolved.length === 0) return
  throw new DependencyBlockedError(unresolved)
}

export function assertCanInsertTask(
  task: DependencyNode,
  nodes: Map<string, DependencyNode>,
  statuses: StatusConfig[]
): void {
  if (task.status === 'superseded') throw new ReplacementRequiredError()
  if (isPlanningStatus(task.status, statuses)) return
  const unresolved = getUnresolvedDependencies(task, nodes)
  if (unresolved.length === 0) return
  throw new DependencyBlockedError(unresolved)
}

export function wouldCreateReplacementCycle(
  tasks: DependencyNode[],
  sourceId: string,
  replacementId: string,
  replacementDependencies: string[]
): boolean {
  const dependencies = new Map<string, string[]>()
  for (const task of tasks) {
    dependencies.set(
      task.id,
      task.id === replacementId
        ? [...replacementDependencies]
        : task.dependencies.map((id) => (id === sourceId ? replacementId : id))
    )
  }
  dependencies.set(replacementId, [...replacementDependencies])

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const dependencyId of dependencies.get(id) ?? []) {
      if (visit(dependencyId)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const id of dependencies.keys()) {
    if (visit(id)) return true
  }
  return false
}

function hasDescendant(root: Task, targetId: string): boolean {
  return root.subtasks.some((sub) => sub.id === targetId || hasDescendant(sub, targetId))
}

export function getReplacementCandidates(source: Task, allTasks: Task[], statuses: StatusConfig[] = []): Task[] {
  const descendantIds = new Set<string>()
  const collectDescendants = (tasks: Task[]): void => {
    for (const task of tasks) {
      descendantIds.add(task.id)
      collectDescendants(task.subtasks)
    }
  }
  collectDescendants(source.subtasks)
  const prerequisites = new Set(source.dependencies)
  const terminal = (task: Task): boolean =>
    statuses.length
      ? isTerminalStatus(task.status, statuses)
      : ['done', 'cancelled', 'superseded'].includes(task.status)
  return allTasks.filter(
    (task) =>
      task.id !== source.id &&
      !descendantIds.has(task.id) &&
      !hasDescendant(task, source.id) &&
      !prerequisites.has(task.id) &&
      !terminal(task) &&
      !task.replacedBy &&
      !task.replaces &&
      !task.archived
  )
}

export function getDependencyCandidates(tasks: Task[], targetId: string, statuses: StatusConfig[] = []): Task[] {
  const candidates: Task[] = []
  const taskById = new Map<string, Task>()
  const index = (items: Task[]): void => {
    for (const task of items) {
      taskById.set(task.id, task)
      index(task.subtasks)
    }
  }
  index(tasks)

  const existingDependencyTails = new Set<string>()
  const target = taskById.get(targetId)
  if (target && target.dependencies.length > 0) {
    const nodes = new Map(
      [...taskById.values()].map((task) => [
        task.id,
        {
          id: task.id,
          title: task.title,
          status: task.status,
          dependencies: task.dependencies,
          terminal: statuses.length
            ? isTerminalStatus(task.status, statuses)
            : task.status === 'done' || task.status === 'cancelled' || task.status === 'superseded',
          archived: task.archived,
          replacedBy: task.replacedBy,
          replaces: task.replaces
        }
      ])
    )
    for (const dependencyId of new Set(target.dependencies)) {
      const dependencyNode = nodes.get(dependencyId)
      if (!dependencyNode) continue
      const resolved = resolveDependencyTail(dependencyNode, nodes)
      if (!resolved.missing && resolved.task) existingDependencyTails.add(resolved.task.id)
    }
  }

  const walk = (items: Task[], insideHistory: boolean): void => {
    for (const task of items) {
      const historical = insideHistory || task.status === 'superseded'
      if (!historical && !task.archived && task.id !== targetId && !existingDependencyTails.has(task.id)) {
        candidates.push(task)
      }
      walk(task.subtasks, historical)
    }
  }
  walk(tasks, false)
  return candidates
}

export function getUnresolvedDependencies(
  task: DependencyNode,
  nodes: Map<string, DependencyNode>
): UnresolvedDependency[] {
  const unresolved: UnresolvedDependency[] = []
  for (const id of new Set(task.dependencies)) {
    const dependency = nodes.get(id)
    if (!dependency) {
      unresolved.push({ id, title: `Missing task (${id})`, missing: true })
      continue
    }
    const resolved = resolveDependencyTail(dependency, nodes)
    if (resolved.missing) {
      unresolved.push({ id: resolved.id, title: resolved.title, missing: true })
    } else if (resolved.task && !resolved.task.terminal) {
      unresolved.push({ id: resolved.task.id, title: resolved.task.title, missing: false })
    }
  }
  return unresolved
}

export function resolveDependencyTail(
  dependency: DependencyNode,
  nodes: Map<string, DependencyNode>
): { task?: DependencyNode; id: string; title: string; missing: boolean } {
  const visited = new Set<string>()
  let current = dependency
  while (current.status === 'superseded') {
    if (visited.has(current.id)) {
      return { id: current.id, title: `Replacement cycle (${current.id})`, missing: true }
    }
    visited.add(current.id)
    if (!current.replacedBy) {
      return {
        id: current.id,
        title: `Replaced task has no successor (${current.title})`,
        missing: true
      }
    }
    const replacement = nodes.get(current.replacedBy)
    if (!replacement) {
      return {
        id: current.replacedBy,
        title: `Missing replacement (${current.replacedBy})`,
        missing: true
      }
    }
    current = replacement
  }
  return { task: current, id: current.id, title: current.title, missing: false }
}
