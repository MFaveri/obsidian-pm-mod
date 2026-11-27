import { Temporal, formatDateShort, parsePlainDate, today } from '../dates'
import type { Project, ResolvedProjectConfig, Task } from '../types'
import { isTerminalStatus } from '../utils'
import { computeBaselineVariance, computeScheduleHealth, scheduleOptionsFor } from './Scheduler'
import { excludeSupersededTasks } from './TaskFilter'
import { flattenTasks, totalLoggedHours } from './TaskTreeOps'
import { computeScopeWorkload } from './Workload'

export type ChartWindowMode = 'rolling12' | 'full'

export interface ProjectChartsOptions {
  today?: string
  holidays?: readonly string[]
  externalTasks?: Task[]
  window?: ChartWindowMode
}

export interface WeeklyWorkloadBucket {
  weekStart: string
  weekEnd: string
  label: string
  isCurrentWeek: boolean
  activeTotal: number
  activeOnTrack: number
  activeAtRisk: number
  doneInWeek: number
  overloadDays: number
  byAssignee: Record<string, number>
  taskIds: string[]
}

export interface AssigneeChartRow {
  assignee: string
  isUnassigned: boolean
  total: number
  done: number
  activeOnTrack: number
  overdue: number
  critical: number
  maxConcurrentTasks: number
  overloadDaysCount: number
  estimatedHours: number
  loggedHours: number
  taskIds: string[]
  activeTaskIds: string[]
}

export interface BurnupPoint {
  weekStart: string
  weekEnd: string
  label: string
  isFuture: boolean
  totalScope: number
  plannedDue: number
  baselinePlannedDue: number | null
  actualCompleted: number | null
}

export type SlackBucketKey = 'overdue' | 'critical' | 'nearCritical' | 'comfortable' | 'unscheduled'

export interface SlackBucket {
  key: SlackBucketKey
  count: number
  taskIds: string[]
}

export interface BaselineVarianceItem {
  taskId: string
  title: string
  baselineDue: string
  currentDue: string
  deltaDays: number
  done: boolean
}

export interface EffortAssigneeRow {
  assignee: string
  isUnassigned: boolean
  estimatedHours: number
  loggedHours: number
  utilizationPct: number
}

export interface ProjectChartsSummary {
  totalTasks: number
  doneTasks: number
  activeTasks: number
  overdueTasks: number
  criticalTasks: number
  durationRiskCount: number
  overloadedAssignees: number
  overloadedDaysTotal: number
  estimatedHours: number
  loggedHours: number
  completionPct: number
  hasBaseline: boolean
  hasEffort: boolean
  projectedFinish: string
}

export interface ProjectChartsData {
  summary: ProjectChartsSummary
  weeklyHistogram: WeeklyWorkloadBucket[]
  histogramAssignees: string[]
  peakWeeklyActive: number
  assigneeDistribution: AssigneeChartRow[]
  burnup: {
    points: BurnupPoint[]
    paceDelta: number
    hasBaseline: boolean
  }
  slackProfile: {
    buckets: SlackBucket[]
    totalActive: number
  }
  baselineVariance: {
    trackedCount: number
    aheadCount: number
    onTimeCount: number
    lateCount: number
    avgDeltaDays: number
    maxSlipDays: number
    items: BaselineVarianceItem[]
  }
  effortByAssignee: EffortAssigneeRow[]
  taskLookup: Map<string, Task>
}

export const UNASSIGNED_KEY = '__unassigned__'

function mondayOf(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 })
}

