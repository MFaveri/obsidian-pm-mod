import {
  type GanttGranularity,
  type GanttRowItem,
  type ProjectSpanSummary,
  type Task,
  buildGanttRows,
  computeBaselineVariance,
  computeDurationRisk,
  computeScopeCriticalPath,
  computeTaskRollup,
  scheduleOptionsFor,
  shownFields,
  today,
  t
} from '@dotpm/core'
import { svgEl } from '#dom'
import { SegmentedControl } from '#primitives/SegmentedControl'
import { renderStatusDot } from '../StatusBadge'
import {
  type BarBaselineInfo,
  type BarCriticalInfo,
  type BarDurationInfo,
  barAsideText,
  barColor,
  drawDependencyArrows,
  drawMilestoneDiamond,
  drawMilestoneLabels,
  drawRowHover,
  drawSummaryBar,
  drawTaskBar,
  drawTaskSummaryBar
} from '../gantt/bars'
import type { GanttCanvas } from '../gantt/canvas'
import { renderGridLines, renderTodayLine } from '../gantt/canvas'
import { renderTimelineHeader } from '../gantt/header'
import {
  HEADER_HEIGHT,
  LABEL_WIDTH,
  ROW_HEIGHT,
  buildTimelineConfig,
  dateToX,
  nonWorkingDay
} from '../gantt/TimelineConfig'
import {
  configOf,
  customFieldColumns,
  fieldCatalogOf,
  filterContextOf,
  isMulti,
  mergedConfig,
  queryOf,
  type ViewModel,
  type ViewProject
} from './model'

const granularities = (): { id: GanttGranularity; label: string }[] => [
  { id: 'day', label: t('granularity.day') },
  { id: 'week', label: t('granularity.week') },
  { id: 'month', label: t('granularity.month') },
  { id: 'quarter', label: t('granularity.quarter') },
  { id: 'year', label: t('granularity.year') }
]

function renderProjectRowLabel(container: HTMLElement, project: ViewProject, summary: ProjectSpanSummary): void {
  const el = container.createDiv('pm-gantt-label-row pm-gantt-project-row')
  el.setCssStyles({ height: `${ROW_HEIGHT}px` })
  const dot = el.createSpan({ cls: 'pm-gantt-project-dot' })
  dot.setCssStyles({ backgroundColor: project.color })
  el.createSpan({ text: project.title, cls: 'pm-gantt-project-title' })
  el.createSpan({ text: `${summary.done}/${summary.total}`, cls: 'pm-gantt-project-count' })
}

function renderLabel(container: HTMLElement, model: ViewModel, task: Task, depth: number): void {
  const el = container.createDiv('pm-gantt-label-row')
  el.setCssStyles({ height: `${ROW_HEIGHT}px`, paddingLeft: `${depth * 18 + 8}px` })
  el.dataset.taskId = task.id
  el.createSpan({ cls: 'pm-gantt-label-spacer' })
  renderStatusDot(el, task.status, configOf(model, task.id).statuses, 'pm-gantt-label-dot')
  el.createSpan({ text: task.title, cls: 'pm-gantt-label-title' })
  if (task.progress > 0) el.createSpan({ text: `${task.progress}%`, cls: 'pm-gantt-label-progress' })
}

