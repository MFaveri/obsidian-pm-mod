import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES,
  makeTask,
  type ResolvedProjectConfig,
  type StatusConfig,
  type Task
} from '../types'
import {
  addDays,
  computeBaselineVariance,
  computeCriticalPath,
  computeDurationRisk,
  computeSchedule,
  computeScheduleHealth,
  daysBetween,
  expandDateRangeOverrides,
  wouldCreateCycle
} from './Scheduler'

function task(overrides: Partial<Task> & { id: string }): Task {
  return makeTask({
    start: '',
    due: '',
    ...overrides
  })
}

const statuses: StatusConfig[] = DEFAULT_STATUSES

describe('daysBetween', () => {
  it('returns 0 for the same date', () => {
    expect(daysBetween('2026-04-23', '2026-04-23')).toBe(0)
  })

  it('returns a positive count when b is after a', () => {
    expect(daysBetween('2026-04-23', '2026-04-30')).toBe(7)
  })

  it('returns a negative count when b is before a', () => {
    expect(daysBetween('2026-04-30', '2026-04-23')).toBe(-7)
  })

  it('crosses month boundaries', () => {
    expect(daysBetween('2026-01-30', '2026-02-02')).toBe(3)
  })
})

describe('addDays', () => {
  it('adds zero days', () => {
    expect(addDays('2026-04-23', 0)).toBe('2026-04-23')
  })

  it('adds positive days', () => {
    expect(addDays('2026-04-23', 7)).toBe('2026-04-30')
  })

  it('subtracts with negative days', () => {
    expect(addDays('2026-04-23', -3)).toBe('2026-04-20')
  })

  it('rolls over month boundaries', () => {
    expect(addDays('2026-01-30', 3)).toBe('2026-02-02')
  })

  it('rolls over year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
  })
})

describe('wouldCreateCycle', () => {
  it('returns false for disjoint tasks', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' })]
    expect(wouldCreateCycle(tasks, 'a', 'b')).toBe(false)
  })

  it('returns true when from can already reach to via dependents', () => {
    // b depends on a, so adding "a depends on b" closes the cycle.
    const tasks = [task({ id: 'a' }), task({ id: 'b', dependencies: ['a'] })]
    expect(wouldCreateCycle(tasks, 'a', 'b')).toBe(true)
  })

  it('detects transitive cycles', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', dependencies: ['a'] }), task({ id: 'c', dependencies: ['b'] })]
    expect(wouldCreateCycle(tasks, 'a', 'c')).toBe(true)
  })

  it('returns false for a valid chain extension', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', dependencies: ['a'] }), task({ id: 'c' })]
    // Adding "c depends on b" does not cycle.
    expect(wouldCreateCycle(tasks, 'c', 'b')).toBe(false)
  })

  it('traverses into subtasks', () => {
    const child = task({ id: 'child', dependencies: ['root'] })
    const tasks = [task({ id: 'root', subtasks: [child] })]
    expect(wouldCreateCycle(tasks, 'root', 'child')).toBe(true)
  })
})

