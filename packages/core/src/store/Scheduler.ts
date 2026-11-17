import { Temporal } from '../dates'
import { DEFAULT_WORKING_WEEKDAYS, type StatusConfig, type Task } from '../types'
import { isTerminalStatus } from '../utils'
import { flattenTasks } from './TaskTreeOps'

export interface SchedulePatch {
  taskId: string
  start: string // YYYY-MM-DD
  due: string // YYYY-MM-DD
}

export interface ScheduleResult {
  patches: SchedulePatch[]
  cycles: string[][]
}

export interface ScheduleOptions {
  workdaysOnly?: boolean
  workingWeekdays?: readonly number[]
  holidays?: readonly string[]
  extraWorkdays?: readonly string[]
}

interface WorkdayCalendar {
  workdaysOnly: boolean
  workingWeekdays: ReadonlySet<number>
  holidays: ReadonlySet<string>
  extraWorkdays: ReadonlySet<string>
}

const MAX_WORKDAY_SCAN = 3650

export function isWorkingDay(date: Temporal.PlainDate, calendar: WorkdayCalendar): boolean {
  if (!calendar.workdaysOnly) return true
  const iso = date.toString()
  if (calendar.extraWorkdays.has(iso)) return true
  if (calendar.holidays.has(iso)) return false
  return calendar.workingWeekdays.has(date.dayOfWeek)
}

function snapForwardToWorkday(date: Temporal.PlainDate, calendar: WorkdayCalendar): Temporal.PlainDate {
  let cur = date
  for (let i = 0; i < MAX_WORKDAY_SCAN && !isWorkingDay(cur, calendar); i++) {
    cur = cur.add({ days: 1 })
  }
  return cur
}

export function stepWorkingDays(date: Temporal.PlainDate, delta: number, calendar: WorkdayCalendar): Temporal.PlainDate {
  if (!calendar.workdaysOnly) return date.add({ days: delta })
  if (delta === 0) return snapForwardToWorkday(date, calendar)
  const step = delta > 0 ? 1 : -1
  let remaining = Math.abs(delta)
  let cur = date
  for (let i = 0; i < MAX_WORKDAY_SCAN && remaining > 0; i++) {
    cur = cur.add({ days: step })
    if (isWorkingDay(cur, calendar)) remaining--
  }
  return cur
}

function countWorkingDaysInclusive(start: Temporal.PlainDate, due: Temporal.PlainDate, calendar: WorkdayCalendar): number {
  if (!calendar.workdaysOnly) return Math.max(1, start.until(due, { largestUnit: 'days' }).days + 1)
  let count = 0
  let cur = start
  while (Temporal.PlainDate.compare(cur, due) <= 0) {
    if (isWorkingDay(cur, calendar)) count++
    cur = cur.add({ days: 1 })
  }
  return Math.max(1, count)
}

function workingDaysBetween(a: Temporal.PlainDate, b: Temporal.PlainDate, calendar: WorkdayCalendar): number {
  if (!calendar.workdaysOnly) return b.since(a, { largestUnit: 'days' }).days
  const cmp = Temporal.PlainDate.compare(a, b)
  if (cmp === 0) return 0
  if (cmp > 0) return -workingDaysBetween(b, a, calendar)
  let count = 0
  let cur = a.add({ days: 1 })
  while (Temporal.PlainDate.compare(cur, b) <= 0) {
    if (isWorkingDay(cur, calendar)) count++
    cur = cur.add({ days: 1 })
  }
  return count
}

export function daysBetween(a: string, b: string): number {
  return Temporal.PlainDate.from(b).since(Temporal.PlainDate.from(a), { largestUnit: 'days' }).days
}

export function addDays(date: string, n: number): string {
  return Temporal.PlainDate.from(date).add({ days: n }).toString()
}

/** Predecessor id -> ids of the tasks waiting on it. */
export function dependentsFromTasks(tasks: Task[]): Map<string, string[]> {
  const dependentsOf = new Map<string, string[]>()
  for (const ft of flattenTasks(tasks)) {
    for (const depId of ft.task.dependencies) {
      const list = dependentsOf.get(depId)
      if (list) list.push(ft.task.id)
      else dependentsOf.set(depId, [ft.task.id])
    }
  }
  return dependentsOf
}

/** Can `fromId` reach `toId` by following dependents? */
export function reaches(dependentsOf: Map<string, string[]>, fromId: string, toId: string): boolean {
  const visited = new Set<string>()
  const queue = [fromId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    if (current === toId) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of dependentsOf.get(current) ?? []) {
      queue.push(next)
    }
  }
  return false
}

