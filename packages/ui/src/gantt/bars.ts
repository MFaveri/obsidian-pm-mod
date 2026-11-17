import {
  type CustomFieldDef,
  type PriorityConfig,
  type StatusConfig,
  type Task,
  displayName,
  formatDateShort,
  getPriorityConfig,
  getStatusConfig,
  parsePlainDate,
  t,
  tn
} from '@dotpm/core'
import { cardCustomValues } from '../views/boardCards'
import { svgEl } from '#dom'
import type { GanttCanvas } from './canvas'
import { BAR_BORDER_RADIUS, BAR_PADDING, HEADER_HEIGHT, ROW_HEIGHT, dateToX } from './TimelineConfig'

/** One drawn row: the task and where it sits, top to bottom. */
export interface GanttRow {
  task: Task
  depth: number
  /** Visual row index in the grid, used when non-task rows (such as project headers) sit between tasks. */
  row?: number
}

export interface ProjectSummaryBarInput {
  title: string
  color: string
  start: string
  due: string
  progress: number
  done: number
  total: number
}

/** A status color, or the accent the theme resolves for the canvas. */
export function barColor(canvas: GanttCanvas, statuses: StatusConfig[], task: Task): string {
  return (
    getStatusConfig(statuses, task.status)?.color ??
    getComputedStyle(canvas.svgEl).getPropertyValue('--interactive-accent').trim()
  )
}

export function drawRowHover(g: SVGGElement, canvas: GanttCanvas, row: number): void {
  g.appendChild(
    svgEl('rect', {
      x: 0,
      y: HEADER_HEIGHT + row * ROW_HEIGHT,
      width: canvas.cfg.totalWidth,
      height: ROW_HEIGHT,
      class: 'pm-gantt-row-hover'
    })
  )
}

export interface DrawnBar {
  barGroup: SVGGElement
  rect: SVGRectElement
  x: number
  y: number
  width: number
  height: number
}

export interface BarCriticalInfo {
  critical: boolean
  slackDays: number
  /** When true, highlights critical elements and dims non-critical ones. */
  highlight?: boolean
}

function formatSlackTooltip(info: BarCriticalInfo): string {
  return info.critical ? t('gantt.tooltipCritical') : tn('gantt.tooltipSlack', info.slackDays)
}

export interface LabelSource {
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  customFields: CustomFieldDef[]
}

/** The label fields other than the title, as the text beside a bar. Empty when there are none or they hold nothing. */
export function barAsideText(task: Task, fields: string[], source: LabelSource): string {
  const custom = cardCustomValues(task, source.customFields, fields)
  const parts = fields.map((field) => {
    switch (field) {
      case 'assignees':
        return task.assignees.map(displayName).join(', ')
      case 'progress':
        return task.progress > 0 ? `${task.progress}%` : ''
      case 'dates':
        return [task.start, task.due].filter(Boolean).map(formatDateShort).join(' - ')
      case 'status':
        return getStatusConfig(source.statuses, task.status)?.label ?? task.status
      case 'priority':
        return getPriorityConfig(source.priorities, task.priority)?.label ?? task.priority
      default:
        return custom[field]?.text ?? ''
    }
  })
  return parts.filter(Boolean).join(', ')
}

/**
 * The bar itself: fill, progress, recurrence mark, label, the `aside` text past its end,
 * and tooltip. Nothing interactive.
 */
