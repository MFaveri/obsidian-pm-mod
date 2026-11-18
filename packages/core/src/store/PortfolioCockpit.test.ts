import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIORITIES, DEFAULT_STATUSES, type Project, type ResolvedProjectConfig, type Task } from '../types'
import { buildTaskIndex } from './TaskIndex'
import { computePortfolioCockpit } from './PortfolioCockpit'

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
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...partial
  }
}

function makeProject(partial: Partial<Project>): Project {
  const tasks = partial.tasks ?? []
  return {
    id: 'p-1',
    title: 'Project Alpha',
    description: '',
    color: '#7c3aed',
    icon: '🚀',
    tasks,
    customFields: [],
    teamMembers: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    filePath: 'Projects/Alpha/Alpha.md',
    savedViews: [],
    taskIndex: buildTaskIndex(tasks),
    ...partial
  }
}

describe('computePortfolioCockpit', () => {
  it('computes portfolio KPIs, focus queue, milestones, and cross-project workload', () => {
    const p1 = makeProject({
      id: 'p1',
      title: 'Alpha',
      filePath: 'Alpha.md',
      tasks: [
        makeTask({
          id: 't1',
          title: 'Setup DB',
          status: 'done',
          start: '2026-11-10',
          due: '2026-11-12',
          assignees: ['Alice']
        }),
        makeTask({
          id: 't2',
          title: 'Build API',
          status: 'in-progress',
          priority: 'high',
          start: '2026-11-16',
          due: '2026-11-17', // overdue relative to 2026-11-18
          durationDays: 5, // duration risk!
          dependencies: ['t1'],
          assignees: ['Alice']
        }),
        makeTask({
          id: 'm1',
          title: 'v1.0 Launch',
          type: 'milestone',
          due: '2026-11-25'
        })
      ]
    })

    const p2 = makeProject({
      id: 'p2',
      title: 'Beta',
      filePath: 'Beta.md',
      tasks: [
        makeTask({
          id: 't3',
          title: 'Design UI',
          status: 'todo',
          start: '2026-11-16',
          due: '2026-11-20',
          assignees: ['Alice'] // overlaps with t2 across projects on Nov 16-17!
        }),
        makeTask({
          id: 't4',
          title: 'Blocked by UI',
          status: 'todo',
          start: '2026-11-23',
          due: '2026-11-25',
          dependencies: ['t3']
        })
      ]
    })

    const cockpit = computePortfolioCockpit([
      { project: p1, config: CONFIG },
      { project: p2, config: CONFIG }
    ])

    expect(cockpit.metrics.projectCount).toBe(2)
    expect(cockpit.metrics.totalTasks).toBe(5)
    expect(cockpit.metrics.doneTasks).toBe(1)
    expect(cockpit.metrics.overallProgress).toBe(20)
    expect(cockpit.metrics.durationRiskCount).toBe(1)
    expect(cockpit.metrics.overloadedAssigneesCount).toBe(1)
    expect(cockpit.overloadedAssignees[0].assignee).toBe('Alice')

    // Focus queue puts t2 (overdue + duration risk + unblocked) first
    expect(cockpit.focusTasks[0]?.task.id).toBe('t2')
    expect(cockpit.focusTasks[0]?.isBlocked).toBe(false)
    expect(cockpit.focusTasks[0]?.hasDurationRisk).toBe(true)

    // Milestones include v1.0 Launch
    expect(cockpit.upcomingMilestones.map((m) => m.task.id)).toEqual(['m1'])

    // Card for Alpha is critical due to duration risk / overdue
    const alphaCard = cockpit.cards.get('Alpha.md')
    expect(alphaCard?.health).toBe('critical')
    expect(alphaCard?.nextMilestone?.task.id).toBe('m1')
    expect(alphaCard?.nextSteps.map((s) => s.task.id)).toEqual(['t2'])

    // Card for Beta lists t3 (unblocked) before t4 (blocked)
    const betaCard = cockpit.cards.get('Beta.md')
    expect(betaCard?.nextSteps.map((s) => s.task.id)).toEqual(['t3', 't4'])
    expect(betaCard?.nextSteps[0]?.isBlocked).toBe(false)
    expect(betaCard?.nextSteps[1]?.isBlocked).toBe(true)
  })
})
