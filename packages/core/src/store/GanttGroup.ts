import { parsePlainDate, Temporal } from '../dates'
import type { StatusConfig, Task, TaskQuery } from '../types'
import { isTerminalStatus } from '../utils'
import type { FilterContext } from './FilterFields'
import { applyTaskFilterPromote, excludeSupersededTasks, includesSupersededFilter, isQueryActive } from './TaskFilter'
import { flattenTasks } from './TaskTreeOps'

export interface ProjectSpanSummary {
  start: string
  due: string
  baselineStart?: string
  baselineDue?: string
  done: number
  total: number
  progress: number
}

export interface GanttGroupProject {
  id: string
  title: string
  color: string
  icon: string
  filePath: string
  tasks: Task[]
}

export type GanttRowItem<P extends GanttGroupProject = GanttGroupProject> =
  | {
      kind: 'project'
      project: P
      summary: ProjectSpanSummary
      rowIndex: number
    }
  | {
      kind: 'task'
      project: P
      task: Task
      depth: number
      rowIndex: number
    }

export interface BuildGanttRowsOptions<P extends GanttGroupProject> {
  projects: P[]
  isMulti: boolean
  query: TaskQuery
  statusesOf: (project: P) => StatusConfig[]
  filterContextOf: (project: P) => FilterContext
  collapsedTaskIds: ReadonlySet<string>
  collapsedProjectPaths: ReadonlySet<string>
}

export function summarizeProjectSpan(tasks: Task[], statuses: StatusConfig[]): ProjectSpanSummary {
  let minDate: Temporal.PlainDate | null = null
  let maxDate: Temporal.PlainDate | null = null
  let minBase: Temporal.PlainDate | null = null
  let maxBase: Temporal.PlainDate | null = null
  let done = 0
  let total = 0

  for (const { task } of flattenTasks(tasks)) {
    total++
    if (isTerminalStatus(task.status, statuses)) done++

    const startDate = parsePlainDate(task.start) ?? parsePlainDate(task.due)
    if (startDate && (!minDate || Temporal.PlainDate.compare(startDate, minDate) < 0)) {
      minDate = startDate
    }

    const dueDate = parsePlainDate(task.due) ?? parsePlainDate(task.start)
    if (dueDate && (!maxDate || Temporal.PlainDate.compare(dueDate, maxDate) > 0)) {
      maxDate = dueDate
    }

    const baseStart = parsePlainDate(task.baselineStart ?? '') ?? parsePlainDate(task.baselineDue ?? '')
    if (baseStart && (!minBase || Temporal.PlainDate.compare(baseStart, minBase) < 0)) {
      minBase = baseStart
    }

    const baseDue = parsePlainDate(task.baselineDue ?? '') ?? parsePlainDate(task.baselineStart ?? '')
    if (baseDue && (!maxBase || Temporal.PlainDate.compare(baseDue, maxBase) > 0)) {
      maxBase = baseDue
    }
  }

  return {
    start: minDate ? minDate.toString() : '',
    due: maxDate ? maxDate.toString() : '',
    ...(minBase ? { baselineStart: minBase.toString() } : {}),
    ...(maxBase ? { baselineDue: maxBase.toString() } : {}),
    done,
    total,
    progress: total > 0 ? Math.round((done / total) * 100) : 0
  }
}

export function buildGanttRows<P extends GanttGroupProject>(
  opts: BuildGanttRowsOptions<P>
): { rows: GanttRowItem<P>[]; timelineTasks: Task[] } {
  const includeSuperseded = includesSupersededFilter(opts.query.filter)
  const rows: GanttRowItem<P>[] = []
  const timelineTasks: Task[] = []

  if (!opts.isMulti) {
    const project = opts.projects[0]
    if (!project) return { rows, timelineTasks }
    const visible = applyTaskFilterPromote(
      excludeSupersededTasks(project.tasks, includeSuperseded),
      opts.query,
      opts.filterContextOf(project)
    )
    timelineTasks.push(...visible)
    for (const flat of flattenTasks(visible, opts.collapsedTaskIds)) {
      if (!flat.visible && flat.depth !== 0) continue
      rows.push({ kind: 'task', project, task: flat.task, depth: flat.depth, rowIndex: rows.length })
    }
    return { rows, timelineTasks }
  }

  const queryActive = isQueryActive(opts.query)
  for (const project of opts.projects) {
    const visible = applyTaskFilterPromote(
      excludeSupersededTasks(project.tasks, includeSuperseded),
      opts.query,
      opts.filterContextOf(project)
    )
    if (queryActive && visible.length === 0) continue

    timelineTasks.push(...visible)
    rows.push({
      kind: 'project',
      project,
      summary: summarizeProjectSpan(visible, opts.statusesOf(project)),
      rowIndex: rows.length
    })

    if (opts.collapsedProjectPaths.has(project.filePath)) continue
    for (const flat of flattenTasks(visible, opts.collapsedTaskIds)) {
      if (!flat.visible && flat.depth !== 0) continue
      rows.push({ kind: 'task', project, task: flat.task, depth: flat.depth + 1, rowIndex: rows.length })
    }
  }

  return { rows, timelineTasks }
}
