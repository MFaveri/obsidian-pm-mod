import { parsePlainDate, Temporal, today } from '../dates'
import {
  DEFAULT_COCKPIT_FOCUS_LIMIT,
  type DueUrgency,
  type Project,
  type ResolvedProjectConfig,
  type StatusConfig,
  type Task
} from '../types'
import { compareTiers, dateUrgency, isTerminalStatus, normalizeTier } from '../utils'
import { computeScheduleHealth } from './Scheduler'
import { excludeSupersededTasks } from './TaskFilter'
import { flattenTasks } from './TaskTreeOps'
import { type AssigneeWorkload, computeScopeWorkload } from './Workload'

export interface PortfolioProjectEntry {
  project: Project
  config: ResolvedProjectConfig
}

export type ProjectHealthStatus = 'healthy' | 'warning' | 'critical'

export interface PortfolioMetrics {
  projectCount: number
  totalTasks: number
  doneTasks: number
  overallProgress: number
  overdueTasks: number
  criticalTasks: number
  durationRiskCount: number
  baselineLateCount: number
  overloadedAssigneesCount: number
}

export interface PortfolioFocusTask {
  task: Task
  project: Project
  config: ResolvedProjectConfig
  isCritical: boolean
  slackDays: number | null
  hasDurationRisk: boolean
  shortfallDays: number
  urgency: DueUrgency
  isBlocked: boolean
  score: number
}

export interface PortfolioMilestone {
  task: Task
  project: Project
  due: string
  daysFromToday: number
  urgency: DueUrgency
}

export interface PortfolioNextStep {
  task: Task
  isCritical: boolean
  hasDurationRisk: boolean
  isBlocked: boolean
  urgency: DueUrgency
}

export interface ProjectCockpitCard {
  project: Project
  config: ResolvedProjectConfig
  done: number
  total: number
  progress: number
  overdue: number
  criticalCount: number
  durationRiskCount: number
  baselineLateCount: number
  projectedFinish: string
  health: ProjectHealthStatus
  nextMilestone: PortfolioMilestone | null
  nextSteps: PortfolioNextStep[]
}

export interface PortfolioTaskLookup {
  task: Task
  project: Project
}

export interface PortfolioCockpitResult {
  metrics: PortfolioMetrics
  focusTasks: PortfolioFocusTask[]
  totalFocusCount: number
  upcomingMilestones: PortfolioMilestone[]
  overloadedAssignees: AssigneeWorkload[]
  cards: Map<string, ProjectCockpitCard>
  taskLookup: Map<string, PortfolioTaskLookup>
}

export interface PortfolioCockpitOptions {
  holidays?: readonly string[]
  focusLimit?: number
  tiers?: readonly string[]
}

const MAX_MILESTONES = 6
const MAX_NEXT_STEPS_PER_PROJECT = 3

function tierBoost(rawTier: string | undefined, configuredTiers?: readonly string[]): number {
  const tier = normalizeTier(rawTier)
  if (configuredTiers?.length) {
    const idx = configuredTiers.indexOf(tier)
    if (idx !== -1) return Math.max(0, 160 - idx * 35)
  }
  const match = /^tier-(\d+)$/i.exec(tier)
  if (match) return Math.max(0, 160 - Number(match[1]) * 35)
  return 0
}

function priorityBoost(priority: string): number {
  switch (priority) {
    case 'urgent':
    case 'critical':
      return 60
    case 'high':
      return 40
    case 'medium':
      return 20
    default:
      return 0
  }
}