function parseDatePrefix(raw: string | undefined): Temporal.PlainDate | null {
  if (!raw) return null
  return parsePlainDate(raw.slice(0, 10))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Computes chart-ready analytical datasets for a single project's dedicated Charts view.
 */
export function computeProjectCharts(
  project: Project,
  config: ResolvedProjectConfig,
  options: ProjectChartsOptions = {}
): ProjectChartsData {
  const todayDate = (options.today ? parsePlainDate(options.today) : null) ?? today()
  const todayIso = todayDate.toString()
  const currentWeekStart = mondayOf(todayDate)
  const holidays = [...(options.holidays ?? [])]
  const windowMode = options.window ?? 'rolling12'

  const flatTasks = flattenTasks(excludeSupersededTasks(project.tasks))
    .map((entry) => entry.task)
    .filter((task) => !task.archived)

  const taskLookup = new Map<string, Task>()
  for (const task of flatTasks) {
    taskLookup.set(task.id, task)
  }

  const schedOpts = scheduleOptionsFor(config, holidays)
  const health = computeScheduleHealth(project.tasks, config, holidays, options.externalTasks ?? [])
  const workload = computeScopeWorkload(project.tasks, config.statuses, {
    workingWeekdays: config.workingWeekdays,
    holidays,
    extraWorkdays: config.extraWorkdays,
    extraNonWorkdays: config.extraNonWorkdays
  })

  const criticalSet = new Set(health.criticalPath.criticalTaskIds)
  const durationRiskSet = new Set(health.durationRisks.map((item) => item.task.id))
  const workloadByName = new Map(workload.assignees.map((item) => [item.assignee, item]))

  let doneTasks = 0
  let overdueTasks = 0
  let totalEstimated = 0
  let totalLogged = 0

  for (const task of flatTasks) {
    const done = isTerminalStatus(task.status, config.statuses)
    if (done) doneTasks++
    if (!done && task.due && task.due < todayIso) overdueTasks++
    if (typeof task.timeEstimate === 'number' && task.timeEstimate > 0) totalEstimated += task.timeEstimate
    totalLogged += totalLoggedHours(task)
  }

  const totalTasks = flatTasks.length
  const activeTasks = totalTasks - doneTasks
  const completionPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0
  const hasBaseline = health.baselineTrackedCount > 0
  const hasEffort = totalEstimated > 0 || totalLogged > 0

  // --- 1. Weekly Activity Histogram ---
  const scheduledWindows: { task: Task; start: Temporal.PlainDate; end: Temporal.PlainDate; done: boolean }[] = []
  let earliestSchedWeek: Temporal.PlainDate | null = null
  let latestSchedWeek: Temporal.PlainDate | null = null

  for (const task of flatTasks) {
    const startP = parsePlainDate(task.start)
    const dueP = parsePlainDate(task.due)
    const s = startP ?? dueP
    const d = dueP ?? startP
    if (!s || !d) continue
    const first = Temporal.PlainDate.compare(s, d) <= 0 ? s : d
    const last = Temporal.PlainDate.compare(s, d) <= 0 ? d : s
    const done = isTerminalStatus(task.status, config.statuses)
    scheduledWindows.push({ task, start: first, end: last, done })

    const wStart = mondayOf(first)
    const wEnd = mondayOf(last)
    if (!earliestSchedWeek || Temporal.PlainDate.compare(wStart, earliestSchedWeek) < 0) {
      earliestSchedWeek = wStart
    }
    if (!latestSchedWeek || Temporal.PlainDate.compare(wEnd, latestSchedWeek) > 0) {
      latestSchedWeek = wEnd
    }
  }

  const histogramStartWeek = resolveHistogramStart(windowMode, currentWeekStart, earliestSchedWeek, latestSchedWeek)
  const histogramWeekCount = resolveHistogramCount(windowMode, histogramStartWeek, currentWeekStart, latestSchedWeek)

  const assigneeCountForLegend = new Map<string, number>()
  const weeklyHistogram: WeeklyWorkloadBucket[] = []

  for (let i = 0; i < histogramWeekCount; i++) {
    const wStart = histogramStartWeek.add({ weeks: i })
    const wEnd = wStart.add({ days: 6 })
    const wStartIso = wStart.toString()
    const wEndIso = wEnd.toString()

    let activeOnTrack = 0
    let activeAtRisk = 0
    let doneInWeek = 0
    const byAssignee: Record<string, number> = {}
    const taskIds: string[] = []

    for (const entry of scheduledWindows) {
      const overlaps =
        Temporal.PlainDate.compare(entry.start, wEnd) <= 0 && Temporal.PlainDate.compare(entry.end, wStart) >= 0
      if (!overlaps) continue

      if (!entry.done) {
        taskIds.push(entry.task.id)
        const isOverdue = Boolean(entry.task.due && entry.task.due < todayIso)
        const atRisk =
          isOverdue ||
          criticalSet.has(entry.task.id) ||
          durationRiskSet.has(entry.task.id) ||
          workload.overloadedTaskIds.has(entry.task.id)
        if (atRisk) activeAtRisk++
        else activeOnTrack++

        const owners = entry.task.assignees.length > 0 ? entry.task.assignees : [UNASSIGNED_KEY]
        for (const rawOwner of owners) {
          const owner = rawOwner.trim() || UNASSIGNED_KEY
          byAssignee[owner] = (byAssignee[owner] ?? 0) + 1
          assigneeCountForLegend.set(owner, (assigneeCountForLegend.get(owner) ?? 0) + 1)
        }
      }
    }

    for (const task of flatTasks) {
      if (!isTerminalStatus(task.status, config.statuses)) continue
      const doneDate = parseDatePrefix(task.completed) ?? parsePlainDate(task.due)
      if (!doneDate) continue
      if (Temporal.PlainDate.compare(doneDate, wStart) >= 0 && Temporal.PlainDate.compare(doneDate, wEnd) <= 0) {
        doneInWeek++
      }
    }

    let overloadDays = 0
    for (let d = 0; d < 7; d++) {
      if (workload.overloadedDates.has(wStart.add({ days: d }).toString())) overloadDays++
    }

    weeklyHistogram.push({
      weekStart: wStartIso,
      weekEnd: wEndIso,
      label: formatDateShort(wStartIso),
      isCurrentWeek: Temporal.PlainDate.compare(wStart, currentWeekStart) === 0,
      activeTotal: activeOnTrack + activeAtRisk,
      activeOnTrack,
      activeAtRisk,
      doneInWeek,
      overloadDays,
      byAssignee,
      taskIds
    })
  }

  const histogramAssignees = Array.from(assigneeCountForLegend.entries())
    .sort((a, b) => {
      if (a[0] === UNASSIGNED_KEY) return 1
      if (b[0] === UNASSIGNED_KEY) return -1
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
    .map(([name]) => name)

  const peakWeeklyActive = weeklyHistogram.reduce((max, b) => Math.max(max, b.activeTotal), 0)

  // --- 2. Task & Workload Distribution by Assignee ---
  const assigneeMap = new Map<string, AssigneeChartRow>()
  const ensureAssigneeRow = (key: string): AssigneeChartRow => {
    const existing = assigneeMap.get(key)
    if (existing) return existing
    const wl = key === UNASSIGNED_KEY ? undefined : workloadByName.get(key)
    const row: AssigneeChartRow = {
      assignee: key,
      isUnassigned: key === UNASSIGNED_KEY,
      total: 0,
      done: 0,
      activeOnTrack: 0,
      overdue: 0,
      critical: 0,
      maxConcurrentTasks: wl?.maxConcurrentTasks ?? 0,
      overloadDaysCount: wl?.overloadDaysCount ?? 0,
      estimatedHours: 0,
      loggedHours: 0,
      taskIds: [],
      activeTaskIds: []
    }
    assigneeMap.set(key, row)
    return row
  }

  for (const task of flatTasks) {
    const owners = task.assignees.map((a) => a.trim()).filter(Boolean)
    const targetKeys = owners.length > 0 ? owners : [UNASSIGNED_KEY]
    const done = isTerminalStatus(task.status, config.statuses)
    const isOverdue = !done && Boolean(task.due && task.due < todayIso)
    const isCrit = !done && criticalSet.has(task.id)
    const est = typeof task.timeEstimate === 'number' && task.timeEstimate > 0 ? task.timeEstimate : 0
    const log = totalLoggedHours(task)

    for (const key of targetKeys) {
      const row = ensureAssigneeRow(key)
      row.total++
      row.taskIds.push(task.id)
      row.estimatedHours += est
      row.loggedHours += log
      if (done) {
        row.done++
      } else {
        row.activeTaskIds.push(task.id)
        if (isOverdue) row.overdue++
        else row.activeOnTrack++
        if (isCrit) row.critical++
      }
    }
  }

  const assigneeDistribution = Array.from(assigneeMap.values())
    .map((row) => ({
      ...row,
      estimatedHours: round1(row.estimatedHours),
      loggedHours: round1(row.loggedHours)
    }))
    .sort((a, b) => {
      if (a.isUnassigned !== b.isUnassigned) return a.isUnassigned ? 1 : -1
      const activeA = a.overdue + a.activeOnTrack
      const activeB = b.overdue + b.activeOnTrack
      if (activeB !== activeA) return activeB - activeA
      if (b.total !== a.total) return b.total - a.total
      return a.assignee.localeCompare(b.assignee)
    })

  // --- 3. Burn-up Curve (Scope vs Planned vs Actual) ---
  const burnup = computeBurnup(flatTasks, config, todayDate, hasBaseline)

  // --- 4. CPM Slack & Schedule Risk Profile ---
  const bucketMap: Record<SlackBucketKey, string[]> = {
    overdue: [],
    critical: [],
    nearCritical: [],
    comfortable: [],
    unscheduled: []
  }

  for (const task of flatTasks) {
    if (isTerminalStatus(task.status, config.statuses)) continue
    if (task.due && task.due < todayIso) {
      bucketMap.overdue.push(task.id)
      continue
    }
    const cpm = health.criticalPath.tasks[task.id]
    if (!cpm) {
      bucketMap.unscheduled.push(task.id)
    } else if (cpm.critical || cpm.slackDays === 0) {
      bucketMap.critical.push(task.id)
    } else if (cpm.slackDays <= 3) {
      bucketMap.nearCritical.push(task.id)
    } else {
      bucketMap.comfortable.push(task.id)
    }
  }

  const slackBuckets: SlackBucket[] = (
    ['overdue', 'critical', 'nearCritical', 'comfortable', 'unscheduled'] as SlackBucketKey[]
  ).map((key) => ({
    key,
    count: bucketMap[key].length,
    taskIds: bucketMap[key]
  }))

  // --- 5. Baseline Variance ---
  const varianceItems: BaselineVarianceItem[] = []
  let deltaSum = 0
  for (const task of flatTasks) {
    const variance = computeBaselineVariance(task, schedOpts)
    if (!variance) continue
    deltaSum += variance.dueDeltaDays
    varianceItems.push({
      taskId: task.id,
      title: task.title,
      baselineDue: variance.baselineDue,
      currentDue: task.due,
      deltaDays: variance.dueDeltaDays,
      done: isTerminalStatus(task.status, config.statuses)
    })
  }
  varianceItems.sort((a, b) => Math.abs(b.deltaDays) - Math.abs(a.deltaDays) || b.deltaDays - a.deltaDays)

  // --- 6. Effort by Assignee ---
  const effortByAssignee: EffortAssigneeRow[] = assigneeDistribution
    .filter((row) => row.estimatedHours > 0 || row.loggedHours > 0)
    .map((row) => ({
      assignee: row.assignee,
      isUnassigned: row.isUnassigned,
      estimatedHours: row.estimatedHours,
      loggedHours: row.loggedHours,
      utilizationPct:
        row.estimatedHours > 0
          ? Math.round((row.loggedHours / row.estimatedHours) * 100)
          : row.loggedHours > 0
            ? 100
            : 0
    }))
    .sort((a, b) => Math.max(b.estimatedHours, b.loggedHours) - Math.max(a.estimatedHours, a.loggedHours))

  return {
    summary: {
      totalTasks,
      doneTasks,
      activeTasks,
      overdueTasks,
      criticalTasks: health.criticalTasks.length,
      durationRiskCount: health.durationRisks.length,
      overloadedAssignees: workload.totalOverloadedAssignees,
      overloadedDaysTotal: workload.overloadedDates.size,
      estimatedHours: round1(totalEstimated),
      loggedHours: round1(totalLogged),
      completionPct,
      hasBaseline,
      hasEffort,
      projectedFinish: health.criticalPath.projectFinish
    },
    weeklyHistogram,
    histogramAssignees,
    peakWeeklyActive,
    assigneeDistribution,
    burnup,
    slackProfile: {
      buckets: slackBuckets,
      totalActive: activeTasks
    },
    baselineVariance: {
      trackedCount: health.baselineTrackedCount,
      aheadCount: health.baselineAheadCount,
      onTimeCount: health.baselineOnTimeCount,
      lateCount: health.baselineLateCount,
      avgDeltaDays: varianceItems.length > 0 ? round1(deltaSum / varianceItems.length) : 0,
      maxSlipDays: health.maxBaselineSlipDays,
      items: varianceItems.slice(0, 12)
    },
    effortByAssignee,
    taskLookup
  }
}

function resolveHistogramStart(
  mode: ChartWindowMode,
  currentWeek: Temporal.PlainDate,
  earliestWeek: Temporal.PlainDate | null,
  latestWeek: Temporal.PlainDate | null
): Temporal.PlainDate {
  if (!earliestWeek || !latestWeek) return currentWeek.subtract({ weeks: 2 })
  if (mode === 'full') return earliestWeek
  const rollingStart = currentWeek.subtract({ weeks: 2 })
  const rollingEnd = rollingStart.add({ weeks: 11 })
  // If project dates don't overlap the rolling window at all, center on the project range instead of empty weeks
  const overlapsRolling =
    Temporal.PlainDate.compare(earliestWeek, rollingEnd) <= 0 &&
    Temporal.PlainDate.compare(latestWeek, rollingStart) >= 0
  return overlapsRolling ? rollingStart : earliestWeek
}

function resolveHistogramCount(
  mode: ChartWindowMode,
  startWeek: Temporal.PlainDate,
  currentWeek: Temporal.PlainDate,
  latestWeek: Temporal.PlainDate | null
): number {
  if (!latestWeek) return 12
  if (mode === 'rolling12') return 12
  const endWeek = Temporal.PlainDate.compare(latestWeek, currentWeek) >= 0 ? latestWeek : currentWeek
  const weeks = Math.floor(startWeek.until(endWeek, { largestUnit: 'day' }).days / 7) + 1
  return Math.max(4, Math.min(weeks, 36))
}

function computeBurnup(
  tasks: Task[],
  config: ResolvedProjectConfig,
  todayDate: Temporal.PlainDate,
  hasBaseline: boolean
): ProjectChartsData['burnup'] {
  if (tasks.length === 0) {
    return { points: [], paceDelta: 0, hasBaseline }
  }

  let minDate: Temporal.PlainDate | null = null
  let maxDate: Temporal.PlainDate | null = null
  const currentWeekStart = mondayOf(todayDate)

  const recordDate = (d: Temporal.PlainDate | null): void => {
    if (!d) return
    if (!minDate || Temporal.PlainDate.compare(d, minDate) < 0) minDate = d
    if (!maxDate || Temporal.PlainDate.compare(d, maxDate) > 0) maxDate = d
  }

  const parsedTasks = tasks.map((task) => {
    const done = isTerminalStatus(task.status, config.statuses)
    const created = parseDatePrefix(task.createdAt) ?? parsePlainDate(task.start) ?? parsePlainDate(task.due)
    const start = parsePlainDate(task.start)
    const due = parsePlainDate(task.due) ?? start
    const baseDue = task.baselineDue ? parsePlainDate(task.baselineDue) : null
    const completed = done
      ? (parseDatePrefix(task.completed) ?? parseDatePrefix(task.updatedAt) ?? due ?? todayDate)
      : null

    recordDate(start)
    recordDate(due)
    recordDate(baseDue)
    recordDate(completed)
    recordDate(created)
    return { done, created, due, baseDue, completed }
  })

  const startBase = minDate ?? todayDate
  const endBase = maxDate ?? todayDate
  const startWeek = mondayOf(startBase)
  const rawEndWeek = mondayOf(Temporal.PlainDate.compare(endBase, todayDate) >= 0 ? endBase : todayDate)

  const totalWeeks = Math.max(1, Math.floor(startWeek.until(rawEndWeek, { largestUnit: 'day' }).days / 7) + 1)
  const stepWeeks = totalWeeks > 24 ? Math.ceil(totalWeeks / 24) : 1

  const points: BurnupPoint[] = []
  let todayPlanned = 0
  let todayActual = 0

  for (let w = 0; w < totalWeeks; w += stepWeeks) {
    const wStart = startWeek.add({ weeks: w })
    const wEnd = wStart.add({ weeks: stepWeeks - 1, days: 6 })
    const wEndIso = wEnd.toString()
    const wStartIso = wStart.toString()
    const isFuture = Temporal.PlainDate.compare(wStart, currentWeekStart) > 0

    let totalScope = 0
    let plannedDue = 0
    let baselinePlannedDue = 0
    let actualCompleted = 0

    for (const item of parsedTasks) {
      if (!item.created || Temporal.PlainDate.compare(item.created, wEnd) <= 0) {
        totalScope++
      }
      if (item.due && Temporal.PlainDate.compare(item.due, wEnd) <= 0) {
        plannedDue++
      }
      if (hasBaseline && item.baseDue && Temporal.PlainDate.compare(item.baseDue, wEnd) <= 0) {
        baselinePlannedDue++
      }
      if (!isFuture && item.completed && Temporal.PlainDate.compare(item.completed, wEnd) <= 0) {
        actualCompleted++
      }
    }

    if (!isFuture) {
      todayPlanned = plannedDue
      todayActual = actualCompleted
    }

    points.push({
      weekStart: wStartIso,
      weekEnd: wEndIso,
      label: formatDateShort(wStartIso),
      isFuture,
      totalScope,
      plannedDue,
      baselinePlannedDue: hasBaseline ? baselinePlannedDue : null,
      actualCompleted: isFuture ? null : actualCompleted
    })
  }

  return {
    points,
    paceDelta: todayActual - todayPlanned,
    hasBaseline
  }
}
