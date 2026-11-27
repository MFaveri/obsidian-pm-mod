import {
  type CriticalPathResult,
  type ScheduleOptions,
  type Task,
  type TaskPriority,
  type StatusConfig,
  type PriorityConfig,
  type SortRule,
  computeBaselineVariance,
  displayName,
  locale,
  statusSortOrder
} from '@dotpm/core'

export interface TableSortMetrics {
  criticalPath?: CriticalPathResult
  scheduleOptionsOf?: (taskId: string) => ScheduleOptions
}

/** Compares by each rule in turn; a tie on every rule keeps the stored order. */
export function compareTasks(
  a: Task,
  b: Task,
  sort: SortRule[],
  statuses: StatusConfig[] = [],
  priorities: PriorityConfig[] = [],
  metrics?: TableSortMetrics
): number {
  for (const rule of sort) {
    const result = compareBy(a, b, rule, statuses, priorities, metrics)
    if (result !== 0) return result
  }
  return 0
}

function compareBy(
  a: Task,
  b: Task,
  rule: SortRule,
  statuses: StatusConfig[],
  priorities: PriorityConfig[],
  metrics?: TableSortMetrics
): number {
  const dir = rule.dir === 'asc' ? 1 : -1
  switch (rule.key) {
    case 'title':
      return dir * a.title.localeCompare(b.title, locale())
    case 'status':
      return dir * (statusSortOrder(a.status, statuses) - statusSortOrder(b.status, statuses))
    case 'priority':
      return dir * (priorityOrder(a.priority, priorities) - priorityOrder(b.priority, priorities))
    case 'due':
      return dir * (a.due || 'zzz').localeCompare(b.due || 'zzz')
    case 'assignees':
      return dir * displayName(a.assignees[0] ?? '').localeCompare(displayName(b.assignees[0] ?? ''), locale())
    case 'progress':
      return dir * (a.progress - b.progress)
    case 'duration': {
      const da = a.type !== 'milestone' && a.durationDays ? a.durationDays : Number.MAX_SAFE_INTEGER
      const db = b.type !== 'milestone' && b.durationDays ? b.durationDays : Number.MAX_SAFE_INTEGER
      return dir * (da - db)
    }
    case 'slack': {
      const sa = metrics?.criticalPath?.tasks[a.id]?.slackDays ?? Number.MAX_SAFE_INTEGER
      const sb = metrics?.criticalPath?.tasks[b.id]?.slackDays ?? Number.MAX_SAFE_INTEGER
      return dir * (sa - sb)
    }
    case 'baseline': {
      const va = computeBaselineVariance(a, metrics?.scheduleOptionsOf?.(a.id))?.dueDeltaDays ?? Number.MAX_SAFE_INTEGER
      const vb = computeBaselineVariance(b, metrics?.scheduleOptionsOf?.(b.id))?.dueDeltaDays ?? Number.MAX_SAFE_INTEGER
      return dir * (va - vb)
    }
    default:
      return 0
  }
}

function priorityOrder(p: TaskPriority, priorities: PriorityConfig[]): number {
  const idx = priorities.findIndex((cfg) => cfg.id === p)
  return idx >= 0 ? idx : 999
}
