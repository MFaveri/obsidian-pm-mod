import { Temporal, parsePlainDate } from '../dates'
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
  extraNonWorkdays?: readonly string[]
}

export interface CriticalPathOptions extends ScheduleOptions {
  pullForward?: boolean
}

export interface CriticalPathTaskInfo {
  taskId: string
  earlyStart: string
  earlyFinish: string
  lateStart: string
  lateFinish: string
  /** Total slack in working days (or calendar days when workdaysOnly is false). */
  slackDays: number
  critical: boolean
}

export interface CriticalPathResult {
  projectFinish: string
  tasks: Record<string, CriticalPathTaskInfo>
  criticalTaskIds: string[]
  /** Driving dependency pairs [fromId, toId] between active critical tasks with zero gap. */
  criticalEdges: [string, string][]
  cycles: string[][]
}

export interface BaselineVariance {
  baselineStart: string
  baselineDue: string
  startDeltaDays: number
  dueDeltaDays: number
}

/**
 * Compares a task's current scheduled start/due against its captured baseline.
 * Positive deltas mean slipped later than planned; negative deltas mean ahead.
 */
export function computeBaselineVariance(task: Task, options: ScheduleOptions = {}): BaselineVariance | null {
  const bStart = parsePlainDate(task.baselineStart ?? '') ?? parsePlainDate(task.baselineDue ?? '')
  const bDue = parsePlainDate(task.baselineDue ?? '') ?? parsePlainDate(task.baselineStart ?? '')
  if (!bStart || !bDue) return null

  const calendar = buildWorkdayCalendar(options)
  const curStart = parsePlainDate(task.start) ?? parsePlainDate(task.due)
  const curDue = parsePlainDate(task.due) ?? parsePlainDate(task.start)
  const startDeltaDays = curStart ? workingDaysBetween(bStart, curStart, calendar) : 0
  const dueDeltaDays = curDue ? workingDaysBetween(bDue, curDue, calendar) : 0
  return {
    baselineStart: bStart.toString(),
    baselineDue: bDue.toString(),
    startDeltaDays,
    dueDeltaDays
  }
}

interface WorkdayCalendar {
  workdaysOnly: boolean
  workingWeekdays: ReadonlySet<number>
  holidays: ReadonlySet<string>
  extraWorkdays: ReadonlySet<string>
  extraNonWorkdays: ReadonlySet<string>
}

const MAX_WORKDAY_SCAN = 3650

