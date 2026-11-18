import { Menu } from 'obsidian'
import type PMPlugin from '#main'
import {
  type PortfolioCockpitResult,
  type PortfolioFocusTask,
  type PortfolioMilestone,
  type PortfolioNextStep,
  type PortfolioProjectEntry,
  type Project,
  type ProjectCockpitCard,
  type ProjectGroupBy,
  type ProjectListGroup,
  type StatusConfig,
  type Task,
  computePortfolioCockpit,
  formatDateShort,
  t,
  tn
} from '@dotpm/core'
import {
  Avatar,
  Chip,
  CollapseToggle,
  IconButton,
  type MetricStat,
  ProgressBar,
  renderDueChip,
  renderGlyph,
  renderMetricStrip,
  renderStatusDot,
  safeAsync
} from '@dotpm/ui'
import { openTaskModal } from '#ui/ModalFactory'

export interface CockpitRenderContext {
  plugin: PMPlugin
  contentEl: HTMLElement
  groups: ProjectListGroup[]
  groupBy: ProjectGroupBy
  collapsedGroups: Set<string>
  openProject: (path: string) => Promise<void>
  redraw: () => void
}

function groupHeadingLabel(groupBy: ProjectGroupBy, key: string): string {
  if (groupBy === 'tag') return key ? `#${key}` : t('list.noTag')
  return key ? `${key}/` : t('list.noFolder')
}

function openQuickStatusMenu(
  e: MouseEvent,
  plugin: PMPlugin,
  project: Project,
  task: Task,
  statuses: StatusConfig[],
  redraw: () => void
): void {
  e.stopPropagation()
  const menu = new Menu()
  for (const st of statuses) {
    menu.addItem((item) =>
      item
        .setTitle(st.label)
        .setIcon(st.icon || 'circle')
        .setChecked(task.status === st.id)
        .onClick(
          safeAsync(async () => {
            await plugin.store.updateTask(project, task.id, { status: st.id })
            await plugin.store.scheduleAfterChange(project, task.id)
            redraw()
          })
        )
    )
  }
  menu.showAtMouseEvent(e)
}

export async function renderPortfolioCockpit(
  ctx: CockpitRenderContext,
  isStale: () => boolean
): Promise<void> {
  const { plugin, contentEl, groups } = ctx
  const seenPaths = new Set<string>()
  const orderedPaths: string[] = []
  for (const group of groups) {
    for (const row of group.rows) {
      if (!seenPaths.has(row.item.path)) {
        seenPaths.add(row.item.path)
        orderedPaths.push(row.item.path)
      }
    }
  }

  const loaded = await plugin.store.loadProjects(orderedPaths)
  if (isStale()) return

  const entries: PortfolioProjectEntry[] = loaded.map((project) => ({
    project,
    config: plugin.store.configFor(project)
  }))

  const cockpit = computePortfolioCockpit(entries, plugin.settings.holidays)
  contentEl.empty()
  const container = contentEl.createDiv('pm-cockpit')

  renderPortfolioKpis(container, cockpit)
  renderFocusSection(container, cockpit, ctx)
  if (cockpit.upcomingMilestones.length > 0) {
    renderMilestonesSection(container, cockpit.upcomingMilestones, ctx)
  }
  if (cockpit.overloadedAssignees.length > 0) {
    renderCrossProjectWorkloadSection(container, cockpit, ctx)
  }
  renderProjectsGridSection(container, cockpit, ctx)
}