/**
 * Would making `from` depend on `to` close a cycle? "from depends on to" is the edge
 * to -> from, so yes exactly when `from` can already reach `to`.
 */
export function wouldCreateCycle(tasks: Task[], fromId: string, toId: string): boolean {
  return reaches(dependentsFromTasks(tasks), fromId, toId)
}

function resolveDependencyId(depId: string, taskById: Map<string, Task>): string | null {
  const visited = new Set<string>()
  let current = taskById.get(depId)
  while (current?.status === 'superseded') {
    if (visited.has(current.id) || !current.replacedBy) return null
    visited.add(current.id)
    current = taskById.get(current.replacedBy)
  }
  return current?.id ?? null
}

/**
 * Date patches derived from the dependency graph. `changed` scopes the pass to the
 * downstream dependents of the task ids it names. Terminal-status tasks never move;
 * their dates are a record of what happened.
 *
 * With `pullForward`, a predecessor that finished early counts as ending on its
 * completion date and its dependents move up by the days saved, keeping their existing
 * slack and never starting before the day after a predecessor ends.
 */
export function computeSchedule(
  tasks: Task[],
  /** The tasks whose dates just moved. Absent reschedules the whole tree. */
  changed?: string | string[],
  statuses: StatusConfig[] = [],
  pullForward = false,
  /** Predecessors in other projects. They constrain dates here but are never moved. */
  externals: Task[] = [],
  options: ScheduleOptions = {}
): ScheduleResult {
  const weekdays = new Set(options.workingWeekdays ?? DEFAULT_WORKING_WEEKDAYS)
  const extraWorkdays = new Set(options.extraWorkdays ?? [])
  const calendar: WorkdayCalendar = {
    workdaysOnly: options.workdaysOnly === true && (weekdays.size > 0 || extraWorkdays.size > 0),
    workingWeekdays: weekdays,
    holidays: new Set(options.holidays ?? []),
    extraWorkdays
  }
  const externalIds = new Set(externals.map((t) => t.id))
  const flat = [...flattenTasks(tasks).map((ft) => ft.task), ...externals]
  const taskById = new Map<string, Task>()
  const dependentsOf = new Map<string, string[]>()
  const predecessorsOf = new Map<string, string[]>()

  for (const t of flat) {
    taskById.set(t.id, t)
  }

  for (const t of flat) {
    const validDeps = new Set<string>()
    for (const depId of t.dependencies) {
      const resolvedId = resolveDependencyId(depId, taskById)
      if (!resolvedId) continue
      validDeps.add(resolvedId)
    }
    const normalizedDeps = [...validDeps]
    predecessorsOf.set(t.id, normalizedDeps)
    for (const depId of normalizedDeps) {
      const list = dependentsOf.get(depId) ?? []
      list.push(t.id)
      dependentsOf.set(depId, list)
    }
  }

  const seeds = changed === undefined ? [] : typeof changed === 'string' ? [changed] : changed
  let scopeIds: Set<string> | null = null
  if (seeds.length > 0) {
    scopeIds = new Set<string>()
    const queue = [...seeds]
    while (queue.length > 0) {
      const id = queue.shift()
      if (id === undefined) break
      if (scopeIds.has(id)) continue
      scopeIds.add(id)
      for (const depId of dependentsOf.get(id) ?? []) {
        queue.push(depId)
      }
    }
  }

  // Kahn's algorithm: topological sort, with the leftovers being the cycles.
  const inDegree = new Map<string, number>()
  const relevantIds = scopeIds ? [...scopeIds] : flat.map((t) => t.id)

  const scope = scopeIds
  for (const id of relevantIds) {
    const deps = predecessorsOf.get(id) ?? []
    const filtered = scope ? deps.filter((d) => scope.has(d)) : deps
    inDegree.set(id, filtered.length)
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const topoOrder: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    topoOrder.push(id)
    for (const depId of dependentsOf.get(id) ?? []) {
      const currentDeg = inDegree.get(depId)
      if (currentDeg === undefined) continue
      const newDeg = currentDeg - 1
      inDegree.set(depId, newDeg)
      if (newDeg === 0) queue.push(depId)
    }
  }

  const sortedSet = new Set(topoOrder)
  const cycleIds = relevantIds.filter((id) => !sortedSet.has(id))
  const cycles: string[][] = cycleIds.length > 0 ? [cycleIds] : []

  // Mutable copies of the dates, so a shift cascades within this run.
  const startOf = new Map<string, string>()
  const dueOf = new Map<string, string>()
  // Days by which a task's finish beat the date it was planned for.
  const daysSavedBy = new Map<string, number>()
  for (const t of flat) {
    startOf.set(t.id, t.start)
    dueOf.set(t.id, t.due)
    if (!pullForward || !t.completed || !t.due || t.completed >= t.due) continue
    // An external's completion date was stamped against its own project's palette, not
    // the one passed here, so its status can't be re-checked from this side.
    if (!externalIds.has(t.id) && !isTerminalStatus(t.status, statuses)) continue
    dueOf.set(t.id, t.completed)
    daysSavedBy.set(
      t.id,
      workingDaysBetween(Temporal.PlainDate.from(t.completed), Temporal.PlainDate.from(t.due), calendar)
    )
  }

  const patches: SchedulePatch[] = []

  for (const id of topoOrder) {
    const task = taskById.get(id)
    if (!task) continue

    if (externalIds.has(id)) continue
    if (isTerminalStatus(task.status, statuses)) continue

    const deps = predecessorsOf.get(id) ?? []
    if (deps.length === 0) continue

    // Latest due among unarchived predecessors; `latestPlannedDue` is the same
    // date had every one of them finished on plan.
    let latestDue = ''
    let latestPlannedDue = ''
    for (const depId of deps) {
      const dep = taskById.get(depId)
      if (dep?.archived) continue
      const depDue = dueOf.get(depId) ?? ''
      if (!depDue) continue
      if (!latestDue || depDue > latestDue) latestDue = depDue
      const plannedDue = stepWorkingDays(
        Temporal.PlainDate.from(depDue),
        daysSavedBy.get(depId) ?? 0,
        calendar
      ).toString()
      if (!latestPlannedDue || plannedDue > latestPlannedDue) latestPlannedDue = plannedDue
    }
    if (!latestDue) continue

    const earliestStartDate = stepWorkingDays(Temporal.PlainDate.from(latestDue), 1, calendar)
    const earliestStart = earliestStartDate.toString()
    const daysSaved = workingDaysBetween(
      Temporal.PlainDate.from(latestDue),
      Temporal.PlainDate.from(latestPlannedDue),
      calendar
    )
    const currentStart = startOf.get(id) ?? ''
    const currentDue = dueOf.get(id) ?? ''

    const pullBy = (anchor: string) =>
      Math.min(
        daysSaved,
        Math.max(0, workingDaysBetween(earliestStartDate, Temporal.PlainDate.from(anchor), calendar))
      )

    let newStart = currentStart
    let newDue = currentDue
    let pulled = 0

    const isMilestone = task.type === 'milestone' || (!currentStart && currentDue)

    if (isMilestone) {
      // A milestone has no span, so its due date moves instead of its start.
      if (!currentDue || currentDue < earliestStart) {
        newDue = earliestStart
      } else if (daysSaved > 0) {
        pulled = pullBy(currentDue)
        newDue = stepWorkingDays(Temporal.PlainDate.from(currentDue), -pulled, calendar).toString()
      }
    } else if (currentStart && currentDue) {
      const startDate = Temporal.PlainDate.from(currentStart)
      const dueDate = Temporal.PlainDate.from(currentDue)
      const duration = countWorkingDaysInclusive(startDate, dueDate, calendar)
      if (currentStart < earliestStart) {
        newStart = earliestStart
        newDue = stepWorkingDays(earliestStartDate, duration - 1, calendar).toString()
      } else if (daysSaved > 0) {
        pulled = pullBy(currentStart)
        const pulledStart = stepWorkingDays(startDate, -pulled, calendar)
        newStart = pulledStart.toString()
        newDue = stepWorkingDays(pulledStart, duration - 1, calendar).toString()
      }
    } else if (currentStart && !currentDue) {
      if (currentStart < earliestStart) {
        newStart = earliestStart
      } else if (daysSaved > 0) {
        pulled = pullBy(currentStart)
        newStart = stepWorkingDays(Temporal.PlainDate.from(currentStart), -pulled, calendar).toString()
      }
    } else {
      newStart = earliestStart
    }

    if (newStart !== currentStart || newDue !== currentDue) {
      startOf.set(id, newStart)
      dueOf.set(id, newDue)
      if (pulled > 0) daysSavedBy.set(id, pulled)
      patches.push({ taskId: id, start: newStart, due: newDue })
    }
  }

  return { patches, cycles }
}
