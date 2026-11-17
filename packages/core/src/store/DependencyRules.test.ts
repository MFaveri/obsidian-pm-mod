import { describe, expect, it } from 'vitest'
import { makeTask, type StatusConfig } from '../types'
import {
  assertCanMaintainDependencies,
  assertCanTransitionTaskStatus,
  canTransitionTaskStatus,
  getUnresolvedDependencies,
  type DependencyNode,
  getDependencyCandidates,
  getReplacementCandidates,
  wouldCreateReplacementCycle
} from './DependencyRules'

const STATUSES: StatusConfig[] = [
  { id: 'todo', label: 'To Do', color: '', icon: '', complete: false },
  { id: 'blocked', label: 'Blocked', color: '', icon: '', complete: false },
  { id: 'doing', label: 'Doing', color: '', icon: '', complete: false },
  { id: 'done', label: 'Done', color: '', icon: '', complete: true },
  { id: 'cancelled', label: 'Cancelled', color: '', icon: '', complete: true },
  { id: 'superseded', label: 'Replaced', color: '', icon: '', complete: true }
]

function node(id: string, overrides: Partial<DependencyNode> = {}): DependencyNode {
  return {
    id,
    title: id,
    status: 'todo',
    dependencies: [],
    terminal: false,
    ...overrides
  }
}

describe('dependency rules', () => {
  it('reports every open or missing dependency while accepting terminal dependencies', () => {
    const done = node('done', { title: 'Approved', status: 'done', terminal: true })
    const cancelled = node('cancelled', { title: 'Dropped', status: 'cancelled', terminal: true })
    const open = node('open', { title: 'Buy material' })
    const target = node('target', { dependencies: ['done', 'cancelled', 'open', 'missing'] })
    const nodes = new Map([done, cancelled, open, target].map((task) => [task.id, task]))

    expect(getUnresolvedDependencies(target, nodes)).toEqual([
      { id: 'open', title: 'Buy material', missing: false },
      { id: 'missing', title: 'Missing task (missing)', missing: true }
    ])
  })

  it('blocks active transitions but permits planning statuses and terminal dependencies', () => {
    const blocker = node('blocker')
    const target = node('target', { dependencies: [blocker.id] })
    const nodes = new Map([blocker, target].map((task) => [task.id, task]))

    expect(canTransitionTaskStatus(target, 'todo', nodes, STATUSES)).toBe(true)
    expect(canTransitionTaskStatus(target, 'blocked', nodes, STATUSES)).toBe(true)
    expect(canTransitionTaskStatus(target, 'doing', nodes, STATUSES)).toBe(false)

    blocker.terminal = true
    expect(canTransitionTaskStatus(target, 'doing', nodes, STATUSES)).toBe(true)
  })

  it('follows replacement chains instead of releasing stale references', () => {
    const old = node('old', { status: 'superseded', replacedBy: 'current', terminal: true })
    const current = node('current', { title: 'Current plan' })
    const target = node('target', { dependencies: [old.id] })
    const nodes = new Map([old, current, target].map((task) => [task.id, task]))

    expect(getUnresolvedDependencies(target, nodes)).toEqual([{ id: 'current', title: 'Current plan', missing: false }])
    current.terminal = true
    expect(getUnresolvedDependencies(target, nodes)).toEqual([])
  })

  it('rejects a replacement that would close a dependency cycle', () => {
    const source = node('source')
    const downstream = node('downstream', { dependencies: [source.id] })
    expect(wouldCreateReplacementCycle([source, downstream], source.id, 'replacement', [downstream.id])).toBe(true)
  })

  it('offers only active, non-archived dependency candidates', () => {
    const historicalChild = makeTask({ id: 'historical-child', title: 'Old child' })
    const replaced = makeTask({ id: 'replaced', status: 'superseded', subtasks: [historicalChild] })
    const active = makeTask({ id: 'active', title: 'Current task' })
    const archived = makeTask({ id: 'archived', title: 'Archived task', archived: true })
    const target = makeTask({ id: 'target' })

    expect(getDependencyCandidates([replaced, active, archived, target], target.id).map((task) => task.id)).toEqual([
      'active'
    ])
  })

  it('does not offer a replacement tail when the old dependency is already selected', () => {
    const old = makeTask({ id: 'old', status: 'superseded', replacedBy: 'current' })
    const current = makeTask({ id: 'current' })
    const other = makeTask({ id: 'other' })
    const target = makeTask({ id: 'target', dependencies: [old.id] })

    expect(getDependencyCandidates([old, current, other, target], target.id).map((task) => task.id)).toEqual(['other'])
  })

  it('excludes terminal and historical candidates from replacement choices', () => {
    const source = makeTask({ id: 'source' })
    const active = makeTask({ id: 'active' })
    const done = makeTask({ id: 'done', status: 'done' })
    const old = makeTask({ id: 'old', status: 'superseded', replacedBy: 'active' })
    const candidateTasks = [source, active, done, old]

    expect(getReplacementCandidates(source, candidateTasks, STATUSES).map((task) => task.id)).toEqual(['active'])
  })

  it('throws a useful error when a transition is blocked', () => {
    const blocker = node('blocker', { title: 'Required approval' })
    const target = node('target', { dependencies: [blocker.id] })
    const nodes = new Map([blocker, target].map((task) => [task.id, task]))

    expect(() => assertCanTransitionTaskStatus(target, 'doing', nodes, STATUSES)).toThrow('Required approval')
  })

  it('allows cancelling a blocked task without treating active statuses placed first as planning', () => {
    const blocker = node('blocker')
    const target = node('target', { dependencies: [blocker.id] })
    const nodes = new Map([blocker, target].map((task) => [task.id, task]))
    const reordered: StatusConfig[] = [
      { id: 'in-progress', label: 'In Progress', color: '', icon: '', complete: false },
      { id: 'todo', label: 'To Do', color: '', icon: '', complete: false },
      { id: 'cancelled', label: 'Cancelled', color: '', icon: '', complete: true }
    ]

    expect(canTransitionTaskStatus(target, 'cancelled', nodes, reordered)).toBe(true)
    expect(canTransitionTaskStatus(target, 'in-progress', nodes, reordered)).toBe(false)
  })

  it('blocks adding an unresolved dependency to an already active task', () => {
    const blocker = node('blocker', { title: 'Open prereq' })
    const done = node('done', { status: 'done', terminal: true })
    const active = node('active', { status: 'doing', dependencies: [blocker.id] })
    const nodes = new Map([blocker, done, active].map((task) => [task.id, task]))

    expect(() => assertCanMaintainDependencies(active, [blocker.id], nodes, STATUSES)).toThrow('Open prereq')
    expect(() => assertCanMaintainDependencies(active, [done.id], nodes, STATUSES)).not.toThrow()
  })

  it('excludes ancestors of the source task from replacement candidates', () => {
    const child = makeTask({ id: 'child' })
    const parent = makeTask({ id: 'parent', subtasks: [child] })
    const sibling = makeTask({ id: 'sibling' })

    expect(getReplacementCandidates(child, [parent, child, sibling], STATUSES).map((task) => task.id)).toEqual([
      'sibling'
    ])
  })
})
