import { Menu } from 'obsidian'
import { Chip, CollapseToggle, IconButton, renderStatusDot, safeAsync, ROW_HEIGHT } from '@dotpm/ui'
import type PMPlugin from '#main'
import {
  type CriticalPathResult,
  type Project,
  type ProjectSpanSummary,
  type StatusConfig,
  type Task,
  t,
  tn
} from '@dotpm/core'
import type { ProjectScope, TaskRef } from '#store'
import { openTaskByPath, openTaskModal } from '#ui/ModalFactory'
import { buildTaskContextMenu } from '#ui/TaskContextMenu'
import { toggleCollapsed, toggleGanttProjectCollapsed } from '../collapse'

export interface LabelContext {
  plugin: PMPlugin
  scope: ProjectScope
  statuses: StatusConfig[]
  collapsedIds: ReadonlySet<string>
  criticalPath?: CriticalPathResult
  showCriticalPath?: boolean
  showWorkload?: boolean
  overloadedTaskIds?: ReadonlySet<string>
  onRefresh: () => Promise<void>
}

export function renderProjectLabel(
  container: HTMLElement,
  project: Project,
  summary: ProjectSpanSummary,
  collapsed: boolean,
  ctx: LabelContext
): void {
  const el = container.createDiv('pm-gantt-label-row pm-gantt-project-row')
  el.style.height = `${ROW_HEIGHT}px`

  new CollapseToggle(el, {
    collapsed,
    onToggle: safeAsync(async () => {
      toggleGanttProjectCollapsed(ctx.plugin.settings, project.filePath)
      await ctx.plugin.saveSettings()
      await ctx.onRefresh()
    })
  })

  const dot = el.createSpan({ cls: 'pm-gantt-project-dot' })
  dot.style.backgroundColor = project.color

  const titleEl = el.createSpan({ text: project.title, cls: 'pm-gantt-project-title' })
  titleEl.addEventListener(
    'click',
    safeAsync(() => ctx.plugin.router.openProjectOverview(project.filePath))
  )

  el.createSpan({ text: `${summary.done}/${summary.total}`, cls: 'pm-gantt-project-count' })

  new IconButton(el)
    .setIcon('plus')
    .setTooltip(t('task.add'))
    .setRevealOnHover(true)
    .onClick((e) => {
      e.stopPropagation()
      openTaskModal(ctx.plugin, project, { onSave: () => ctx.onRefresh() })
    })
}

