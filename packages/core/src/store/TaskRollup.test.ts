import { describe, expect, it } from 'vitest'
import type { StatusConfig, Task } from '../types'
import { computeTaskRollup } from './TaskRollup'

const STATUSES: StatusConfig[] = [
  { id: 'todo', label: 'To do', color: '#888', icon: 'circle', complete: false },
  { id: 'in-progress', label: 'In progress', color: '#09f', icon: 'circle-dot', complete: false },
  { id: 'done', label: 'Done', color: '#0c6', icon: 'check-circle', complete: true }
]

function makeTask(partial: Partial<Task>): Task {
  return {
    id: 't-1',
    title: 'Task',
    description: '',
    type: 'task',
    status: 'todo',
    priority: 'medium',
    start: '',
    due: '',
    progress: 0,
    completed: '',
    assignees: [],
    tags: [],
    subtasks: [],
    dependencies: [],
    customFields: {},
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...partial
  }
}

describe('computeTaskRollup', () => {
  it('returns undefined for a task without subtasks', () => {
    const task = makeTask({ id: 'solo' })
    expect(computeTaskRollup(task, STATUSES)).toBeUndefined()
  })

  it('aggregates start and due across dated subtasks', () => {
    const sub1 = makeTask({ id: 's1', start: '2026-02-10', due: '2026-02-15', progress: 50 })
    const sub2 = makeTask({ id: 's2', start: '2026-02-12', due: '2026-02-20', status: 'done', progress: 100 })
    const parent = makeTask({ id: 'parent', subtasks: [sub1, sub2] })

    const rollup = computeTaskRollup(parent, STATUSES)
    expect(rollup).toBeDefined()
    expect(rollup?.hasSubtasks).toBe(true)
    expect(rollup?.hasDatedSubtasks).toBe(true)
    expect(rollup?.start).toBe('2026-02-10')
    expect(rollup?.due).toBe('2026-02-20')
    expect(rollup?.totalSubtasks).toBe(2)
    expect(rollup?.doneSubtasks).toBe(1)
    expect(rollup?.progress).toBe(75)
  })

  it('factors in nested subtasks recursively', () => {
    const leaf = makeTask({ id: 'leaf', start: '2026-03-01', due: '2026-03-05', progress: 100, status: 'done' })
    const mid = makeTask({ id: 'mid', subtasks: [leaf] })
    const root = makeTask({ id: 'root', subtasks: [mid] })

    const rollup = computeTaskRollup(root, STATUSES)
    expect(rollup?.start).toBe('2026-03-01')
    expect(rollup?.due).toBe('2026-03-05')
    expect(rollup?.totalSubtasks).toBe(2)
    expect(rollup?.doneSubtasks).toBe(1)
  })

  it('preserves parent boundaries when parent has earlier start or later due', () => {
    const sub = makeTask({ id: 'sub', start: '2026-04-10', due: '2026-04-15' })
    const parent = makeTask({ id: 'parent', start: '2026-04-05', due: '2026-04-20', subtasks: [sub] })

    const rollup = computeTaskRollup(parent, STATUSES)
    expect(rollup?.start).toBe('2026-04-05')
    expect(rollup?.due).toBe('2026-04-20')
  })

  it('aggregates baseline dates when present', () => {
    const sub1 = makeTask({ id: 's1', baselineStart: '2026-05-01', baselineDue: '2026-05-10' })
    const sub2 = makeTask({ id: 's2', baselineStart: '2026-05-05', baselineDue: '2026-05-15' })
    const parent = makeTask({ id: 'p', subtasks: [sub1, sub2] })

    const rollup = computeTaskRollup(parent, STATUSES)
    expect(rollup?.baselineStart).toBe('2026-05-01')
    expect(rollup?.baselineDue).toBe('2026-05-15')
  })
})