function renderPortfolioKpis(parent: HTMLElement, cockpit: PortfolioCockpitResult): void {
  const { metrics } = cockpit
  const stats: MetricStat[] = [
    {
      label: t('dashboard.portfolioProgress'),
      value: `${metrics.overallProgress}%`,
      sub: t('dashboard.acrossProjects', {
        done: metrics.doneTasks,
        total: metrics.totalTasks,
        projects: metrics.projectCount
      }),
      extra: (el) => {
        new ProgressBar(el).setSize('sm').setValue(metrics.overallProgress)
      }
    },
    {
      label: t('dashboard.attentionNeeded'),
      value: String(metrics.overdueTasks + metrics.criticalTasks),
      sub: t('dashboard.overdueAndCritical', {
        overdue: metrics.overdueTasks,
        critical: metrics.criticalTasks
      }),
      alert: metrics.overdueTasks > 0
    },
    {
      label: t('dashboard.scheduleRisks'),
      value: String(metrics.durationRiskCount + metrics.baselineLateCount),
      sub: t('dashboard.risksSummary', {
        duration: metrics.durationRiskCount,
        baseline: metrics.baselineLateCount
      }),
      alert: metrics.durationRiskCount > 0 || metrics.baselineLateCount > 0
    },
    {
      label: t('dashboard.crossProjectWorkload'),
      value: String(metrics.overloadedAssigneesCount),
      sub:
        metrics.overloadedAssigneesCount > 0
          ? t('dashboard.overloadedMembers', { count: metrics.overloadedAssigneesCount })
          : t('dashboard.allBalanced'),
      alert: metrics.overloadedAssigneesCount > 0
    }
  ]
  renderMetricStrip(parent, stats)
}

function renderFocusSection(
  parent: HTMLElement,
  cockpit: PortfolioCockpitResult,
  ctx: CockpitRenderContext
): void {
  const section = parent.createDiv('pm-cockpit-section')
  const head = section.createDiv('pm-cockpit-section-head')
  head.createSpan({ cls: 'pm-section-label', text: t('dashboard.focusHeading') })
  head.createSpan({ cls: 'pm-overview-note', text: t('dashboard.focusNote') })

  if (cockpit.focusTasks.length === 0) {
    section.createDiv({ cls: 'pm-overview-muted', text: t('dashboard.noFocusTasks') })
    return
  }

  const list = section.createDiv('pm-cockpit-focus-list')
  for (const item of cockpit.focusTasks) {
    renderFocusRow(list, item, ctx)
  }
}

function renderFocusRow(
  parent: HTMLElement,
  item: PortfolioFocusTask,
  ctx: CockpitRenderContext
): void {
  const { task, project, config } = item
  const row = parent.createDiv('pm-cockpit-focus-row')

  const statusBtn = row.createSpan({
    cls: 'pm-cockpit-status-trigger',
    attr: { title: t('dashboard.completeTaskTooltip') }
  })
  renderStatusDot(statusBtn, task.status, config.statuses)
  statusBtn.addEventListener('click', (e) => {
    openQuickStatusMenu(e, ctx.plugin, project, task, config.statuses, ctx.redraw)
  })

  const projBadge = row.createSpan({ cls: 'pm-cockpit-project-pill' })
  renderGlyph(projBadge.createSpan({ cls: 'pm-cockpit-project-pill-icon' }), {
    icon: project.icon,
    color: project.color
  })
  projBadge.createSpan({ cls: 'pm-cockpit-project-pill-text', text: project.title })
  projBadge.addEventListener(
    'click',
    safeAsync((e: MouseEvent) => {
      e.stopPropagation()
      return ctx.openProject(project.filePath)
    })
  )

  const titleEl = row.createSpan({ cls: 'pm-cockpit-focus-title', text: task.title })
  titleEl.addEventListener('click', () => {
    openTaskModal(ctx.plugin, project, {
      task,
      onSave: async () => {
        ctx.redraw()
      }
    })
  })

  const meta = row.createDiv('pm-cockpit-focus-meta')
  if (item.isCritical) {
    new Chip(meta)
      .setLabel(t('table.criticalBadge'))
      .setVariant('solid')
      .setColor('var(--color-red)')
      .setSize('sm')
  }
  if (item.hasDurationRisk) {
    new Chip(meta)
      .setLabel(t('filter.durationRisk'))
      .setVariant('outline')
      .setColor('var(--color-orange, var(--color-red))')
      .setSize('sm')
  }
  if (item.isBlocked) {
    new Chip(meta).setLabel(t('dashboard.blockedBadge')).setVariant('plain').setSize('sm')
  }
  if (task.assignees.length > 0) {
    const avatars = meta.createSpan({ cls: 'pm-cockpit-focus-assignees' })
    for (const assignee of task.assignees.slice(0, 2)) {
      new Avatar(avatars).setName(assignee).setSize('sm')
    }
  }
  if (task.due) {
    renderDueChip(meta, formatDateShort(task.due), item.urgency)
  }
}