describe('computeSchedule', () => {
  it('returns no patches when there are no dependencies', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-05' }),
      task({ id: 'b', start: '2026-04-10', due: '2026-04-12' })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    expect(result.patches).toEqual([])
    expect(result.cycles).toEqual([])
  })

  it('shifts a successor that starts before its predecessor ends', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-10' }),
      task({ id: 'b', start: '2026-04-05', due: '2026-04-08', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    const patch = result.patches.find((p) => p.taskId === 'b')
    // Earliest start = day after predecessor due (2026-04-11). Duration was 4 days.
    expect(patch).toEqual({ taskId: 'b', start: '2026-04-11', due: '2026-04-14' })
  })

  it('leaves a successor alone when it already starts after the predecessor', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-05' }),
      task({ id: 'b', start: '2026-04-10', due: '2026-04-12', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    expect(result.patches).toEqual([])
  })

  it('cascades across a chain of dependencies', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-10' }),
      task({ id: 'b', start: '2026-04-02', due: '2026-04-04', dependencies: ['a'] }),
      task({ id: 'c', start: '2026-04-05', due: '2026-04-06', dependencies: ['b'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    const b = result.patches.find((p) => p.taskId === 'b')
    const c = result.patches.find((p) => p.taskId === 'c')
    expect(b).toEqual({ taskId: 'b', start: '2026-04-11', due: '2026-04-13' })
    // c must start after b's new due
    expect(c).toEqual({ taskId: 'c', start: '2026-04-14', due: '2026-04-15' })
  })

  it('shifts a milestone by its due date only', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-10' }),
      task({ id: 'm', type: 'milestone', start: '', due: '2026-04-05', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    const patch = result.patches.find((p) => p.taskId === 'm')
    expect(patch).toEqual({ taskId: 'm', start: '', due: '2026-04-11' })
  })

  it('skips tasks in a terminal status', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-10' }),
      task({ id: 'b', start: '2026-04-02', due: '2026-04-03', status: 'done', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    expect(result.patches).toEqual([])
  })

  it('ignores archived predecessors when computing earliest start', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-20', archived: true }),
      task({ id: 'b', start: '2026-04-01', due: '2026-04-05', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    expect(result.patches).toEqual([])
  })

  it('detects cycles and reports them in cycles', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-02', dependencies: ['b'] }),
      task({ id: 'b', start: '2026-04-03', due: '2026-04-04', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    expect(result.cycles).toHaveLength(1)
    expect(new Set(result.cycles[0])).toEqual(new Set(['a', 'b']))
  })

  it('scopes rescheduling to downstream dependents of changedTaskId', () => {
    const tasks = [
      task({ id: 'x', start: '2026-04-01', due: '2026-04-05' }),
      task({ id: 'y', start: '2026-04-01', due: '2026-04-02', dependencies: ['x'] }),
      task({ id: 'unrelated', start: '2026-04-01', due: '2026-04-02' })
    ]
    const result = computeSchedule(tasks, 'x', statuses)
    expect(result.patches.map((p) => p.taskId)).toEqual(['y'])
  })

  it('schedules stale references through the active replacement tail', () => {
    const tasks = [
      task({ id: 'old', status: 'superseded', start: '2026-04-01', due: '2026-04-10', replacedBy: 'current' }),
      task({ id: 'current', start: '2026-04-01', due: '2026-04-20' }),
      task({ id: 'target', start: '2026-04-05', due: '2026-04-06', dependencies: ['old'] })
    ]

    const result = computeSchedule(tasks, undefined, statuses)

    expect(result.patches.find((patch) => patch.taskId === 'target')).toEqual({
      taskId: 'target',
      start: '2026-04-21',
      due: '2026-04-22'
    })
  })

  it('ignores missing dependency ids silently', () => {
    const tasks = [task({ id: 'a', start: '2026-04-01', due: '2026-04-05', dependencies: ['ghost'] })]
    const result = computeSchedule(tasks, undefined, statuses)
    expect(result.patches).toEqual([])
    expect(result.cycles).toEqual([])
  })
})

describe('computeSchedule with pullForward', () => {
  const finishedEarly = task({
    id: 'a',
    start: '2026-07-06',
    due: '2026-07-13',
    completed: '2026-07-10',
    status: 'done'
  })

  it('leaves dependents alone when the option is off', () => {
    const tasks = [finishedEarly, task({ id: 'b', start: '2026-07-14', due: '2026-07-16', dependencies: ['a'] })]
    expect(computeSchedule(tasks, undefined, statuses).patches).toEqual([])
  })

  it('pulls a dependent back by the days its predecessor saved', () => {
    const tasks = [finishedEarly, task({ id: 'b', start: '2026-07-14', due: '2026-07-16', dependencies: ['a'] })]
    const result = computeSchedule(tasks, undefined, statuses, true)
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-07-11', due: '2026-07-13' }])
  })

  it('keeps the slack a dependent already had', () => {
    const tasks = [finishedEarly, task({ id: 'b', start: '2026-07-20', due: '2026-07-22', dependencies: ['a'] })]
    const result = computeSchedule(tasks, undefined, statuses, true)
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-07-17', due: '2026-07-19' }])
  })

  it('never pulls a dependent before the day after its predecessor finished', () => {
    const early = task({ id: 'a', start: '2026-07-01', due: '2026-07-13', completed: '2026-07-02', status: 'done' })
    const tasks = [early, task({ id: 'b', start: '2026-07-05', due: '2026-07-08', dependencies: ['a'] })]
    const result = computeSchedule(tasks, undefined, statuses, true)
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-07-03', due: '2026-07-06' }])
  })

  it('cascades the saved days down the chain', () => {
    const tasks = [
      finishedEarly,
      task({ id: 'b', start: '2026-07-14', due: '2026-07-16', dependencies: ['a'] }),
      task({ id: 'c', start: '2026-07-20', due: '2026-07-21', dependencies: ['b'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses, true)
    expect(result.patches).toEqual([
      { taskId: 'b', start: '2026-07-11', due: '2026-07-13' },
      { taskId: 'c', start: '2026-07-17', due: '2026-07-18' }
    ])
  })

  it('holds a dependent in place while another predecessor is still due later', () => {
    const tasks = [
      finishedEarly,
      task({ id: 'gate', start: '2026-07-06', due: '2026-07-13' }),
      task({ id: 'b', start: '2026-07-14', due: '2026-07-16', dependencies: ['a', 'gate'] })
    ]
    expect(computeSchedule(tasks, undefined, statuses, true).patches).toEqual([])
  })

  it('pulls a milestone by its due date', () => {
    const tasks = [finishedEarly, task({ id: 'm', due: '2026-07-14', type: 'milestone', dependencies: ['a'] })]
    const result = computeSchedule(tasks, undefined, statuses, true)
    expect(result.patches).toEqual([{ taskId: 'm', start: '', due: '2026-07-11' }])
  })

  it('ignores a task that completed on or after its due date', () => {
    const onTime = task({ id: 'a', start: '2026-07-06', due: '2026-07-13', completed: '2026-07-13', status: 'done' })
    const tasks = [onTime, task({ id: 'b', start: '2026-07-20', due: '2026-07-22', dependencies: ['a'] })]
    expect(computeSchedule(tasks, undefined, statuses, true).patches).toEqual([])
  })

  it('ignores a completion date on a task that is not in a terminal status', () => {
    const reopened = task({ id: 'a', start: '2026-07-06', due: '2026-07-13', completed: '2026-07-10' })
    const tasks = [reopened, task({ id: 'b', start: '2026-07-14', due: '2026-07-16', dependencies: ['a'] })]
    expect(computeSchedule(tasks, undefined, statuses, true).patches).toEqual([])
  })

  it('still pushes a dependent that starts too early', () => {
    const tasks = [finishedEarly, task({ id: 'b', start: '2026-07-08', due: '2026-07-09', dependencies: ['a'] })]
    const result = computeSchedule(tasks, undefined, statuses, true)
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-07-11', due: '2026-07-12' }])
  })
})

describe('computeSchedule with predecessors in other projects', () => {
  const statuses: StatusConfig[] = [
    { id: 'todo', label: 'Todo', color: '#888', icon: '', complete: false },
    { id: 'done', label: 'Done', color: '#0a0', icon: '', complete: true }
  ]

  it('pushes a task out to clear a predecessor it does not share a project with', () => {
    const external = task({ id: 'ext', start: '2026-07-06', due: '2026-07-20' })
    const tasks = [task({ id: 'b', start: '2026-07-08', due: '2026-07-10', dependencies: ['ext'] })]
    const result = computeSchedule(tasks, undefined, statuses, false, [external])
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-07-21', due: '2026-07-23' }])
  })

  it('never moves the outside predecessor itself', () => {
    const external = task({ id: 'ext', start: '2026-07-20', due: '2026-07-22', dependencies: ['b'] })
    const tasks = [task({ id: 'b', start: '2026-07-06', due: '2026-07-08' })]
    const result = computeSchedule(tasks, undefined, statuses, false, [external])
    expect(result.patches.some((p) => p.taskId === 'ext')).toBe(false)
  })

  it('ignores a dependency that resolves nowhere at all', () => {
    const tasks = [task({ id: 'b', start: '2026-07-08', due: '2026-07-10', dependencies: ['gone'] })]
    expect(computeSchedule(tasks, undefined, statuses).patches).toEqual([])
  })
})

describe('computeSchedule with workdaysOnly and holidays', () => {
  const statuses: StatusConfig[] = [
    { id: 'todo', label: 'Todo', color: '#888', icon: '', complete: false },
    { id: 'done', label: 'Done', color: '#0a0', icon: '', complete: true }
  ]

  it('pushes a dependent starting after Friday to Monday and preserves working-day duration', () => {
    // 2026-04-03 is Friday; 2026-04-06 is Monday.
    // Task b originally runs Mon 2026-03-30 to Wed 2026-04-01 (3 working days).
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-03' }),
      task({ id: 'b', start: '2026-03-30', due: '2026-04-01', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses, false, [], { workdaysOnly: true })
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-04-06', due: '2026-04-08' }])
  })

  it('skips weekends and holidays inside a dependent task span and on start', () => {
    // 2026-04-03 is Friday; Monday 2026-04-06 is a holiday, Wednesday 2026-04-08 is a holiday.
    // A 3-working-day task starts Tue 2026-04-07, skips Wed 04-08, includes Thu 04-09 & Fri 04-10.
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-03' }),
      task({ id: 'b', start: '2026-03-30', due: '2026-04-01', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses, false, [], {
      workdaysOnly: true,
      holidays: ['2026-04-06', '2026-04-08']
    })
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-04-07', due: '2026-04-10' }])
  })

  it('places milestones on the next working day', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-03' }),
      task({ id: 'm', type: 'milestone', start: '', due: '2026-04-03', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses, false, [], { workdaysOnly: true })
    expect(result.patches).toEqual([{ taskId: 'm', start: '', due: '2026-04-06' }])
  })

  it('pulls dependent forward in working days without landing on weekends or holidays', () => {
    // Predecessor planned due Fri 2026-04-10, finished early on Wed 2026-04-08 (2 working days saved).
    // Dependent starts Mon 2026-04-13 for 3 working days (Mon..Wed). Pulling 2 working days lands on Thu 2026-04-09 -> Mon 2026-04-13.
    const tasks = [
      task({ id: 'a', status: 'done', start: '2026-04-06', due: '2026-04-10', completed: '2026-04-08' }),
      task({ id: 'b', start: '2026-04-13', due: '2026-04-15', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses, true, [], { workdaysOnly: true })
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-04-09', due: '2026-04-13' }])
  })

  it('schedules a Saturdays-only project across consecutive Saturdays', () => {
    // 2026-04-04 is Saturday. A 2-working-day dependent spans Sat 2026-04-11 to Sat 2026-04-18.
    const tasks = [
      task({ id: 'a', start: '2026-04-04', due: '2026-04-04' }),
      task({ id: 'b', start: '2026-03-21', due: '2026-03-28', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses, false, [], {
      workdaysOnly: true,
      workingWeekdays: [6]
    })
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-04-11', due: '2026-04-18' }])
  })

  it('treats specific extraWorkdays as working days one by one without affecting other Saturdays', () => {
    // 2026-11-20 is Friday; Sat 2026-11-21 is explicitly worked, while Sat 2026-11-28 stays off.
    const tasks = [
      task({ id: 'a', start: '2026-11-18', due: '2026-11-20' }),
      task({ id: 'b', start: '2026-11-16', due: '2026-11-17', dependencies: ['a'] }),
      task({ id: 'c', start: '2026-11-25', due: '2026-11-27' }),
      task({ id: 'd', start: '2026-11-23', due: '2026-11-23', dependencies: ['c'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses, false, [], {
      workdaysOnly: true,
      extraWorkdays: ['2026-11-21']
    })
    expect(result.patches).toEqual([
      { taskId: 'b', start: '2026-11-21', due: '2026-11-23' },
      { taskId: 'd', start: '2026-11-30', due: '2026-11-30' }
    ])
  })

  it('skips specific extraNonWorkdays (such as PTO/vacation) when scheduling dependents', () => {
    // Wed 2026-11-18 and Thu 2026-11-19 are marked non-working days one by one.
    const tasks = [
      task({ id: 'a', start: '2026-11-16', due: '2026-11-17' }),
      task({ id: 'b', start: '2026-11-16', due: '2026-11-17', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses, false, [], {
      workdaysOnly: true,
      extraNonWorkdays: ['2026-11-18', '2026-11-19']
    })
    // A 2-day task skips Wed 11-18 and Thu 11-19 -> Fri 11-20 and Mon 11-23.
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-11-20', due: '2026-11-23' }])
  })

  it('uses start date as fallback end when a predecessor only has a start date', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-06', due: '' }),
      task({ id: 'b', start: '2026-04-05', due: '2026-04-07', dependencies: ['a'] })
    ]
    const result = computeSchedule(tasks, undefined, statuses)
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-04-07', due: '2026-04-09' }])
  })
})

describe('computeCriticalPath', () => {
  it('identifies critical tasks, total slack, and driving edges across parallel branches', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-02' }), // 2 days -> feeds c (2 days slack)
      task({ id: 'b', start: '2026-04-01', due: '2026-04-04' }), // 4 days -> feeds c (critical)
      task({ id: 'c', start: '2026-04-05', due: '2026-04-08', dependencies: ['a', 'b'] }) // critical
    ]

    const result = computeCriticalPath(tasks, statuses)
    expect(result.projectFinish).toBe('2026-04-08')
    expect(result.criticalTaskIds).toEqual(['b', 'c'])
    expect(result.criticalEdges).toEqual([['b', 'c']])
    expect(result.tasks.a).toMatchObject({
      slackDays: 2,
      critical: false,
      lateStart: '2026-04-03',
      lateFinish: '2026-04-04'
    })
    expect(result.tasks.b).toMatchObject({ slackDays: 0, critical: true })
    expect(result.tasks.c).toMatchObject({ slackDays: 0, critical: true })
  })

  it('gives slack to a predecessor when the successor is scheduled later with a manual buffer', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-03' }),
      task({ id: 'b', start: '2026-04-06', due: '2026-04-08', dependencies: ['a'] })
    ]

    const result = computeCriticalPath(tasks, statuses)
    expect(result.projectFinish).toBe('2026-04-08')
    expect(result.criticalTaskIds).toEqual(['b'])
    expect(result.criticalEdges).toEqual([])
    expect(result.tasks.a.slackDays).toBe(2)
    expect(result.tasks.b.slackDays).toBe(0)
  })

  it('includes milestones cleanly on the critical path', () => {
    const tasks = [
      task({ id: 'a', start: '2026-04-01', due: '2026-04-03' }),
      task({ id: 'm', type: 'milestone', due: '2026-04-04', dependencies: ['a'] }),
      task({ id: 'b', start: '2026-04-05', due: '2026-04-07', dependencies: ['m'] })
    ]

    const result = computeCriticalPath(tasks, statuses)
    expect(result.criticalTaskIds).toEqual(['a', 'm', 'b'])
    expect(result.criticalEdges).toEqual([
      ['a', 'm'],
      ['m', 'b']
    ])
  })

  it('excludes completed, archived, and superseded tasks from criticality while keeping constraints', () => {
    const tasks = [
      task({ id: 'old', status: 'superseded', replacedBy: 'done1', start: '2026-04-01', due: '2026-04-02' }),
      task({ id: 'done1', status: 'done', start: '2026-04-01', due: '2026-04-05' }),
      task({ id: 'arch', archived: true, start: '2026-04-01', due: '2026-04-20' }),
      task({ id: 'next', status: 'todo', start: '2026-04-03', due: '2026-04-07', dependencies: ['old'] })
    ]

    const result = computeCriticalPath(tasks, statuses)
    expect(result.tasks.old).toBeUndefined()
    expect(result.tasks.done1).toBeUndefined()
    expect(result.tasks.arch).toBeUndefined()
    // `old` resolves to `done1` (due 04-05), pushing `next` (duration 5) to 04-06..04-10.
    expect(result.projectFinish).toBe('2026-04-10')
    expect(result.tasks.next).toMatchObject({
      earlyStart: '2026-04-06',
      earlyFinish: '2026-04-10',
      slackDays: 0,
      critical: true
    })
    expect(result.criticalEdges).toEqual([])
  })

  it('computes slack in working days respecting weekdays, holidays, and extraWorkdays', () => {
    // 2026-11-20 is Friday; Sat 2026-11-21 is an extra workday; Sun 2026-11-22 is off; Mon 2026-11-23 is a holiday.
    // Task a ends Fri 2026-11-20. Task b starts Tue 2026-11-24.
    // Working days between Fri 2026-11-20 and Mon 2026-11-23 (= Tue - 1wday? No, Sat 11-21 IS a workday!):
    // stepWorkingDays(Tue 2026-11-24, -1) lands on Sat 2026-11-21, so slack(a) = 1 working day (Sat 11-21).
    const tasks = [
      task({ id: 'a', start: '2026-11-19', due: '2026-11-20' }),
      task({ id: 'b', start: '2026-11-24', due: '2026-11-25', dependencies: ['a'] })
    ]

    const withExtra = computeCriticalPath(tasks, statuses, [], {
      workdaysOnly: true,
      holidays: ['2026-11-23'],
      extraWorkdays: ['2026-11-21']
    })
    expect(withExtra.tasks.a.slackDays).toBe(1)
    expect(withExtra.tasks.a.critical).toBe(false)

    // Without extraWorkdays on Sat 11-21 and Mon 11-23 still a holiday, Fri 11-20 -> Tue 11-24 has 0 slack!
    const tight = computeCriticalPath(tasks, statuses, [], {
      workdaysOnly: true,
      holidays: ['2026-11-23']
    })
    expect(tight.tasks.a.slackDays).toBe(0)
    expect(tight.tasks.a.critical).toBe(true)
    expect(tight.criticalEdges).toEqual([['a', 'b']])
  })

  it('returns empty results when no active dated tasks exist and reports cycles', () => {
    const emptyResult = computeCriticalPath(
      [task({ id: 'u' }), task({ id: 'd', status: 'done', due: '2026-04-05' })],
      statuses
    )
    expect(emptyResult.projectFinish).toBe('')
    expect(emptyResult.criticalTaskIds).toEqual([])

    const cyclic = computeCriticalPath(
      [
        task({ id: 'x', start: '2026-04-01', due: '2026-04-02', dependencies: ['y'] }),
        task({ id: 'y', start: '2026-04-03', due: '2026-04-04', dependencies: ['x'] })
      ],
      statuses
    )
    expect(cyclic.cycles).toEqual([['x', 'y']])
    expect(cyclic.criticalTaskIds).toEqual([])
  })
})

describe('computeBaselineVariance', () => {
  it('returns null when the task has no baseline dates', () => {
    expect(computeBaselineVariance(task({ id: 'a', start: '2026-11-16', due: '2026-11-20' }))).toBeNull()
  })

  it('calculates positive slip and negative ahead variance in working or calendar days', () => {
    const slipped = task({
      id: 'a',
      baselineStart: '2026-11-16',
      baselineDue: '2026-11-20',
      start: '2026-11-18',
      due: '2026-11-24'
    })
    // Calendar days: start +2, due +4
    expect(computeBaselineVariance(slipped)).toEqual({
      baselineStart: '2026-11-16',
      baselineDue: '2026-11-20',
      startDeltaDays: 2,
      dueDeltaDays: 4
    })
    // Working days (Mon-Fri): 11-20 (Fri) -> 11-24 (Tue) = 2 working days
    expect(computeBaselineVariance(slipped, { workdaysOnly: true })).toEqual({
      baselineStart: '2026-11-16',
      baselineDue: '2026-11-20',
      startDeltaDays: 2,
      dueDeltaDays: 2
    })

    const ahead = task({
      id: 'b',
      type: 'milestone',
      baselineDue: '2026-11-20',
      due: '2026-11-18'
    })
    expect(computeBaselineVariance(ahead)).toEqual({
      baselineStart: '2026-11-20',
      baselineDue: '2026-11-20',
      startDeltaDays: -2,
      dueDeltaDays: -2
    })
  })
})

describe('expandDateRangeOverrides', () => {
  it('returns a single date verbatim even if it falls on a weekend or weekday', () => {
    expect(expandDateRangeOverrides('2026-11-21', '', 'extraWorkdays')).toEqual(['2026-11-21'])
    expect(expandDateRangeOverrides('2026-11-22', '2026-11-22', 'extraNonWorkdays')).toEqual(['2026-11-22'])
  })

  it('expands a vacation range into working days only, skipping weekends and holidays', () => {
    // Mon 2026-12-21 .. Sun 2026-12-27 with Fri 2026-12-25 holiday -> Mon..Thu only.
    expect(
      expandDateRangeOverrides('2026-12-21', '2026-12-27', 'extraNonWorkdays', {
        workingWeekdays: [1, 2, 3, 4, 5],
        holidays: ['2026-12-25']
      })
    ).toEqual(['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24'])
  })

  it('expands an extra-workdays range into weekend/holiday days and tolerates reversed bounds', () => {
    expect(
      expandDateRangeOverrides('2026-11-23', '2026-11-20', 'extraWorkdays', {
        workingWeekdays: [1, 2, 3, 4, 5]
      })
    ).toEqual(['2026-11-21', '2026-11-22'])
  })
})

describe('durationDays and computeDurationRisk', () => {
  it('flags a shortfall when available days are fewer than mandatory durationDays', () => {
    // 2026-05-04 (Mon) .. 2026-05-06 (Wed) = 3 days, but durationDays = 5
    const t = task({
      id: 'd1',
      start: '2026-05-04',
      due: '2026-05-06',
      durationDays: 5
    })
    expect(computeDurationRisk(t)).toEqual({
      requiredDays: 5,
      availableDays: 3,
      shortfallDays: 2,
      projectedDue: '2026-05-08'
    })
    // In working days (Mon-Fri), 5 working days from Mon May 4 ends Fri May 8; from Wed May 6 + weekend:
    // If due is Thu May 7 (4 working days) and durationDays is 6 -> projectedDue skips Sat/Sun to Mon May 11
    const withWeekend = task({
      id: 'd2',
      start: '2026-05-04',
      due: '2026-05-07',
      durationDays: 6
    })
    expect(computeDurationRisk(withWeekend, { workdaysOnly: true })).toEqual({
      requiredDays: 6,
      availableDays: 4,
      shortfallDays: 2,
      projectedDue: '2026-05-11'
    })
  })

  it('returns null when window covers durationDays or task is a milestone', () => {
    expect(computeDurationRisk(task({ id: 'ok', start: '2026-05-04', due: '2026-05-08', durationDays: 5 }))).toBeNull()
    expect(
      computeDurationRisk(
        task({ id: 'ms', type: 'milestone', start: '2026-05-04', due: '2026-05-04', durationDays: 5 })
      )
    ).toBeNull()
  })

  it('pushes due forward to enforce mandatory durationDays when rescheduled', () => {
    const a = task({ id: 'a', start: '2026-05-04', due: '2026-05-06' })
    const b = task({
      id: 'b',
      start: '2026-05-05',
      due: '2026-05-06', // only 2 days wide currently
      durationDays: 5,
      dependencies: ['a']
    })
    const c = task({
      id: 'c',
      start: '2026-05-07',
      due: '2026-05-08',
      dependencies: ['b']
    })
    const result = computeSchedule([a, b, c], undefined, statuses)
    // b pushed to May 7, enforced 5 days -> May 7..May 11; c pushed to May 12..May 13
    expect(result.patches).toEqual([
      { taskId: 'b', start: '2026-05-07', due: '2026-05-11' },
      { taskId: 'c', start: '2026-05-12', due: '2026-05-13' }
    ])
  })

  it('populates due when a dependent task with only start or no dates has durationDays', () => {
    const a = task({ id: 'a', start: '2026-05-04', due: '2026-05-05' })
    const b = task({ id: 'b', durationDays: 4, dependencies: ['a'] })
    const result = computeSchedule([a, b], undefined, statuses)
    expect(result.patches).toEqual([{ taskId: 'b', start: '2026-05-06', due: '2026-05-09' }])
  })

  it('uses mandatory durationDays in CPM even if due is manually compressed', () => {
    const a = task({ id: 'a', start: '2026-05-04', due: '2026-05-05', durationDays: 5 })
    const b = task({ id: 'b', start: '2026-05-09', due: '2026-05-10', dependencies: ['a'] })
    const cpm = computeCriticalPath([a, b], statuses)
    // a effectively finishes on May 8 (5 days from May 4), so b starts May 9 with 0 slack
    expect(cpm.tasks['a']?.earlyFinish).toBe('2026-05-08')
    expect(cpm.tasks['a']?.slackDays).toBe(0)
    expect(cpm.criticalTaskIds).toEqual(['a', 'b'])
  })
})

describe('dependency types (FS/SS/FF) and lagDays', () => {
  it('supports FS positive lag and negative lead', () => {
    const a = task({ id: 'a', start: '2026-05-04', due: '2026-05-06' })
    const lag = task({
      id: 'lag',
      start: '2026-05-06',
      due: '2026-05-07',
      dependencies: ['a'],
      dependencyLinks: { a: { type: 'FS', lagDays: 2 } }
    })
    const lead = task({
      id: 'lead',
      start: '2026-05-04',
      due: '2026-05-05',
      dependencies: ['a'],
      dependencyLinks: { a: { lagDays: -1 } }
    })
    const result = computeSchedule([a, lag, lead], undefined, statuses)
    expect(result.patches).toEqual([
      { taskId: 'lag', start: '2026-05-09', due: '2026-05-10' },
      { taskId: 'lead', start: '2026-05-06', due: '2026-05-07' }
    ])
  })

  it('supports SS and FF dependencies preserving successor duration', () => {
    const a = task({ id: 'a', start: '2026-05-04', due: '2026-05-08' })
    // SS +2d: b must start >= May 6; currently May 4..May 5 (2 days) -> May 6..May 7
    const b = task({
      id: 'b',
      start: '2026-05-04',
      due: '2026-05-05',
      dependencies: ['a'],
      dependencyLinks: { a: { type: 'SS', lagDays: 2 } }
    })
    // FF +0d: c must finish >= May 8; currently May 4..May 5 (2 days) -> May 7..May 8
    const c = task({
      id: 'c',
      start: '2026-05-04',
      due: '2026-05-05',
      dependencies: ['a'],
      dependencyLinks: { a: { type: 'FF' } }
    })
    const result = computeSchedule([a, b, c], undefined, statuses)
    expect(result.patches).toEqual([
      { taskId: 'b', start: '2026-05-06', due: '2026-05-07' },
      { taskId: 'c', start: '2026-05-07', due: '2026-05-08' }
    ])
  })

  it('does not pull SS dependent earlier when predecessor merely finishes early', () => {
    const a = task({
      id: 'a',
      status: 'done',
      start: '2026-05-04',
      due: '2026-05-08',
      completed: '2026-05-06'
    })
    const b = task({
      id: 'b',
      start: '2026-05-06',
      due: '2026-05-08',
      dependencies: ['a'],
      dependencyLinks: { a: { type: 'SS', lagDays: 2 } }
    })
    const result = computeSchedule([a, b], 'a', statuses, true)
    expect(result.patches).toEqual([])
  })

  it('computes CPM criticality and tight edges for SS, FF, and FS with lag', () => {
    const a = task({ id: 'a', start: '2026-05-04', due: '2026-05-06' })
    const b = task({
      id: 'b',
      start: '2026-05-06',
      due: '2026-05-10',
      dependencies: ['a'],
      dependencyLinks: { a: { type: 'SS', lagDays: 2 } }
    })
    const c = task({
      id: 'c',
      start: '2026-05-08',
      due: '2026-05-10',
      dependencies: ['b'],
      dependencyLinks: { b: { type: 'FF' } }
    })
    const cpm = computeCriticalPath([a, b, c], statuses)
    expect(cpm.criticalTaskIds).toEqual(['a', 'b', 'c'])
    expect(cpm.criticalEdges).toEqual([
      ['a', 'b'],
      ['b', 'c']
    ])
    expect(cpm.tasks['a']?.slackDays).toBe(0)
  })
})

describe('computeScheduleHealth', () => {
  it('aggregates critical tasks, baseline variances, and active duration risks', () => {
    const config: ResolvedProjectConfig = {
      statuses,
      priorities: DEFAULT_PRIORITIES,
      priorityIcons: 'chevrons',
      customFields: [],
      defaultView: 'table',
      autoSchedule: false,
      pullForwardOnEarlyFinish: false,
      scheduleWorkdaysOnly: false,
      workingWeekdays: [1, 2, 3, 4, 5],
      extraWorkdays: [],
      extraNonWorkdays: [],
      autoArchiveDays: 0,
      showSubtreeConnections: true,
      lineBorders: 'none'
    }
    const a = task({
      id: 'a',
      start: '2026-05-04',
      due: '2026-05-06',
      baselineStart: '2026-05-04',
      baselineDue: '2026-05-04', // +2d late
      durationDays: 5 // active shortfall risk (3d / 5d)
    })
    const b = task({
      id: 'b',
      start: '2026-05-07',
      due: '2026-05-08',
      baselineStart: '2026-05-07',
      baselineDue: '2026-05-08', // 0d on time
      dependencies: ['a']
    })
    const done = task({
      id: 'done',
      status: 'done',
      start: '2026-05-04',
      due: '2026-05-04',
      durationDays: 5, // ignored in active durationRisks since done
      baselineStart: '2026-05-04',
      baselineDue: '2026-05-06' // -2d ahead
    })

    const health = computeScheduleHealth([a, b, done], config)
    expect(health.criticalTasks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(health.baselineTrackedCount).toBe(3)
    expect(health.baselineLateCount).toBe(1)
    expect(health.baselineOnTimeCount).toBe(1)
    expect(health.baselineAheadCount).toBe(1)
    expect(health.maxBaselineSlipDays).toBe(2)
    expect(health.durationRisks.map((entry) => entry.task.id)).toEqual(['a'])
  })
})