export function drawTaskBar(
  g: SVGGElement,
  canvas: GanttCanvas,
  statuses: StatusConfig[],
  task: Task,
  row: number,
  color: string,
  aside = '',
  criticalInfo?: BarCriticalInfo
): DrawnBar | null {
  const startDate = parsePlainDate(task.start)
  const endDate = parsePlainDate(task.due)
  // A task due on E occupies day E, so the bar's right edge sits at the start of E+1.
  const effectiveStart = startDate ?? endDate
  if (!effectiveStart) return null
  const effectiveEnd = (endDate ?? effectiveStart).add({ days: 1 })

  const y = HEADER_HEIGHT + row * ROW_HEIGHT + BAR_PADDING
  const height = ROW_HEIGHT - BAR_PADDING * 2
  const x = Math.max(0, dateToX(canvas.cfg, effectiveStart))
  const xEnd = Math.min(canvas.cfg.totalWidth, dateToX(canvas.cfg, effectiveEnd))
  const width = Math.max(8, xEnd - x)

  const highlightClass = criticalInfo?.highlight
    ? criticalInfo.critical
      ? ' pm-gantt-bar-group--critical'
      : ' pm-gantt-bar-group--dimmed'
    : ''
  const barGroup = svgEl('g', { class: `pm-gantt-bar-group${highlightClass}` })
  g.appendChild(barGroup)

  const rect = svgEl('rect', {
    x,
    y,
    width,
    height,
    rx: BAR_BORDER_RADIUS,
    ry: BAR_BORDER_RADIUS,
    fill: color,
    opacity: 0.4,
    class: `pm-gantt-bar${criticalInfo?.highlight && criticalInfo.critical ? ' pm-gantt-bar--critical' : ''}`
  })
  barGroup.appendChild(rect)

  if (task.progress > 0) {
    barGroup.appendChild(
      svgEl('rect', {
        x,
        y,
        width: (task.progress / 100) * width,
        height,
        rx: BAR_BORDER_RADIUS,
        ry: BAR_BORDER_RADIUS,
        fill: color,
        opacity: 0.9,
        class: 'pm-gantt-bar-progress'
      })
    )
  }

  let asideX = x + width + 6
  if (task.recurrence) {
    const icon = svgEl('text', { x: x + width + 4, y: y + height / 2 + 5, class: 'pm-gantt-bar-icon' })
    icon.textContent = t('chip.recurring')
    barGroup.appendChild(icon)
    asideX += 20
  }
  if (aside) {
    const text = svgEl('text', { x: asideX, y: y + height / 2, class: 'pm-gantt-bar-aside' })
    text.textContent = aside
    barGroup.appendChild(text)
  }

  if (width > 55) {
    const label = svgEl('text', { x: x + 8, y: y + height / 2 + 5, class: 'pm-gantt-bar-label' })
    const maxChars = Math.max(4, Math.floor((width - 16) / 7.5))
    label.textContent = task.title.length > maxChars ? task.title.slice(0, maxChars - 1) + '…' : task.title
    barGroup.appendChild(label)
  }

  const statusConfig = getStatusConfig(statuses, task.status)
  const tooltip = svgEl('title', {})
  const lines = [
    task.title,
    `${statusConfig?.label ?? task.status} · ${task.priority}`,
    `${t('gantt.tooltipStart', { date: task.start || '—' })}  ${t('gantt.tooltipDue', { date: task.due || '—' })}`,
    t('gantt.tooltipProgress', { percent: task.progress })
  ]
  if (task.assignees.length) {
    lines.push(t('gantt.tooltipAssignees', { names: task.assignees.map(displayName).join(', ') }))
  }
  if (criticalInfo) {
    lines.push(formatSlackTooltip(criticalInfo))
  }
  tooltip.textContent = lines.join('\n')
  rect.appendChild(tooltip)

  return { barGroup, rect, x, y, width, height }
}

/**
 * Project summary bar spanning from earliest start to latest due, with downward end caps
 * and progress fill. Returns null when the project has no dated tasks.
 */