function renderBody(container: HTMLElement, model: ViewModel, granularity: GanttGranularity): void {
  const filterCtx = filterContextOf(model)
  const projects = model.projects.map((p) => ({ ...p, filePath: p.id }))
  const { rows: items, timelineTasks } = buildGanttRows({
    projects,
    isMulti: isMulti(model),
    query: queryOf(model),
    statusesOf: (p) => p.config.statuses,
    filterContextOf: () => filterCtx,
    collapsedTaskIds: new Set(),
    collapsedProjectPaths: new Set()
  })
  const taskRows = items
    .filter((item): item is Extract<GanttRowItem<(typeof projects)[number]>, { kind: 'task' }> => item.kind === 'task')
    .map((item) => ({ task: item.task, depth: item.depth, row: item.rowIndex }))
  const config = mergedConfig(model)
  const extraWorkdays = model.projects.flatMap((p) => p.config.extraWorkdays)
  const extraNonWorkdays = model.projects.flatMap((p) => p.config.extraNonWorkdays)
  const workingWeekdays = model.projects.length === 1 ? model.projects[0].config.workingWeekdays : undefined
  const scheduleDaysOpts = { workingWeekdays, extraWorkdays, extraNonWorkdays }
  const cfg = buildTimelineConfig(timelineTasks, granularity, {
    isHidden: nonWorkingDay(model.nonWorkingDays, model.settings.holidays, scheduleDaysOpts)
  })
  const statuses = config.statuses
  const labelFields = shownFields(model.fields, 'gantt', fieldCatalogOf(model)).filter((id) => id !== 'title')
  const labelSource = { statuses, priorities: config.priorities, customFields: customFieldColumns(model) }
  const criticalPath = computeScopeCriticalPath(model.projects, model.settings.holidays)
  const showCriticalPath = model.settings.showCriticalPath === true
  const showBaseline = model.settings.showBaseline === true

  const wrapper = container.createDiv('pm-gantt-wrapper')
  const leftPanel = wrapper.createDiv('pm-gantt-left')
  leftPanel.setCssStyles({ width: `${LABEL_WIDTH}px`, minWidth: `${LABEL_WIDTH}px` })
  const leftHeader = leftPanel.createDiv('pm-gantt-left-header')
  leftHeader.setCssStyles({ height: `${HEADER_HEIGHT}px` })
  leftHeader.createSpan({ text: t('columns.task'), cls: 'pm-gantt-left-header-label' })
  const leftBody = leftPanel.createDiv('pm-gantt-left-body')

  const rightPanel = wrapper.createDiv('pm-gantt-right')
  const headerSticky = rightPanel.createDiv('pm-gantt-header-sticky')
  headerSticky.setCssStyles({ width: `${cfg.totalWidth}px`, height: `${HEADER_HEIGHT}px` })
  const headerSvgEl = svgEl('svg', { width: cfg.totalWidth, height: HEADER_HEIGHT, class: 'pm-gantt-header-svg' })
  headerSticky.appendChild(headerSvgEl)

  const svgContainer = rightPanel.createDiv('pm-gantt-svg-container')
  svgContainer.setCssStyles({ width: `${cfg.totalWidth}px`, marginTop: `-${HEADER_HEIGHT}px` })
  const svgHeight = HEADER_HEIGHT + (items.length + 1) * ROW_HEIGHT
  const canvasSvg = svgEl('svg', { width: cfg.totalWidth, height: svgHeight, class: 'pm-gantt-svg' })
  svgContainer.appendChild(canvasSvg)

  const canvas: GanttCanvas = {
    svgEl: canvasSvg,
    headerSvgEl,
    cfg,
    weekLabel: model.settings.ganttWeekLabel,
    dayKind: (date) => {
      const iso = date.toString()
      if (extraNonWorkdays.includes(iso)) return 'time-off'
      if (extraWorkdays.includes(iso)) return 'extra-working'
      if (model.settings.holidays.includes(iso)) return 'time-off'
      const isOff = nonWorkingDay(model.nonWorkingDays, model.settings.holidays, scheduleDaysOpts)?.(date)
      return isOff ? 'off-week' : 'working'
    }
  }
  renderTimelineHeader(canvas)
  renderGridLines(canvas, items.length)
  renderTodayLine(canvas, svgHeight)

  const barsGroup = svgEl('g', { class: 'pm-gantt-bars' })
  canvasSvg.appendChild(barsGroup)
  for (const item of items) {
    if (item.kind === 'project') {
      renderProjectRowLabel(leftBody, item.project, item.summary)
      drawRowHover(barsGroup, canvas, item.rowIndex)
      drawSummaryBar(
        barsGroup,
        canvas,
        { title: item.project.title, color: item.project.color, ...item.summary },
        item.rowIndex,
        showBaseline
      )
      continue
    }
    const { task, depth, rowIndex } = item
    renderLabel(leftBody, model, task, depth)
    const taskCfg = configOf(model, task.id)
    const taskStatuses = taskCfg.statuses
    const color = barColor(canvas, taskStatuses, task)

    if (task.subtasks.length > 0) {
      const rollup = computeTaskRollup(task, taskStatuses)
      if (rollup && (rollup.hasDatedSubtasks || task.start || task.due)) {
        drawRowHover(barsGroup, canvas, rowIndex)
        drawTaskSummaryBar(
          barsGroup,
          canvas,
          {
            title: task.title,
            color,
            start: rollup.start,
            due: rollup.due,
            baselineStart: rollup.baselineStart,
            baselineDue: rollup.baselineDue,
            progress: rollup.progress,
            doneSubtasks: rollup.doneSubtasks,
            totalSubtasks: rollup.totalSubtasks,
            collapsed: false,
            aside: barAsideText(task, labelFields, labelSource)
          },
          rowIndex,
          showBaseline
        )
        continue
      }
    }

    if (!task.start && !task.due) continue
    const schedOpts = scheduleOptionsFor(taskCfg, model.settings.holidays)
    const cpm = criticalPath.tasks[task.id]
    const criticalInfo: BarCriticalInfo | undefined = cpm
      ? { critical: cpm.critical, slackDays: cpm.slackDays, highlight: showCriticalPath }
      : undefined
    const variance = computeBaselineVariance(task, schedOpts)
    const baselineInfo: BarBaselineInfo | undefined = variance ? { ...variance, showBar: showBaseline } : undefined
    const durationInfo: BarDurationInfo | undefined = computeDurationRisk(task, schedOpts) ?? undefined
    drawRowHover(barsGroup, canvas, rowIndex)
    if (task.type === 'milestone') {
      drawMilestoneDiamond(barsGroup, canvas, task, rowIndex, color, criticalInfo, baselineInfo)
    } else {
      drawTaskBar(
        barsGroup,
        canvas,
        taskStatuses,
        task,
        rowIndex,
        color,
        barAsideText(task, labelFields, labelSource),
        criticalInfo,
        baselineInfo,
        durationInfo
      )
    }
  }
  const criticalEdges = showCriticalPath
    ? new Set(criticalPath.criticalEdges.map(([from, to]) => `${from}->${to}`))
    : undefined
  drawDependencyArrows(canvas, taskRows, criticalEdges)
  drawMilestoneLabels(canvas, statuses, taskRows, items.length)

  leftPanel.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      rightPanel.scrollTop += e.deltaY
      rightPanel.scrollLeft += e.deltaX
      e.preventDefault()
    },
    { passive: false }
  )
  rightPanel.addEventListener('scroll', () => {
    leftBody.scrollTop = rightPanel.scrollTop
  })
  window.requestAnimationFrame(() => {
    rightPanel.scrollLeft = Math.max(0, dateToX(cfg, today()) - rightPanel.clientWidth / 2)
  })
}

/** The timeline without drag, links or editing. The zoom control still works, on the page. */
export function renderSnapshotGantt(container: HTMLElement, model: ViewModel): HTMLElement {
  container.addClass('pm-gantt-view')
  let granularity = model.settings.ganttGranularity
  const bar = container.createDiv('pm-gantt-controls')
  const body = container.createDiv('pm-gantt-body')
  const paint = (): void => {
    body.empty()
    renderBody(body, model, granularity)
  }
  new SegmentedControl<GanttGranularity>(bar, {
    options: granularities(),
    active: granularity,
    onChange: (level) => {
      granularity = level
      paint()
    }
  })
  paint()
  return body
}