export function isWorkingDay(date: Temporal.PlainDate, calendar: WorkdayCalendar): boolean {
  if (!calendar.workdaysOnly) return true
  const iso = date.toString()
  if (calendar.extraNonWorkdays.has(iso)) return false
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

function buildWorkdayCalendar(options: ScheduleOptions = {}): WorkdayCalendar {
  const workingWeekdays = new Set(options.workingWeekdays ?? DEFAULT_WORKING_WEEKDAYS)
  const extraWorkdays = new Set(options.extraWorkdays ?? [])
  return {
    workdaysOnly: options.workdaysOnly === true && (workingWeekdays.size > 0 || extraWorkdays.size > 0),
    workingWeekdays,
    holidays: new Set(options.holidays ?? []),
    extraWorkdays,
    extraNonWorkdays: new Set(options.extraNonWorkdays ?? [])
  }
}

const MAX_OVERRIDE_RANGE_DAYS = 366

/**
 * Expands a single date or inclusive date range into ISO dates to add as workday/day-off overrides.
 * Single dates are always returned verbatim; multi-day ranges pick only active workdays for
 * `extraNonWorkdays` (vacations/PTO) or non-working days for `extraWorkdays` (falling back to all
 * dates in range when none match).
 */
export function expandDateRangeOverrides(
  startIso: string,
  endIso: string,
  kind: 'extraWorkdays' | 'extraNonWorkdays',
  options: ScheduleOptions = {}
): string[] {
  const rawStart = parsePlainDate(startIso)
  if (!rawStart) return []
  const rawEnd = parsePlainDate(endIso || startIso) ?? rawStart
  const [from, to] = Temporal.PlainDate.compare(rawStart, rawEnd) <= 0 ? [rawStart, rawEnd] : [rawEnd, rawStart]
  if (Temporal.PlainDate.compare(from, to) === 0) return [from.toString()]

  const calendar = buildWorkdayCalendar({ ...options, workdaysOnly: true })
  const all: string[] = []
  const matched: string[] = []
  let cur = from
  for (let i = 0; i < MAX_OVERRIDE_RANGE_DAYS && Temporal.PlainDate.compare(cur, to) <= 0; i++) {
    const iso = cur.toString()
    all.push(iso)
    const working = isWorkingDay(cur, calendar)
    if ((kind === 'extraNonWorkdays' && working) || (kind === 'extraWorkdays' && !working)) {
      matched.push(iso)
    }
    cur = cur.add({ days: 1 })
  }
  return matched.length ? matched : all
}

interface DependencyGraph {
  taskById: Map<string, Task>
  predecessorsOf: Map<string, string[]>
  dependentsOf: Map<string, string[]>
}

function buildDependencyGraph(flat: Task[]): DependencyGraph {
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

  return { taskById, predecessorsOf, dependentsOf }
}

function topoSortGraph(
  relevantIds: string[],
  graph: DependencyGraph,
  scopeIds: Set<string> | null
): { topoOrder: string[]; cycles: string[][] } {
  const inDegree = new Map<string, number>()
  for (const id of relevantIds) {
    const deps = graph.predecessorsOf.get(id) ?? []
    const filtered = scopeIds ? deps.filter((d) => scopeIds.has(d)) : deps
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
    for (const depId of graph.dependentsOf.get(id) ?? []) {
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
  return { topoOrder, cycles }
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
  const calendar = buildWorkdayCalendar(options)
  const externalIds = new Set(externals.map((t) => t.id))
  const flat = [...flattenTasks(tasks).map((ft) => ft.task), ...externals]
  const graph = buildDependencyGraph(flat)
  const { taskById, dependentsOf, predecessorsOf } = graph

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

  const relevantIds = scopeIds ? [...scopeIds] : flat.map((t) => t.id)
  const { topoOrder, cycles } = topoSortGraph(relevantIds, graph, scopeIds)

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
      const depDue = dueOf.get(depId) || startOf.get(depId) || ''
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

/**
 * Critical Path Method (CPM) over the current task schedule: forward pass respects
 * each task's scheduled start and predecessor finish + 1 working day; backward pass
 * computes latest dates, total slack (in working days when `workdaysOnly` is set),
 * critical tasks (`slackDays === 0`), and tight driving edges between them.
 *
 * Completed, cancelled, superseded, archived, external, and undated tasks are never
 * flagged critical themselves, though completed and external predecessors still
 * constrain downstream active tasks in the forward pass.
 */
export function computeCriticalPath(
  tasks: Task[],
  statuses: StatusConfig[] = [],
  externals: Task[] = [],
  options: CriticalPathOptions = {}
): CriticalPathResult {
  const calendar = buildWorkdayCalendar(options)
  const externalIds = new Set(externals.map((t) => t.id))
  const flat = [...flattenTasks(tasks).map((ft) => ft.task), ...externals]
  const graph = buildDependencyGraph(flat)
  const { taskById, dependentsOf, predecessorsOf } = graph
  const { topoOrder, cycles } = topoSortGraph(
    flat.map((t) => t.id),
    graph,
    null
  )

  const earlyStartMap = new Map<string, Temporal.PlainDate>()
  const earlyFinishMap = new Map<string, Temporal.PlainDate>()
  const durationMap = new Map<string, number>()
  const activeDatedOrder: string[] = []
  let projectFinishDate: Temporal.PlainDate | null = null

  for (const id of topoOrder) {
    const task = taskById.get(id)
    if (!task || task.archived || task.status === 'superseded') continue

    const parsedStart = parsePlainDate(task.start)
    const parsedDue = parsePlainDate(task.due)
    const schedStart = parsedStart ?? parsedDue
    if (!schedStart) continue
    const rawDue = parsedDue ?? schedStart
    const schedDue = Temporal.PlainDate.compare(rawDue, schedStart) < 0 ? schedStart : rawDue

    const isExternal = externalIds.has(id)
    const isTerminal = !isExternal && isTerminalStatus(task.status, statuses)
    if (isExternal || isTerminal) {
      const earlyCompleted =
        options.pullForward && task.completed && task.due && task.completed < task.due
          ? parsePlainDate(task.completed)
          : null
      earlyStartMap.set(id, schedStart)
      earlyFinishMap.set(id, earlyCompleted ?? schedDue)
      continue
    }

    const isMilestone = task.type === 'milestone' || (!task.start && !!task.due)
    const duration = isMilestone ? 1 : countWorkingDaysInclusive(schedStart, schedDue, calendar)

    let minStartFromPreds: Temporal.PlainDate | null = null
    for (const depId of predecessorsOf.get(id) ?? []) {
      const depTask = taskById.get(depId)
      if (!depTask || depTask.archived || depTask.status === 'superseded') continue
      const depFinish = earlyFinishMap.get(depId)
      if (!depFinish) continue
      const nextStart = stepWorkingDays(depFinish, 1, calendar)
      if (!minStartFromPreds || Temporal.PlainDate.compare(nextStart, minStartFromPreds) > 0) {
        minStartFromPreds = nextStart
      }
    }

    let earlyStart: Temporal.PlainDate
    let earlyFinish: Temporal.PlainDate
    if (minStartFromPreds && Temporal.PlainDate.compare(minStartFromPreds, schedStart) > 0) {
      earlyStart = minStartFromPreds
      earlyFinish = duration === 1 ? earlyStart : stepWorkingDays(earlyStart, duration - 1, calendar)
    } else {
      earlyStart = schedStart
      earlyFinish = isMilestone ? earlyStart : schedDue
    }

    earlyStartMap.set(id, earlyStart)
    earlyFinishMap.set(id, earlyFinish)
    durationMap.set(id, duration)
    activeDatedOrder.push(id)

    if (!projectFinishDate || Temporal.PlainDate.compare(earlyFinish, projectFinishDate) > 0) {
      projectFinishDate = earlyFinish
    }
  }

  if (!projectFinishDate) {
    return { projectFinish: '', tasks: {}, criticalTaskIds: [], criticalEdges: [], cycles }
  }

  const lateStartMap = new Map<string, Temporal.PlainDate>()
  const lateFinishMap = new Map<string, Temporal.PlainDate>()
  const slackMap = new Map<string, number>()

  for (let i = activeDatedOrder.length - 1; i >= 0; i--) {
    const id = activeDatedOrder[i]
    let minSuccLateStart: Temporal.PlainDate | null = null
    for (const succId of dependentsOf.get(id) ?? []) {
      const succLateStart = lateStartMap.get(succId)
      if (!succLateStart) continue
      if (!minSuccLateStart || Temporal.PlainDate.compare(succLateStart, minSuccLateStart) < 0) {
        minSuccLateStart = succLateStart
      }
    }

    const earlyStart = earlyStartMap.get(id)
    const earlyFinish = earlyFinishMap.get(id)
    if (!earlyStart || !earlyFinish) continue
    let lateFinish = minSuccLateStart ? stepWorkingDays(minSuccLateStart, -1, calendar) : projectFinishDate
    const slackDays = Math.max(0, workingDaysBetween(earlyFinish, lateFinish, calendar))

    let lateStart: Temporal.PlainDate
    if (slackDays === 0) {
      lateFinish = earlyFinish
      lateStart = earlyStart
    } else {
      if (Temporal.PlainDate.compare(lateFinish, earlyFinish) < 0) {
        lateFinish = earlyFinish
      }
      const duration = durationMap.get(id) ?? 1
      lateStart = duration === 1 ? lateFinish : stepWorkingDays(lateFinish, -(duration - 1), calendar)
    }

    lateStartMap.set(id, lateStart)
    lateFinishMap.set(id, lateFinish)
    slackMap.set(id, slackDays)
  }

  const infoById: Record<string, CriticalPathTaskInfo> = {}
  const criticalTaskIds: string[] = []
  const criticalSet = new Set<string>()

  for (const id of activeDatedOrder) {
    const earlyStart = earlyStartMap.get(id)
    const earlyFinish = earlyFinishMap.get(id)
    const lateStart = lateStartMap.get(id)
    const lateFinish = lateFinishMap.get(id)
    if (!earlyStart || !earlyFinish || !lateStart || !lateFinish) continue
    const slackDays = slackMap.get(id) ?? 0
    const critical = slackDays === 0
    if (critical) {
      criticalTaskIds.push(id)
      criticalSet.add(id)
    }
    infoById[id] = {
      taskId: id,
      earlyStart: earlyStart.toString(),
      earlyFinish: earlyFinish.toString(),
      lateStart: lateStart.toString(),
      lateFinish: lateFinish.toString(),
      slackDays,
      critical
    }
  }

  const criticalEdges: [string, string][] = []
  for (const toId of activeDatedOrder) {
    if (!criticalSet.has(toId)) continue
    const toEarlyStart = earlyStartMap.get(toId)
    if (!toEarlyStart) continue
    for (const fromId of predecessorsOf.get(toId) ?? []) {
      if (!criticalSet.has(fromId)) continue
      const fromEarlyFinish = earlyFinishMap.get(fromId)
      if (!fromEarlyFinish) continue
      const nextAfterPred = stepWorkingDays(fromEarlyFinish, 1, calendar)
      if (Temporal.PlainDate.compare(nextAfterPred, toEarlyStart) >= 0) {
        criticalEdges.push([fromId, toId])
      }
    }
  }

  return {
    projectFinish: projectFinishDate.toString(),
    tasks: infoById,
    criticalTaskIds,
    criticalEdges,
    cycles
  }
}
