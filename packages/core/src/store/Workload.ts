import { parsePlainDate, Temporal } from '../dates'
import type { StatusConfig, Task } from '../types'
import { isTerminalStatus } from '../utils'
import { flattenTasks } from './TaskTreeOps'

export interface AssigneeOverloadConflict {
  task1Id: string
  task2Id: string
  overlappingDays: number
}

export interface AssigneeWorkload {
  assignee: string
  activeTaskCount: number
  maxConcurrentTasks: number
  overloadDaysCount: number
  conflicts: AssigneeOverloadConflict[]
  isOverloaded: boolean
}

export interface ScopeWorkloadOptions {
  workingWeekdays?: readonly number[]
  holidays?: readonly string[]
  extraWorkdays?: readonly string[]
  extraNonWorkdays?: readonly string[]
}

export interface ScopeWorkloadResult {
  assignees: AssigneeWorkload[]
  overloadedTaskIds: ReadonlySet<string>
  overloadedDates: ReadonlySet<string>
  totalOverloadedAssignees: number
}

function isWorkday(
  date: Temporal.PlainDate,
  opts: {
    workingWeekdays: readonly number[]
    holidays: readonly string[]
    extraWorkdays: readonly string[]
    extraNonWorkdays: readonly string[]
  }
): boolean {
  const iso = date.toString()
  if (opts.extraNonWorkdays.includes(iso)) return false
  if (opts.extraWorkdays.includes(iso)) return true
  if (opts.holidays.includes(iso)) return false
  return opts.workingWeekdays.includes(date.dayOfWeek)
}

/**
 * Computes workload allocations and detects concurrent task overloads per assignee
 * across active tasks within working days.
 */
export function computeScopeWorkload(
  tasks: Task[],
  statuses: StatusConfig[],
  options: ScopeWorkloadOptions = {}
): ScopeWorkloadResult {
  const workingWeekdays = options.workingWeekdays ?? [1, 2, 3, 4, 5]
  const holidays = options.holidays ?? []
  const extraWorkdays = options.extraWorkdays ?? []
  const extraNonWorkdays = options.extraNonWorkdays ?? []
  const dayOpts = { workingWeekdays, holidays, extraWorkdays, extraNonWorkdays }

  const allFlat = flattenTasks(tasks).map((f) => f.task)
  const activeTasks = allFlat.filter((t) => !t.archived && !t.replacedBy && !isTerminalStatus(t.status, statuses))

  // Map of assignee -> active tasks list
  const tasksByAssignee = new Map<string, Task[]>()
  for (const t of activeTasks) {
    for (const assignee of t.assignees) {
      const clean = assignee.trim()
      if (!clean) continue
      const list = tasksByAssignee.get(clean) ?? []
      list.push(t)
      tasksByAssignee.set(clean, list)
    }
  }

  const overloadedTaskIds = new Set<string>()
  const overloadedDates = new Set<string>()
  const assignees: AssigneeWorkload[] = []
  let totalOverloadedAssignees = 0

  for (const [assignee, userTasks] of tasksByAssignee.entries()) {
    // Map of date ISO string -> Set of task IDs running on that day
    const tasksPerDay = new Map<string, Set<string>>()

    for (const task of userTasks) {
      const startParsed = parsePlainDate(task.start)
      const dueParsed = parsePlainDate(task.due)
      const s = startParsed ?? dueParsed
      const d = dueParsed ?? startParsed
      if (!s || !d) continue

      const first = Temporal.PlainDate.compare(s, d) <= 0 ? s : d
      const last = Temporal.PlainDate.compare(s, d) <= 0 ? d : s

      let cur = first
      while (Temporal.PlainDate.compare(cur, last) <= 0) {
        if (isWorkday(cur, dayOpts)) {
          const iso = cur.toString()
          const set = tasksPerDay.get(iso) ?? new Set<string>()
          set.add(task.id)
          tasksPerDay.set(iso, set)
        }
        cur = cur.add({ days: 1 })
      }
    }

    let overloadDaysCount = 0
    let maxConcurrentTasks = 0
    const conflictMap = new Map<string, { task1Id: string; task2Id: string; count: number }>()

    for (const [iso, taskSet] of tasksPerDay.entries()) {
      const count = taskSet.size
      if (count > maxConcurrentTasks) maxConcurrentTasks = count
      if (count >= 2) {
        overloadDaysCount++
        overloadedDates.add(iso)
        const ids = Array.from(taskSet)
        for (const id of ids) overloadedTaskIds.add(id)
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`
            const existing = conflictMap.get(key)
            if (existing) {
              existing.count++
            } else {
              conflictMap.set(key, {
                task1Id: ids[i] < ids[j] ? ids[i] : ids[j],
                task2Id: ids[i] < ids[j] ? ids[j] : ids[i],
                count: 1
              })
            }
          }
        }
      }
    }

    const conflicts: AssigneeOverloadConflict[] = Array.from(conflictMap.values()).map((c) => ({
      task1Id: c.task1Id,
      task2Id: c.task2Id,
      overlappingDays: c.count
    }))

    const isOverloaded = overloadDaysCount > 0
    if (isOverloaded) totalOverloadedAssignees++

    assignees.push({
      assignee,
      activeTaskCount: userTasks.length,
      maxConcurrentTasks,
      overloadDaysCount,
      conflicts,
      isOverloaded
    })
  }

  // Sort assignees: overloaded first, then by active task count desc, then alphabetically
  assignees.sort((a, b) => {
    if (a.isOverloaded !== b.isOverloaded) return a.isOverloaded ? -1 : 1
    if (b.activeTaskCount !== a.activeTaskCount) return b.activeTaskCount - a.activeTaskCount
    return a.assignee.localeCompare(b.assignee)
  })

  return {
    assignees,
    overloadedTaskIds,
    overloadedDates,
    totalOverloadedAssignees
  }
}
