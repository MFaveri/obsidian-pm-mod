import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES, type Project, type ResolvedProjectConfig, type Task } from '../types'
import { buildTaskIndex } from './TaskIndex'
import { UNASSIGNED_KEY, computeProjectCharts } from './ProjectCharts'

const CONFIG: ResolvedProjectConfig = {
  statuses: DEFAULT_STATUSES,
  priorities: DEFAULT_PRIORITIES,
  priorityIcons: 'chevrons',
  customFields: [],
  defaultView: 'table',
  autoSchedule: false,
  pullForwardOnEarlyFinish: false,
  scheduleWorkdaysOnly: true,
  workingWeekdays: [1, 2, 3, 4, 5],
  extraWorkdays: [],
  extraNonWorkdays: [],
  autoArchiveDays: 0,
  showSubtreeConnections: true,
  lineBorders: 'none'
}

function makeTask(partial: Partial<Task>): Task {
  return {
    id: 't-1',
    title: 'Task',
    description: '',
    type: 'task',
    status: 'todo',
    priority: 'medium',
    start: '',
    due: '',
    progress: 0,
    completed: '',
    assignees: [],
    tags: [],
    subtasks: [],
    dependencies: [],
    customFields: {},
    createdAt: '2026-11-02',
    updatedAt: '2026-11-02',
    ...partial
  }
}

function makeProject(tasks: Task[]): Project {
  return {
    id: 'p-1',
    title: 'Project Alpha',
    description: '',
    color: '#3b82f6',
    icon: '🚀',
    tasks,
    customFields: [],
    teamMembers: ['Alice', 'Bob'],
    createdAt: '2026-11-01',
    updatedAt: '2026-11-01',
    filePath: 'Projects/Alpha/Alpha.md',
    savedViews: [],
    taskIndex: buildTaskIndex(tasks)
  }
}