export function computePortfolioCockpit(
  entries: PortfolioProjectEntry[],
  holidaysOrOptions: readonly string[] | PortfolioCockpitOptions = []
): PortfolioCockpitResult {
  const options: PortfolioCockpitOptions = Array.isArray(holidaysOrOptions)
    ? { holidays: holidaysOrOptions }
    : (holidaysOrOptions as PortfolioCockpitOptions)
  const holidays = options.holidays ?? []
  const focusLimit = options.focusLimit ?? DEFAULT_COCKPIT_FOCUS_LIMIT
  const configuredTiers = options.tiers
  const now = today()
  const knownIds = new Set<string>()
  const completedIds = new Set<string>()
  const taskLookup = new Map<string, PortfolioTaskLookup>()

  // First pass: index all tasks across projects to resolve cross-project dependencies and lookups
  for (const { project, config } of entries) {
    const flat = flattenTasks(excludeSupersededTasks(project.tasks))
    for (const { task } of flat) {
      if (task.archived) continue
      knownIds.add(task.id)
      taskLookup.set(task.id, { task, project })
      if (isTerminalStatus(task.status, config.statuses)) {
        completedIds.add(task.id)
      }
    }
  }

  let totalTasks = 0
  let doneTasks = 0
  let overdueTasks = 0
  let criticalTasks = 0
  let durationRiskCount = 0
  let baselineLateCount = 0

  const allFocusCandidates: PortfolioFocusTask[] = []
  const allMilestones: PortfolioMilestone[] = []
  const cards = new Map<string, ProjectCockpitCard>()
  const combinedTasksForWorkload: Task[] = []
  const combinedStatuses: StatusConfig[] = []
  const seenStatusIds = new Set<string>()

  for (const { project, config } of entries) {
    for (const st of config.statuses) {
      if (!seenStatusIds.has(st.id)) {
        seenStatusIds.add(st.id)
        combinedStatuses.push(st)
      }
    }
    combinedTasksForWorkload.push(...project.tasks)

    const health = computeScheduleHealth(project.tasks, config, [...holidays])
    const riskByTaskId = new Map<string, number>()
    for (const r of health.durationRisks) {
      riskByTaskId.set(r.task.id, r.risk.shortfallDays)
    }

    const flat = flattenTasks(excludeSupersededTasks(project.tasks))
      .map((f) => f.task)
      .filter((t) => !t.archived)

    let projDone = 0
    let projTotal = 0
    let projOverdue = 0
    const projectMilestones: PortfolioMilestone[] = []
    const projectStepCandidates: { step: PortfolioNextStep; score: number; due: string }[] = []

    for (const task of flat) {
      projTotal++
      totalTasks++
      const complete = isTerminalStatus(task.status, config.statuses)
      if (complete) {
        projDone++
        doneTasks++
        continue
      }

      const dueDate = parsePlainDate(task.due)
      const isOverdue = !!dueDate && Temporal.PlainDate.compare(dueDate, now) < 0
      if (isOverdue) {
        projOverdue++
        overdueTasks++
      }

      const urgency = dateUrgency(task.due, true)

      if (task.type === 'milestone' && dueDate) {
        const daysFromToday = now.until(dueDate, { largestUnit: 'day' }).days
        const ms: PortfolioMilestone = {
          task,
          project,
          due: task.due,
          daysFromToday,
          urgency
        }
        projectMilestones.push(ms)
        allMilestones.push(ms)
        continue
      }

      // Actionable work items: prefer leaf tasks (no subtasks)
      if (task.subtasks.length > 0) continue

      const cpmInfo = health.criticalPath.tasks[task.id]
      const isCritical = cpmInfo?.critical === true
      const slackDays = cpmInfo ? cpmInfo.slackDays : null
      const shortfallDays = riskByTaskId.get(task.id) ?? 0
      const hasDurationRisk = shortfallDays > 0
      const isBlocked = task.dependencies.some((depId) => knownIds.has(depId) && !completedIds.has(depId))

      let score = 0
      if (!isBlocked) score += 250
      if (urgency === 'overdue') score += 1000
      else if (urgency === 'near') score += 450
      if (isCritical) score += 500
      if (hasDurationRisk) score += 400
      if (task.progress > 0) score += 150
      score += priorityBoost(task.priority)
      if (dueDate) {
        const daysAway = Math.max(-30, Math.min(90, now.until(dueDate, { largestUnit: 'day' }).days))
        score += 90 - daysAway
      }

      projectStepCandidates.push({
        step: {
          task,
          isCritical,
          hasDurationRisk,
          isBlocked,
          urgency
        },
        score,
        due: task.due
      })

      if (!isBlocked || urgency === 'overdue' || isCritical || hasDurationRisk) {
        allFocusCandidates.push({
          task,
          project,
          config,
          isCritical,
          slackDays,
          hasDurationRisk,
          shortfallDays,
          urgency,
          isBlocked,
          score: score + tierBoost(project.tier, configuredTiers)
        })
      }
    }

    projectMilestones.sort((a, b) => a.due.localeCompare(b.due))
    projectStepCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.due && b.due) return a.due.localeCompare(b.due)
      return a.step.task.title.localeCompare(b.step.task.title)
    })

    const projCriticalCount = health.criticalPath.criticalTaskIds.length
    const projDurationRisks = health.durationRisks.length
    const projBaselineLate = health.baselineLateCount

    criticalTasks += projCriticalCount
    durationRiskCount += projDurationRisks
    baselineLateCount += projBaselineLate

    let healthStatus: ProjectHealthStatus = 'healthy'
    if (projOverdue > 0 || projDurationRisks > 0) {
      healthStatus = 'critical'
    } else if (projBaselineLate > 0 || projCriticalCount > 0) {
      healthStatus = 'warning'
    }

    cards.set(project.filePath, {
      project,
      config,
      done: projDone,
      total: projTotal,
      progress: projTotal > 0 ? Math.round((projDone / projTotal) * 100) : 0,
      overdue: projOverdue,
      criticalCount: projCriticalCount,
      durationRiskCount: projDurationRisks,
      baselineLateCount: projBaselineLate,
      projectedFinish: health.criticalPath.projectFinish,
      health: healthStatus,
      nextMilestone: projectMilestones[0] ?? null,
      nextSteps: projectStepCandidates.slice(0, MAX_NEXT_STEPS_PER_PROJECT).map((c) => c.step)
    })
  }

  allFocusCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const tierCmp = compareTiers(normalizeTier(a.project.tier), normalizeTier(b.project.tier), configuredTiers)
    if (tierCmp !== 0) return tierCmp
    if (a.task.due && b.task.due) return a.task.due.localeCompare(b.task.due)
    return a.task.title.localeCompare(b.task.title)
  })

  allMilestones.sort((a, b) => a.due.localeCompare(b.due))

  const workload = computeScopeWorkload(combinedTasksForWorkload, combinedStatuses, {
    holidays
  })
  const overloadedAssignees = workload.assignees.filter((a) => a.isOverloaded)

  const overallProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0
  const focusTasks = focusLimit > 0 ? allFocusCandidates.slice(0, focusLimit) : allFocusCandidates

  return {
    metrics: {
      projectCount: entries.length,
      totalTasks,
      doneTasks,
      overallProgress,
      overdueTasks,
      criticalTasks,
      durationRiskCount,
      baselineLateCount,
      overloadedAssigneesCount: overloadedAssignees.length
    },
    focusTasks,
    totalFocusCount: allFocusCandidates.length,
    upcomingMilestones: allMilestones.slice(0, MAX_MILESTONES),
    overloadedAssignees,
    cards,
    taskLookup
  }
}
