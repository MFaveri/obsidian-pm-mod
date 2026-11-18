import { parsePlainDate, Temporal } from '../dates'
import type { StatusConfig, Task } from '../types'
import { isTerminalStatus } from '../utils'

export interface TaskRollup {
  taskId: string
  hasSubtasks: boolean
  hasDatedSubtasks: boolean
  start: string
  due: string
  baselineStart?: string
  baselineDue?: string
  totalSubtasks: number
  doneSubtasks: number
  progress: number
}

/** Recursively gathers all subtasks under a task. */
export function collectDescendantSubtasks(task: Task): Task[] {
  const result: Task[] = []
  const walk = (t: Task): void => {
    for (const sub of t.subtasks) {
      result.push(sub)
      if (sub.subtasks.length > 0) walk(sub)
    }
  }
  walk(task)
  return result
}

/**
 * Computes rollup schedule boundaries and aggregated progress for a parent task based on
 * its subtasks. Returns undefined when the task has no subtasks.
 */
export function computeTaskRollup(task: Task, statuses: StatusConfig[]): TaskRollup | undefined {
  if (task.subtasks.length === 0) return undefined

  const descendants = collectDescendantSubtasks(task)
  const totalSubtasks = descendants.length
  const doneSubtasks = descendants.filter((t) => isTerminalStatus(t.status, statuses)).length

  let minDate: Temporal.PlainDate | null = null
  let maxDate: Temporal.PlainDate | null = null
  let minBase: Temporal.PlainDate | null = null
  let maxBase: Temporal.PlainDate | null = null
  let hasDatedSubtasks = false

  for (const t of descendants) {
    const s = parsePlainDate(t.start) ?? parsePlainDate(t.due)
    if (s) {
      hasDatedSubtasks = true
      if (!minDate || Temporal.PlainDate.compare(s, minDate) < 0) minDate = s
    }
    const d = parsePlainDate(t.due) ?? parsePlainDate(t.start)
    if (d) {
      hasDatedSubtasks = true
      if (!maxDate || Temporal.PlainDate.compare(d, maxDate) > 0) maxDate = d
    }
    const bs = parsePlainDate(t.baselineStart ?? '') ?? parsePlainDate(t.baselineDue ?? '')
    if (bs && (!minBase || Temporal.PlainDate.compare(bs, minBase) < 0)) minBase = bs
    const bd = parsePlainDate(t.baselineDue ?? '') ?? parsePlainDate(t.baselineStart ?? '')
    if (bd && (!maxBase || Temporal.PlainDate.compare(bd, maxBase) > 0)) maxBase = bd
  }

  // Also factor in the parent's own explicit dates if set
  const parentStart = parsePlainDate(task.start) ?? parsePlainDate(task.due)
  if (parentStart && (!minDate || Temporal.PlainDate.compare(parentStart, minDate) < 0)) {
    minDate = parentStart
  }
  const parentDue = parsePlainDate(task.due) ?? parsePlainDate(task.start)
  if (parentDue && (!maxDate || Temporal.PlainDate.compare(parentDue, maxDate) > 0)) {
    maxDate = parentDue
  }
  const parentBaseStart = parsePlainDate(task.baselineStart ?? '') ?? parsePlainDate(task.baselineDue ?? '')
  if (parentBaseStart && (!minBase || Temporal.PlainDate.compare(parentBaseStart, minBase) < 0)) {
    minBase = parentBaseStart
  }
  const parentBaseDue = parsePlainDate(task.baselineDue ?? '') ?? parsePlainDate(task.baselineStart ?? '')
  if (parentBaseDue && (!maxBase || Temporal.PlainDate.compare(parentBaseDue, maxBase) > 0)) {
    maxBase = parentBaseDue
  }

  // Aggregated progress: average of descendant progress values
  let progress = task.progress
  if (totalSubtasks > 0) {
    const sumProgress = descendants.reduce((sum, t) => {
      if (isTerminalStatus(t.status, statuses)) return sum + 100
      return sum + Math.max(0, Math.min(100, t.progress || 0))
    }, 0)
    progress = Math.round(sumProgress / totalSubtasks)
  }

  return {
    taskId: task.id,
    hasSubtasks: true,
    hasDatedSubtasks,
    start: minDate ? minDate.toString() : '',
    due: maxDate ? maxDate.toString() : '',
    ...(minBase ? { baselineStart: minBase.toString() } : {}),
    ...(maxBase ? { baselineDue: maxBase.toString() } : {}),
    totalSubtasks,
    doneSubtasks,
    progress
  }
}