export function renderTaskLabel(
  container: HTMLElement,
  task: Task,
  depth: number,
  _row: number,
  ctx: LabelContext
): void {
  // One row is one task, so its project is resolved once here.
  const project = ctx.scope.projectOf(task.id)
  if (!project) return
  const el = container.createDiv('pm-gantt-label-row')
  el.style.height = `${ROW_HEIGHT}px`
  el.style.paddingLeft = `${depth * 18 + 8}px`
  el.dataset.taskId = task.id
  el.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault()
    buildTaskContextMenu(new Menu(), task, {
      plugin: ctx.plugin,
      project,
      onRefresh: ctx.onRefresh
    }).showAtMouseEvent(e)
  })

  el.draggable = true
  el.addEventListener('dragstart', (e: DragEvent) => {
    e.dataTransfer?.setData('text/plain', task.id)
    el.addClass('pm-gantt-label-row--dragging')
  })
  el.addEventListener('dragend', () => {
    el.removeClass('pm-gantt-label-row--dragging')
  })
  let dropPosition: 'before' | 'after' = 'before'
  el.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault()
    const rect = el.getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    dropPosition = e.clientY < midY ? 'before' : 'after'
    el.removeClass('pm-gantt-label-row--drop-before', 'pm-gantt-label-row--drop-after')
    el.addClass(dropPosition === 'before' ? 'pm-gantt-label-row--drop-before' : 'pm-gantt-label-row--drop-after')
  })
  el.addEventListener('dragleave', () => {
    el.removeClass('pm-gantt-label-row--drop-before', 'pm-gantt-label-row--drop-after')
  })
  el.addEventListener(
    'drop',
    safeAsync(async (e: DragEvent) => {
      e.preventDefault()
      el.removeClass('pm-gantt-label-row--drop-before', 'pm-gantt-label-row--drop-after')
      const draggedId = e.dataTransfer?.getData('text/plain')
      if (!draggedId || draggedId === task.id || !project.taskIndex.has(draggedId)) return
      await ctx.plugin.store.reorderTask(project, draggedId, task.id, dropPosition)
      await ctx.onRefresh()
    })
  )

  if (task.subtasks.length > 0) {
    new CollapseToggle(el, {
      collapsed: ctx.collapsedIds.has(task.id),
      onToggle: safeAsync(async () => {
        toggleCollapsed(ctx.plugin.settings, project, task.id)
        await ctx.plugin.saveSettings()
        await ctx.onRefresh()
      })
    })
  } else {
    el.createSpan({ cls: 'pm-gantt-label-spacer' })
  }

  const taskStatuses = ctx.scope.configOf(task.id).statuses
  renderStatusDot(el, task.status, taskStatuses, 'pm-gantt-label-dot')

  const titleEl = el.createSpan({ text: task.title, cls: 'pm-gantt-label-title' })
  titleEl.addEventListener('click', () => {
    openTaskModal(ctx.plugin, project, { task, onSave: () => ctx.onRefresh() })
  })

  if (task.subtasks.length > 0 && ctx.collapsedIds.has(task.id)) {
    el.createSpan({ text: `(${task.subtasks.length})`, cls: 'pm-gantt-label-count' })
  }

  // A predecessor outside this view draws no arrow, so the row says it is there.
  const elsewhere = task.dependencies
    .filter((id) => !ctx.scope.taskById(id))
    .map((id) => ctx.plugin.index.task(id))
    .filter((ref): ref is TaskRef => ref !== null)
  if (elsewhere.length) {
    const nameOf = (ref: TaskRef) => {
      const owner = ref.projectPath ? ctx.plugin.index.projectRef(ref.projectPath) : null
      return owner ? t('gantt.inProject', { title: ref.title, project: owner.title }) : ref.title
    }
    new Chip(el)
      .setLabel(tn('gantt.dependsElsewhere', elsewhere.length))
      .setVariant('plain')
      .setSize('sm')
      .setTooltip(elsewhere.map(nameOf).join('\n'))
      .onClick((e) => {
        e.stopPropagation()
        const menu = new Menu()
        for (const ref of elsewhere) {
          menu.addItem((item) =>
            item
              .setTitle(nameOf(ref))
              .setIcon('link-2')
              .onClick(
                safeAsync(() =>
                  openTaskByPath(ctx.plugin, ref.path, () => {
                    void ctx.onRefresh()
                  })
                )
              )
          )
        }
        menu.showAtMouseEvent(e)
      })
  }

  if (ctx.showCriticalPath) {
    const cpm = ctx.criticalPath?.tasks[task.id]
    if (cpm) {
      if (cpm.critical) el.addClass('pm-gantt-label-row--critical')
      const badge = el.createSpan({
        text: cpm.critical ? t('gantt.criticalShort') : t('gantt.slackShort', { count: cpm.slackDays }),
        cls: `pm-gantt-label-slack${cpm.critical ? ' pm-gantt-label-slack--critical' : ''}`
      })
      badge.setAttribute(
        'aria-label',
        cpm.critical ? t('gantt.tooltipCritical') : tn('gantt.tooltipSlack', cpm.slackDays)
      )
      badge.setAttribute('title', cpm.critical ? t('gantt.tooltipCritical') : tn('gantt.tooltipSlack', cpm.slackDays))
    }
  }

  if (ctx.showWorkload && ctx.overloadedTaskIds?.has(task.id)) {
    const tip = t('gantt.workloadOverloadTooltip', { assignee: task.assignees.join(', ') })
    const badge = el.createSpan({
      text: t('gantt.workloadOverloadBadge'),
      cls: 'pm-gantt-label-slack pm-gantt-label-slack--critical pm-gantt-label-overload'
    })
    badge.setAttribute('aria-label', tip)
    badge.setAttribute('title', tip)
  }

  if (task.progress > 0) {
    el.createSpan({ text: `${task.progress}%`, cls: 'pm-gantt-label-progress' })
  }

  new IconButton(el)
    .setIcon('plus')
    .setTooltip(t('taskMenu.addSubtask'))
    .setRevealOnHover(true)
    .onClick((e) => {
      e.stopPropagation()
      openTaskModal(ctx.plugin, project, { parentId: task.id, onSave: () => ctx.onRefresh() })
    })
}
