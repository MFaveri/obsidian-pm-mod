import { describe, expect, it } from 'vitest'
import type { StatusConfig, Task } from '../types'
import { computeScopeWorkload } from './Workload'

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

describe('computeScopeWorkload', () => {
  it('returns empty result when there are no tasks or assignees', () => {
    const res = computeScopeWorkload([], STATUSES)
    expect(res.assignees).toEqual([])
    expect(res.overloadedTaskIds.size).toBe(0)
    expect(res.totalOverloadedAssignees).toBe(0)
  })

  it('detects no overload when tasks for an assignee do not overlap in working days', () => {
    // 2026-06-01 is Monday, 2026-06-05 is Friday
    // 2026-06-08 is next Monday, 2026-06-12 is next Friday
    const t1 = makeTask({ id: 't1', assignees: ['Alice'], start: '2026-06-01', due: '2026-06-05' })
    const t2 = makeTask({ id: 't2', assignees: ['Alice'], start: '2026-06-08', due: '2026-06-12' })

    const res = computeScopeWorkload([t1, t2], STATUSES)
    expect(res.assignees.length).toBe(1)
    expect(res.assignees[0].assignee).toBe('Alice')
    expect(res.assignees[0].isOverloaded).toBe(false)
    expect(res.assignees[0].maxConcurrentTasks).toBe(1)
    expect(res.assignees[0].overloadDaysCount).toBe(0)
    expect(res.overloadedTaskIds.size).toBe(0)
  })

  it('detects concurrent overload when tasks overlap on working days', () => {
    // Both active Wed-Fri (2026-06-03 to 2026-06-05) -> 3 overlapping working days
    const t1 = makeTask({ id: 't1', assignees: ['Bob'], start: '2026-06-01', due: '2026-06-05' })
    const t2 = makeTask({ id: 't2', assignees: ['Bob'], start: '2026-06-03', due: '2026-06-10' })

    const res = computeScopeWorkload([t1, t2], STATUSES)
    expect(res.assignees.length).toBe(1)
    expect(res.assignees[0].isOverloaded).toBe(true)
    expect(res.assignees[0].maxConcurrentTasks).toBe(2)
    expect(res.assignees[0].overloadDaysCount).toBe(3)
    expect(res.assignees[0].conflicts).toEqual([
      { task1Id: 't1', task2Id: 't2', overlappingDays: 3 }
    ])
    expect(res.overloadedTaskIds.has('t1')).toBe(true)
    expect(res.overloadedTaskIds.has('t2')).toBe(true)
    expect(res.totalOverloadedAssignees).toBe(1)
  })

  it('ignores completed tasks and weekends/holidays', () => {
    // 2026-06-06 and 2026-06-07 are Sat and Sun
    const t1 = makeTask({ id: 't1', assignees: ['Carol'], start: '2026-06-06', due: '2026-06-07' })
    const t2 = makeTask({ id: 't2', assignees: ['Carol'], start: '2026-06-06', due: '2026-06-07' })
    const tDone = makeTask({ id: 'td', assignees: ['Carol'], status: 'done', start: '2026-06-01', due: '2026-06-05' })

    const res = computeScopeWorkload([t1, t2, tDone], STATUSES)
    // Overlapping only on weekend days -> 0 working overload days!
    expect(res.assignees[0].overloadDaysCount).toBe(0)
    expect(res.assignees[0].isOverloaded).toBe(false)
  })
})