export function drawSummaryBar(
  g: SVGGElement,
  canvas: GanttCanvas,
  summary: ProjectSummaryBarInput,
  row: number
): SVGGElement | null {
  const startDate = parsePlainDate(summary.start)
  const endDate = parsePlainDate(summary.due)
  const effectiveStart = startDate ?? endDate
  if (!effectiveStart) return null
  const effectiveEnd = (endDate ?? effectiveStart).add({ days: 1 })

  const rowTop = HEADER_HEIGHT + row * ROW_HEIGHT
  const barTop = rowTop + BAR_PADDING + 4
  const barHeight = Math.max(6, ROW_HEIGHT - BAR_PADDING * 2 - 10)
  const x = Math.max(0, dateToX(canvas.cfg, effectiveStart))
  const xEnd = Math.min(canvas.cfg.totalWidth, dateToX(canvas.cfg, effectiveEnd))
  const width = Math.max(10, xEnd - x)
  const cap = 5
  const color =
    summary.color || getComputedStyle(canvas.svgEl).getPropertyValue('--interactive-accent').trim()

  const group = svgEl('g', { class: 'pm-gantt-summary-group' })
  g.appendChild(group)

  const track = svgEl('rect', {
    x,
    y: barTop,
    width,
    height: barHeight,
    rx: 2,
    ry: 2,
    fill: color,
    opacity: 0.25,
    class: 'pm-gantt-summary-bar'
  })
  group.appendChild(track)

  if (summary.progress > 0) {
    group.appendChild(
      svgEl('rect', {
        x,
        y: barTop,
        width: (Math.min(100, summary.progress) / 100) * width,
        height: barHeight,
        rx: 2,
        ry: 2,
        fill: color,
        opacity: 0.85,
        class: 'pm-gantt-summary-progress'
      })
    )
  }

  const capY = barTop + barHeight
  group.appendChild(
    svgEl('polygon', {
      points: `${x},${barTop} ${x + cap * 2},${barTop} ${x},${capY + cap}`,
      fill: color,
      class: 'pm-gantt-summary-cap'
    })
  )
  group.appendChild(
    svgEl('polygon', {
      points: `${x + width - cap * 2},${barTop} ${x + width},${barTop} ${x + width},${capY + cap}`,
      fill: color,
      class: 'pm-gantt-summary-cap'
    })
  )

  const tooltip = svgEl('title', {})
  tooltip.textContent = [
    summary.title,
    `${t('gantt.tooltipStart', { date: summary.start || '—' })}  ${t('gantt.tooltipDue', { date: summary.due || '—' })}`,
    `${t('overview.doneOfTotal', { done: summary.done, total: summary.total })} (${summary.progress}%)`
  ].join('\n')
  group.appendChild(tooltip)

  return group
}

export function drawMilestoneDiamond(
  g: SVGGElement,
  canvas: GanttCanvas,
  task: Task,
  row: number,
  color: string,
  criticalInfo?: BarCriticalInfo
): SVGPolygonElement | null {
  const date = parsePlainDate(task.due) ?? parsePlainDate(task.start)
  if (!date) return null
  const cx = dateToX(canvas.cfg, date) + canvas.cfg.dayWidth / 2
  const cy = HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2
  const size = 12
  const highlightClass = criticalInfo?.highlight
    ? criticalInfo.critical
      ? ' pm-gantt-milestone--critical'
      : ' pm-gantt-milestone--dimmed'
    : ''
  const diamond = svgEl('polygon', {
    points: `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`,
    fill: color,
    opacity: 0.8,
    class: `pm-gantt-milestone${highlightClass}`,
    cursor: 'pointer'
  })
  g.appendChild(diamond)
  const tooltip = svgEl('title', {})
  const lines = [
    t('gantt.milestoneTitle', { title: task.title }),
    t('gantt.tooltipDate', { date: task.due || task.start || '—' })
  ]
  if (criticalInfo) lines.push(formatSlackTooltip(criticalInfo))
  tooltip.textContent = lines.join('\n')
  diamond.appendChild(tooltip)
  return diamond
}