function renderMilestonesSection(
  parent: HTMLElement,
  milestones: PortfolioMilestone[],
  ctx: CockpitRenderContext
): void {
  const section = parent.createDiv('pm-cockpit-section')
  const head = section.createDiv('pm-cockpit-section-head')
  head.createSpan({ cls: 'pm-section-label', text: t('dashboard.milestonesHeading') })

  const strip = section.createDiv('pm-cockpit-milestone-strip')
  for (const ms of milestones) {
    const pill = strip.createDiv('pm-cockpit-milestone-card')
    const top = pill.createDiv('pm-cockpit-milestone-top')
    const projTag = top.createSpan({ cls: 'pm-cockpit-milestone-proj' })
    renderGlyph(projTag.createSpan(), { icon: ms.project.icon, color: ms.project.color })
    projTag.createSpan({ text: ms.project.title })
    renderDueChip(top, formatDateShort(ms.due), ms.urgency)

    const title = pill.createDiv({ cls: 'pm-cockpit-milestone-title', text: `◆ ${ms.task.title}` })
    title.addEventListener('click', () => {
      openTaskModal(ctx.plugin, ms.project, {
        task: ms.task,
        onSave: async () => {
          ctx.redraw()
        }
      })
    })
  }
}

function renderCrossProjectWorkloadSection(
  parent: HTMLElement,
  cockpit: PortfolioCockpitResult,
  ctx: CockpitRenderContext
): void {
  const section = parent.createDiv('pm-cockpit-section')
  const head = section.createDiv('pm-cockpit-section-head')
  head.createSpan({ cls: 'pm-section-label', text: t('dashboard.crossProjectWorkload') })

  const list = section.createDiv('pm-overview-workload-list')
  for (const item of cockpit.overloadedAssignees) {
    const card = list.createDiv('pm-overview-workload-card pm-overview-workload-card--alert')
    const cardHead = card.createDiv('pm-overview-workload-head')
    const userBox = cardHead.createDiv('pm-overview-workload-user')
    new Avatar(userBox).setName(item.assignee).setSize('sm')
    userBox.createSpan({ cls: 'pm-overview-workload-name', text: item.assignee })

    const badgeBox = cardHead.createDiv('pm-overview-workload-badge')
    new Chip(badgeBox)
      .setLabel(tn('overview.overloadedDays', item.overloadDaysCount))
      .setVariant('solid')
      .setColor('var(--color-orange, var(--color-red))')
      .setSize('sm')

    if (item.conflicts.length > 0) {
      const conflictBox = card.createDiv('pm-overview-workload-conflicts')
      conflictBox.createSpan({ cls: 'pm-overview-workload-conflict-label', text: t('overview.concurrentTasks') })
      for (const conflict of item.conflicts.slice(0, 3)) {
        const ref1 = cockpit.taskLookup.get(conflict.task1Id)
        const ref2 = cockpit.taskLookup.get(conflict.task2Id)
        if (!ref1 || !ref2) continue
        const row = conflictBox.createDiv('pm-overview-workload-conflict-row')
        const link1 = row.createSpan({
          cls: 'pm-overview-workload-conflict-link',
          text: `${ref1.task.title} (${ref1.project.title})`
        })
        link1.addEventListener('click', () => {
          openTaskModal(ctx.plugin, ref1.project, {
            task: ref1.task,
            onSave: async () => {
              ctx.redraw()
            }
          })
        })
        row.createSpan({ text: ' ↔ ' })
        const link2 = row.createSpan({
          cls: 'pm-overview-workload-conflict-link',
          text: `${ref2.task.title} (${ref2.project.title})`
        })
        link2.addEventListener('click', () => {
          openTaskModal(ctx.plugin, ref2.project, {
            task: ref2.task,
            onSave: async () => {
              ctx.redraw()
            }
          })
        })
      }
    }
  }
}