describe('computeProjectCharts', () => {
  it('handles empty projects cleanly', () => {
    const project = makeProject([])
    const result = computeProjectCharts(project, CONFIG, { today: '2026-11-18' })
    expect(result.summary.totalTasks).toBe(0)
    expect(result.summary.completionPct).toBe(0)
    expect(result.weeklyHistogram.length).toBe(12)
    expect(result.assigneeDistribution).toEqual([])
    expect(result.burnup.points).toEqual([])
    expect(result.slackProfile.totalActive).toBe(0)
  })

  it('computes histogram, assignee workload, slack profile, burnup, baseline variance, and effort', () => {
    const tasks: Task[] = [
      makeTask({
        id: 'done-1',
        title: 'Kickoff',
        status: 'done',
        start: '2026-11-02',
        due: '2026-11-06',
        baselineStart: '2026-11-02',
        baselineDue: '2026-11-06',
        completed: '2026-11-05',
        createdAt: '2026-11-01',
        assignees: ['Alice'],
        timeEstimate: 8,
        timeLogs: [{ date: '2026-11-05', hours: 6, note: 'work' }]
      }),
      makeTask({
        id: 'overdue-1',
        title: 'Spec signoff',
        status: 'in-progress',
        start: '2026-11-09',
        due: '2026-11-13',
        baselineStart: '2026-11-09',
        baselineDue: '2026-11-11',
        createdAt: '2026-11-02',
        assignees: ['Alice'],
        timeEstimate: 10,
        timeLogs: [{ date: '2026-11-10', hours: 12, note: 'extra' }]
      }),
      makeTask({
        id: 'crit-1',
        title: 'Core build',
        status: 'in-progress',
        start: '2026-11-16',
        due: '2026-11-27',
        baselineStart: '2026-11-16',
        baselineDue: '2026-11-25',
        createdAt: '2026-11-03',
        assignees: ['Alice'],
        dependencies: ['done-1']
      }),
      makeTask({
        id: 'overlap-1',
        title: 'Parallel review',
        status: 'todo',
        start: '2026-11-16',
        due: '2026-11-20',
        createdAt: '2026-11-09',
        assignees: ['Alice']
      }),
      makeTask({
        id: 'comfort-1',
        title: 'Docs draft',
        status: 'todo',
        start: '2026-11-16',
        due: '2026-11-18',
        createdAt: '2026-11-10',
        assignees: ['Bob'],
        timeEstimate: 4
      }),
      makeTask({
        id: 'unsched-1',
        title: 'Backlog idea',
        status: 'todo',
        createdAt: '2026-11-12',
        assignees: []
      })
    ]

    const project = makeProject(tasks)
    const charts = computeProjectCharts(project, CONFIG, {
      today: '2026-11-18',
      window: 'rolling12'
    })

    // Summary
    expect(charts.summary.totalTasks).toBe(6)
    expect(charts.summary.doneTasks).toBe(1)
    expect(charts.summary.activeTasks).toBe(5)
    expect(charts.summary.overdueTasks).toBe(1)
    expect(charts.summary.completionPct).toBe(17)
    expect(charts.summary.overloadedAssignees).toBe(1) // Alice has crit-1 + overlap-1 simultaneously
    expect(charts.summary.overloadedDaysTotal).toBeGreaterThan(0)
    expect(charts.summary.hasBaseline).toBe(true)
    expect(charts.summary.hasEffort).toBe(true)
    expect(charts.summary.estimatedHours).toBe(22)
    expect(charts.summary.loggedHours).toBe(18)

    // Weekly histogram (current week starts Monday 2026-11-16)
    const currentBucket = charts.weeklyHistogram.find((b) => b.isCurrentWeek)
    expect(currentBucket).toBeDefined()
    expect(currentBucket?.weekStart).toBe('2026-11-16')
    expect(currentBucket?.activeTotal).toBe(3) // crit-1, overlap-1, comfort-1
    expect(currentBucket?.overloadDays).toBeGreaterThan(0)
    expect(currentBucket?.byAssignee['Alice']).toBe(2)
    expect(currentBucket?.byAssignee['Bob']).toBe(1)

    // Assignee distribution
    const alice = charts.assigneeDistribution.find((a) => a.assignee === 'Alice')
    const bob = charts.assigneeDistribution.find((a) => a.assignee === 'Bob')
    const unassigned = charts.assigneeDistribution.find((a) => a.assignee === UNASSIGNED_KEY)
    expect(alice?.total).toBe(4)
    expect(alice?.done).toBe(1)
    expect(alice?.overdue).toBe(1)
    expect(alice?.activeOnTrack).toBe(2)
    expect(alice?.overloadDaysCount).toBeGreaterThan(0)
    expect(bob?.total).toBe(1)
    expect(unassigned?.isUnassigned).toBe(true)
    expect(unassigned?.total).toBe(1)

    // Slack profile
    const overdueBucket = charts.slackProfile.buckets.find((b) => b.key === 'overdue')
    const criticalBucket = charts.slackProfile.buckets.find((b) => b.key === 'critical')
    const unschedBucket = charts.slackProfile.buckets.find((b) => b.key === 'unscheduled')
    expect(overdueBucket?.count).toBe(1)
    expect(criticalBucket?.count).toBeGreaterThanOrEqual(1)
    expect(unschedBucket?.count).toBe(1)

    // Baseline variance
    expect(charts.baselineVariance.trackedCount).toBe(3)
    expect(charts.baselineVariance.lateCount).toBe(2)
    expect(charts.baselineVariance.onTimeCount).toBe(1)
    expect(charts.baselineVariance.maxSlipDays).toBeGreaterThanOrEqual(2)

    // Burnup
    expect(charts.burnup.hasBaseline).toBe(true)
    expect(charts.burnup.points.length).toBeGreaterThanOrEqual(3)
    const futurePoints = charts.burnup.points.filter((p) => p.isFuture)
    for (const fp of futurePoints) {
      expect(fp.actualCompleted).toBeNull()
    }
    const pastPoints = charts.burnup.points.filter((p) => !p.isFuture)
    expect(pastPoints.length).toBeGreaterThan(0)
    expect(pastPoints[pastPoints.length - 1].actualCompleted).toBe(1)

    // Effort
    const aliceEffort = charts.effortByAssignee.find((e) => e.assignee === 'Alice')
    expect(aliceEffort?.estimatedHours).toBe(18)
    expect(aliceEffort?.loggedHours).toBe(18)
    expect(aliceEffort?.utilizationPct).toBe(100)
  })
})