/** A dashed line down the body and a label in the sticky header for every dated milestone. */
export function drawMilestoneLabels(
  canvas: GanttCanvas,
  statuses: StatusConfig[],
  rows: GanttRow[],
  totalRows = rows.length
): void {
  const milestones = rows.filter(({ task }) => task.type === 'milestone' && (task.due || task.start))
  if (!milestones.length) return

  const linesG = svgEl('g', { class: 'pm-gantt-milestone-labels' })
  const totalH = HEADER_HEIGHT + totalRows * ROW_HEIGHT

  for (const { task } of milestones) {
    const date = parsePlainDate(task.due) ?? parsePlainDate(task.start)
    if (!date) continue
    const x = dateToX(canvas.cfg, date) + canvas.cfg.dayWidth / 2
    const color = barColor(canvas, statuses, task)

    linesG.appendChild(
      svgEl('line', {
        x1: x,
        y1: HEADER_HEIGHT,
        x2: x,
        y2: totalH,
        stroke: color,
        'stroke-width': 1,
        'stroke-dasharray': '4 4',
        opacity: 0.4
      })
    )

    // Label rides the sticky header so it stays visible while rows scroll.
    const label = svgEl('text', { x, y: 14, 'text-anchor': 'middle', class: 'pm-gantt-milestone-label', fill: color })
    label.textContent = task.title.length > 16 ? task.title.slice(0, 14) + '…' : task.title
    canvas.headerSvgEl.appendChild(label)
  }

  canvas.svgEl.appendChild(linesG)
}

export function drawDependencyArrows(
  canvas: GanttCanvas,
  rows: GanttRow[],
  criticalEdges?: ReadonlySet<string>
): void {
  const byId = new Map<string, { row: number; task: Task }>()
  rows.forEach((entry, i) => byId.set(entry.task.id, { row: entry.row ?? i, task: entry.task }))

  const arrowGroup = svgEl('g', { class: 'pm-gantt-arrows' })

  for (const entry of rows) {
    const { task } = entry
    if (!task.dependencies?.length) continue
    const to = byId.get(task.id)
    if (!to) continue
    const toY = HEADER_HEIGHT + to.row * ROW_HEIGHT + ROW_HEIGHT / 2
    const taskStart = parsePlainDate(task.start) ?? (task.type === 'milestone' ? parsePlainDate(task.due) : null)
    if (!taskStart) continue
    const toX = dateToX(canvas.cfg, taskStart)

    for (const depId of task.dependencies) {
      const from = byId.get(depId)
      if (!from) continue
      const depDue = parsePlainDate(from.task.due) ?? parsePlainDate(from.task.start)
      if (!depDue) continue
      const fromX = dateToX(canvas.cfg, depDue.add({ days: 1 }))
      const fromY = HEADER_HEIGHT + from.row * ROW_HEIGHT + ROW_HEIGHT / 2
      const midX = (fromX + toX) / 2
      const isCritical = criticalEdges ? criticalEdges.has(`${depId}->${task.id}`) : false
      const cls = criticalEdges
        ? isCritical
          ? 'pm-gantt-arrow pm-gantt-arrow--critical'
          : 'pm-gantt-arrow pm-gantt-arrow--dimmed'
        : 'pm-gantt-arrow'
      arrowGroup.appendChild(
        svgEl('path', {
          d: `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`,
          class: cls,
          'marker-end': isCritical ? 'url(#pm-arrowhead-critical)' : 'url(#pm-arrowhead)'
        })
      )
    }
  }

  const defs =
    canvas.svgEl.querySelector('defs') ?? canvas.svgEl.insertBefore(svgEl('defs', {}), canvas.svgEl.firstChild)
  const addMarker = (id: string, cls: string) => {
    const m = svgEl('marker', {
      id,
      markerWidth: 8,
      markerHeight: 8,
      refX: 6,
      refY: 3,
      orient: 'auto'
    })
    m.appendChild(svgEl('path', { d: 'M0,0 L0,6 L8,3 z', class: cls }))
    defs.appendChild(m)
  }
  addMarker('pm-arrowhead', 'pm-gantt-arrowhead')
  if (criticalEdges) addMarker('pm-arrowhead-critical', 'pm-gantt-arrowhead pm-gantt-arrowhead--critical')

  canvas.svgEl.appendChild(arrowGroup)
}
