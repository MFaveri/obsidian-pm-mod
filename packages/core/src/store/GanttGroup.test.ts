import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, makeDefaultFilter, makeTask, type Task, type TaskQuery } from '../types'
import type { FilterContext } from './FilterFields'
import { buildGanttRows, summarizeProjectSpan, type GanttGroupProject } from './GanttGroup'

function makeProjectItem(id: string, title: string, tasks: Task[]): GanttGroupProject {
  return {
    id,
    title,
    color: '#8b72be',
    icon: '📋',
    filePath: `Projects/${title}.md`,
    tasks
  }
}

function query(overrides: Partial<TaskQuery> = {}): TaskQuery {
  return {
    text: '',
    filter: makeDefaultFilter(),
    ...overrides
  }
}

const CTX: FilterContext = {
  statuses: DEFAULT_STATUSES,
  customFields: []
}

describe('summarizeProjectSpan', () => {
  it('computes earliest start, latest due, and completion counts across nested tasks and milestones', () => {
    const tasks = [
      makeTask({
        id: 't1',
        status: 'done',
        start: '2026-04-05',
        due: '2026-04-10',
        subtasks: [makeTask({ id: 't1a', status: 'todo', start: '2026-04-02', due: '2026-04-08' })]
      }),
      makeTask({ id: 'm1', type: 'milestone', status: 'done', start: '', due: '2026-04-20' }),
      makeTask({ id: 't2', status: 'todo', start: '', due: '' })
    ]

    expect(summarizeProjectSpan(tasks, DEFAULT_STATUSES)).toEqual({
      start: '2026-04-02',
      due: '2026-04-20',
      done: 2,
      total: 4,
      progress: 50
    })
  })

  it('returns empty span and zero progress for empty task lists', () => {
    expect(summarizeProjectSpan([], DEFAULT_STATUSES)).toEqual({
      start: '',
      due: '',
      done: 0,
      total: 0,
      progress: 0
    })
  })

  it('summarizes baseline min/max dates when tasks hold captured baselines', () => {
    const tasks = [
      makeTask({
        id: 't1',
        start: '2026-04-03',
        due: '2026-04-12',
        baselineStart: '2026-04-01',
        baselineDue: '2026-04-08'
      }),
      makeTask({
        id: 't2',
        start: '2026-04-10',
        due: '2026-04-15',
        baselineStart: '2026-04-09',
        baselineDue: '2026-04-14'
      })
    ]

    expect(summarizeProjectSpan(tasks, DEFAULT_STATUSES)).toEqual({
      start: '2026-04-03',
      due: '2026-04-15',
      baselineStart: '2026-04-01',
      baselineDue: '2026-04-14',
      done: 0,
      total: 2,
      progress: 0
    })
  })
})

describe('buildGanttRows', () => {
  it('keeps flat rows without project headers in single-project mode', () => {
    const project = makeProjectItem('p1', 'Alpha', [
      makeTask({ id: 'a', title: 'A', subtasks: [makeTask({ id: 'a1', title: 'A1' })] })
    ])

    const { rows, timelineTasks } = buildGanttRows({
      projects: [project],
      isMulti: false,
      query: query(),
      statusesOf: () => DEFAULT_STATUSES,
      filterContextOf: () => CTX,
      collapsedTaskIds: new Set(),
      collapsedProjectPaths: new Set()
    })

    expect(timelineTasks.map((t) => t.id)).toEqual(['a'])
    expect(rows.map((r) => [r.kind, r.rowIndex, r.kind === 'task' ? r.depth : r.project.id])).toEqual([
      ['task', 0, 0],
      ['task', 1, 1]
    ])
  })

  it('groups tasks under collapsible project summary rows and preserves timelineTasks when collapsed', () => {
    const alpha = makeProjectItem('p1', 'Alpha', [
      makeTask({ id: 'a', start: '2026-04-01', due: '2026-04-10', status: 'done' })
    ])
    const beta = makeProjectItem('p2', 'Beta', [
      makeTask({
        id: 'b',
        start: '2026-04-05',
        due: '2026-04-15',
        subtasks: [makeTask({ id: 'b1', start: '2026-04-06', due: '2026-04-08' })]
      })
    ])

    const { rows, timelineTasks } = buildGanttRows({
      projects: [alpha, beta],
      isMulti: true,
      query: query(),
      statusesOf: () => DEFAULT_STATUSES,
      filterContextOf: () => CTX,
      collapsedTaskIds: new Set(),
      collapsedProjectPaths: new Set([alpha.filePath])
    })

    expect(timelineTasks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(
      rows.map((r) =>
        r.kind === 'project'
          ? ['project', r.rowIndex, r.project.id, r.summary.start, r.summary.due, r.summary.progress]
          : ['task', r.rowIndex, r.task.id, r.depth]
      )
    ).toEqual([
      ['project', 0, 'p1', '2026-04-01', '2026-04-10', 100],
      ['project', 1, 'p2', '2026-04-05', '2026-04-15', 0],
      ['task', 2, 'b', 1],
      ['task', 3, 'b1', 2]
    ])
  })

  it('hides projects with zero matches when a query is active, but keeps empty projects when unfiltered', () => {
    const empty = makeProjectItem('p1', 'Empty', [])
    const matched = makeProjectItem('p2', 'Matched', [makeTask({ id: 'm', title: 'Launch' })])

    const unfiltered = buildGanttRows({
      projects: [empty, matched],
      isMulti: true,
      query: query(),
      statusesOf: () => DEFAULT_STATUSES,
      filterContextOf: () => CTX,
      collapsedTaskIds: new Set(),
      collapsedProjectPaths: new Set()
    })
    expect(unfiltered.rows.filter((r) => r.kind === 'project').map((r) => r.project.id)).toEqual(['p1', 'p2'])

    const filtered = buildGanttRows({
      projects: [empty, matched],
      isMulti: true,
      query: query({ text: 'launch' }),
      statusesOf: () => DEFAULT_STATUSES,
      filterContextOf: () => CTX,
      collapsedTaskIds: new Set(),
      collapsedProjectPaths: new Set()
    })
    expect(filtered.rows.filter((r) => r.kind === 'project').map((r) => r.project.id)).toEqual(['p2'])
  })
})