function renderProjectsGridSection(
  parent: HTMLElement,
  cockpit: PortfolioCockpitResult,
  ctx: CockpitRenderContext
): void {
  const section = parent.createDiv('pm-cockpit-section')
  const head = section.createDiv('pm-cockpit-section-head')
  head.createSpan({ cls: 'pm-section-label', text: t('dashboard.projectsHeading') })

  for (const group of ctx.groups) {
    const collapsed = group.key !== null && ctx.collapsedGroups.has(group.key)
    if (group.key !== null) {
      const key = group.key
      const groupBar = section.createDiv('pm-cockpit-group-bar')
      new CollapseToggle(groupBar, {
        collapsed,
        subject: groupHeadingLabel(ctx.groupBy, key),
        onToggle: () => {
          if (collapsed) ctx.collapsedGroups.delete(key)
          else ctx.collapsedGroups.add(key)
          ctx.redraw()
        }
      })
      groupBar.createSpan({ cls: 'pm-project-group-label', text: groupHeadingLabel(ctx.groupBy, key) })
      groupBar.createSpan({ cls: 'pm-project-group-count', text: String(group.count) })
    }
    if (collapsed) continue

    const grid = section.createDiv('pm-cockpit-grid')
    for (const row of group.rows) {
      const cardData = cockpit.cards.get(row.item.path)
      if (!cardData) continue
      renderProjectCard(grid, cardData, ctx)
    }
  }
}

function renderProjectCard(
  parent: HTMLElement,
  card: ProjectCockpitCard,
  ctx: CockpitRenderContext
): void {
  const { project, config } = card
  const el = parent.createDiv(`pm-cockpit-card pm-cockpit-card--${card.health}`)

  // Card Header
  const head = el.createDiv('pm-cockpit-card-head')
  const titleWrap = head.createDiv('pm-cockpit-card-title-wrap')
  renderGlyph(titleWrap.createSpan({ cls: 'pm-cockpit-card-icon' }), {
    icon: project.icon,
    color: project.color
  })
  const titleEl = titleWrap.createSpan({ cls: 'pm-cockpit-card-title', text: project.title })
  titleEl.addEventListener(
    'click',
    safeAsync(() => ctx.openProject(project.filePath))
  )

  const actions = head.createDiv('pm-cockpit-card-actions')
  renderHealthChip(actions, card.health)

  new IconButton(actions)
    .setIcon('gauge')
    .setTooltip(t('project.openOverview'))
    .onClick(
      safeAsync((e) => {
        e.stopPropagation()
        return ctx.plugin.router.openProjectOverview(project.filePath)
      })
    )
  new IconButton(actions)
    .setIcon('chart-gantt')
    .setTooltip(t('project.openTasks'))
    .onClick(
      safeAsync((e) => {
        e.stopPropagation()
        return ctx.plugin.router.openScope({ kind: 'project', path: project.filePath })
      })
    )
  new IconButton(actions)
    .setIcon('plus')
    .setTooltip(t('task.add'))
    .onClick((e) => {
      e.stopPropagation()
      openTaskModal(ctx.plugin, project, {
        onSave: async () => {
          ctx.redraw()
        }
      })
    })

  // Progress bar & summary metrics
  const progressRow = el.createDiv('pm-cockpit-card-progress')
  new ProgressBar(progressRow).setSize('sm').setValue(card.progress).setColor(project.color)
  const statsRow = el.createDiv('pm-cockpit-card-stats')
  statsRow.createSpan({
    text: `${t('overview.doneOfTotal', { done: card.done, total: card.total })} (${card.progress}%)`
  })
  if (card.projectedFinish) {
    statsRow.createSpan({
      cls: 'pm-cockpit-card-finish',
      text: `${t('overview.projectedFinish')}: ${formatDateShort(card.projectedFinish)}`
    })
  }

  // Risk & Criticality Badges
  if (card.overdue > 0 || card.criticalCount > 0 || card.durationRiskCount > 0 || card.baselineLateCount > 0) {
    const badges = el.createDiv('pm-cockpit-card-badges')
    if (card.overdue > 0) {
      new Chip(badges)
        .setLabel(`${card.overdue} ${t('overview.overdue').toLowerCase()}`)
        .setVariant('solid')
        .setColor('var(--color-red)')
        .setSize('sm')
    }
    if (card.criticalCount > 0) {
      new Chip(badges)
        .setLabel(`${card.criticalCount} ${t('table.criticalBadge').toLowerCase()}`)
        .setVariant('outline')
        .setColor('var(--color-red)')
        .setSize('sm')
    }
    if (card.durationRiskCount > 0) {
      new Chip(badges)
        .setLabel(`${card.durationRiskCount} ${t('filter.durationRisk').toLowerCase()}`)
        .setVariant('outline')
        .setColor('var(--color-orange, var(--color-red))')
        .setSize('sm')
    }
  }

  // Next Milestone
  if (card.nextMilestone) {
    const msRow = el.createDiv('pm-cockpit-card-milestone')
    msRow.createSpan({ cls: 'pm-cockpit-card-subhead', text: `${t('dashboard.nextMilestone')}:` })
    const msLink = msRow.createSpan({
      cls: 'pm-cockpit-card-ms-title',
      text: `◆ ${card.nextMilestone.task.title}`
    })
    msLink.addEventListener('click', () => {
      if (!card.nextMilestone) return
      openTaskModal(ctx.plugin, project, {
        task: card.nextMilestone.task,
        onSave: async () => {
          ctx.redraw()
        }
      })
    })
    renderDueChip(msRow, formatDateShort(card.nextMilestone.due), card.nextMilestone.urgency)
  }

  // Next Steps (Up Next)
  const stepsBox = el.createDiv('pm-cockpit-card-steps')
  stepsBox.createDiv({ cls: 'pm-cockpit-card-subhead', text: t('dashboard.nextSteps') })
  if (card.nextSteps.length === 0) {
    stepsBox.createDiv({ cls: 'pm-overview-muted', text: t('dashboard.noPendingSteps') })
    return
  }

  for (const step of card.nextSteps) {
    renderProjectStepRow(stepsBox, project, config.statuses, step, ctx)
  }
}

function renderHealthChip(parent: HTMLElement, health: ProjectCockpitCard['health']): void {
  if (health === 'critical') {
    new Chip(parent)
      .setLabel(t('dashboard.healthCritical'))
      .setVariant('solid')
      .setColor('var(--color-red)')
      .setSize('sm')
  } else if (health === 'warning') {
    new Chip(parent)
      .setLabel(t('dashboard.healthWarning'))
      .setVariant('outline')
      .setColor('var(--color-orange, var(--color-yellow))')
      .setSize('sm')
  } else {
    new Chip(parent)
      .setLabel(t('dashboard.healthHealthy'))
      .setVariant('outline')
      .setColor('var(--color-green)')
      .setSize('sm')
  }
}

function renderProjectStepRow(
  parent: HTMLElement,
  project: Project,
  statuses: StatusConfig[],
  step: PortfolioNextStep,
  ctx: CockpitRenderContext
): void {
  const { task } = step
  const row = parent.createDiv('pm-cockpit-step-row')

  const statusBtn = row.createSpan({
    cls: 'pm-cockpit-status-trigger',
    attr: { title: t('dashboard.completeTaskTooltip') }
  })
  renderStatusDot(statusBtn, task.status, statuses)
  statusBtn.addEventListener('click', (e) => {
    openQuickStatusMenu(e, ctx.plugin, project, task, statuses, ctx.redraw)
  })

  const titleEl = row.createSpan({ cls: 'pm-cockpit-step-title', text: task.title })
  titleEl.addEventListener('click', () => {
    openTaskModal(ctx.plugin, project, {
      task,
      onSave: async () => {
        ctx.redraw()
      }
    })
  })

  const right = row.createDiv('pm-cockpit-step-right')
  if (step.isCritical) {
    new Chip(right)
      .setLabel(t('table.criticalBadge'))
      .setVariant('outline')
      .setColor('var(--color-red)')
      .setSize('sm')
  }
  if (step.isBlocked) {
    new Chip(right).setLabel(t('dashboard.blockedBadge')).setVariant('plain').setSize('sm')
  }
  if (task.due) {
    renderDueChip(right, formatDateShort(task.due), step.urgency)
  }
}
