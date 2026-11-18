import type PMPlugin from '#main'
import { openTaskModal } from '#ui/ModalFactory'
import {
  type AssigneeChartRow,
  type BurnupPoint,
  type Project,
  type ProjectChartsData,
  type ResolvedProjectConfig,
  type SlackBucket,
  type SlackBucketKey,
  type Task,
  type WeeklyWorkloadBucket,
  UNASSIGNED_KEY,
  dateUrgency,
  formatDateShort,
  isTerminalStatus,
  t,
  tn
} from '@dotpm/core'
import {
  Avatar,
  Chip,
  EmptyState,
  SegmentedControl,
  renderDueChip,
  renderMetricStrip,
  type MetricStat
} from '@dotpm/ui'

const SVG_NS = 'http://www.w3.org/2000/svg'

const ASSIGNEE_PALETTE = [
  'var(--interactive-accent, #6366f1)',
  'var(--color-cyan, #06b6d4)',
  'var(--color-green, #22c55e)',
  'var(--color-orange, #f97316)',
  'var(--color-pink, #ec4899)',
  'var(--color-purple, #a855f7)',
  'var(--color-yellow, #eab308)'
]

export type HistogramBreakdownMode = 'status' | 'assignee'

export interface ChartsViewInteractionState {
  histogramMode: HistogramBreakdownMode
  selectedWeekStart: string | null
  selectedAssignee: string | null
  selectedSlackBucket: SlackBucketKey | null
}

export interface ChartsRenderContext {
  plugin: PMPlugin
  project: Project
  config: ResolvedProjectConfig
  data: ProjectChartsData
  state: ChartsViewInteractionState
  redraw: () => void
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const el = activeDocument.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v))
  }
  return el
}

function displayAssignee(name: string): string {
  return name === UNASSIGNED_KEY ? t('charts.unassigned') : name
}

function colorForAssignee(name: string, orderedNames: string[]): string {
  if (name === UNASSIGNED_KEY) return 'var(--text-faint, #888)'
  const idx = Math.max(0, orderedNames.indexOf(name))
  return ASSIGNEE_PALETTE[idx % ASSIGNEE_PALETTE.length]
}

function attachTooltip(
  host: HTMLElement,
  target: Element,
  lines: () => string[]
): void {
  target.addEventListener('mouseenter', (ev) => {
    const mouse = ev as MouseEvent
    const existing = host.querySelector('.pm-charts-tooltip')
    if (existing) existing.remove()
    const tip = host.createDiv('pm-charts-tooltip')
    for (const line of lines()) {
      tip.createDiv({ cls: 'pm-charts-tooltip-line', text: line })
    }
    positionTooltip(host, tip, mouse)
  })
  target.addEventListener('mousemove', (ev) => {
    const tip = host.querySelector('.pm-charts-tooltip')
    if (tip instanceof HTMLElement) positionTooltip(host, tip, ev as MouseEvent)
  })
  target.addEventListener('mouseleave', () => {
    const existing = host.querySelector('.pm-charts-tooltip')
    if (existing) existing.remove()
  })
}

function positionTooltip(host: HTMLElement, tip: HTMLElement, ev: MouseEvent): void {
  const rect = host.getBoundingClientRect()
  const x = ev.clientX - rect.left + 12
  const y = ev.clientY - rect.top - 10
  const maxLeft = Math.max(8, rect.width - tip.offsetWidth - 8)
  tip.style.left = `${Math.min(Math.max(8, x), maxLeft)}px`
  tip.style.top = `${Math.max(4, y)}px`
}

function renderDrilldownPanel(
  parent: HTMLElement,
  title: string,
  taskIds: string[],
  ctx: ChartsRenderContext,
  onClear: () => void
): void {
  const box = parent.createDiv('pm-charts-drilldown')
  const head = box.createDiv('pm-charts-drilldown-head')
  head.createSpan({
    cls: 'pm-charts-drilldown-title',
    text: t('charts.drilldownTitle', { label: title, count: taskIds.length })
  })
  const closeBtn = head.createSpan({ cls: 'pm-charts-drilldown-close', text: '×' })
  closeBtn.setAttribute('aria-label', t('charts.clearSelection'))
  closeBtn.setAttribute('title', t('charts.clearSelection'))
  closeBtn.addEventListener('click', onClear)

  const tasks = taskIds
    .map((id) => ctx.data.taskLookup.get(id))
    .filter((task): task is Task => task !== undefined)

  if (tasks.length === 0) {
    box.createDiv({ cls: 'pm-overview-muted', text: t('charts.selectionEmpty') })
    return
  }

  const list = box.createDiv('pm-charts-drilldown-list')
  for (const task of tasks.slice(0, 20)) {
    const row = list.createDiv('pm-charts-drilldown-row')
    const statusColor =
      ctx.config.statuses.find((s) => s.id === task.status)?.color ?? 'var(--text-muted)'
    const dot = row.createSpan({ cls: 'pm-charts-status-dot' })
    dot.style.backgroundColor = statusColor

    row.createSpan({ cls: 'pm-charts-drilldown-task', text: task.title })

    const meta = row.createDiv('pm-charts-drilldown-meta')
    for (const person of task.assignees.slice(0, 2)) {
      new Avatar(meta).setName(person).setSize('sm')
    }
    if (task.due) {
      renderDueChip(
        meta,
        formatDateShort(task.due),
        dateUrgency(task.due, isTerminalStatus(task.status, ctx.config.statuses))
      )
    }

    row.addEventListener('click', () => {
      openTaskModal(ctx.plugin, ctx.project, {
        task,
        onSave: async () => {
          ctx.redraw()
        }
      })
    })
  }
}

export function renderProjectChartsBody(parent: HTMLElement, ctx: ChartsRenderContext): void {
  const { data } = ctx
  if (data.summary.totalTasks === 0) {
    new EmptyState(parent)
      .setIcon('📊')
      .setTitle(t('charts.title'))
      .setBody(t('charts.emptyNoData'))
    return
  }

  renderChartsKpiStrip(parent, ctx)

  const grid = parent.createDiv('pm-charts-grid')
  renderWeeklyHistogramCard(grid, ctx)
  renderAssigneeDistributionCard(grid, ctx)
  renderBurnupCard(grid, ctx)
  renderSlackProfileCard(grid, ctx)
  if (data.baselineVariance.trackedCount > 0) {
    renderBaselineVarianceCard(grid, ctx)
  }
  if (data.summary.hasEffort && data.effortByAssignee.length > 0) {
    renderEffortCard(grid, ctx)
  }
}

function renderChartsKpiStrip(parent: HTMLElement, ctx: ChartsRenderContext): void {
  const { summary, burnup, peakWeeklyActive } = ctx.data
  const paceLabel =
    burnup.paceDelta > 0
      ? tn('charts.paceAhead', burnup.paceDelta)
      : burnup.paceDelta < 0
        ? tn('charts.paceBehind', -burnup.paceDelta)
        : t('charts.onPace')

  const stats: MetricStat[] = [
    {
      label: t('overview.progress'),
      value: `${summary.completionPct}%`,
      sub: t('overview.doneOfTotal', { done: summary.doneTasks, total: summary.totalTasks })
    },
    {
      label: t('charts.peakLoad'),
      value: String(peakWeeklyActive),
      sub: t('charts.peakUnit', { count: peakWeeklyActive }),
      alert: summary.overloadedAssignees > 0
    },
    {
      label: t('overview.overdue'),
      value: String(summary.overdueTasks),
      sub: paceLabel,
      alert: summary.overdueTasks > 0
    },
    {
      label: t('overview.criticalTasks'),
      value: String(summary.criticalTasks),
      sub: summary.projectedFinish
        ? `${t('overview.projectedFinish')}: ${formatDateShort(summary.projectedFinish)}`
        : t('overview.noCriticalPath')
    }
  ]

  renderMetricStrip(parent, stats)
}

function createChartCard(
  parent: HTMLElement,
  title: string,
  subtitle: string,
  wide = false
): { card: HTMLElement; headerRight: HTMLElement; body: HTMLElement } {
  const card = parent.createDiv(`pm-charts-card${wide ? ' pm-charts-card--wide' : ''}`)
  const head = card.createDiv('pm-charts-card-head')
  const titleBox = head.createDiv('pm-charts-card-titles')
  titleBox.createDiv({ cls: 'pm-charts-card-title', text: title })
  if (subtitle) {
    titleBox.createDiv({ cls: 'pm-charts-card-sub', text: subtitle })
  }
  const headerRight = head.createDiv('pm-charts-card-controls')
  const body = card.createDiv('pm-charts-card-body')
  return { card, headerRight, body }
}

function renderLegend(parent: HTMLElement, items: { label: string; color: string; dashed?: boolean }[]): void {
  const row = parent.createDiv('pm-charts-legend')
  for (const item of items) {
    const chip = row.createSpan({ cls: 'pm-charts-legend-item' })
    const swatch = chip.createSpan({
      cls: `pm-charts-legend-swatch${item.dashed ? ' pm-charts-legend-swatch--dashed' : ''}`
    })
    swatch.style.setProperty('--swatch-color', item.color)
    chip.createSpan({ text: item.label })
  }
}

function renderWeeklyHistogramCard(parent: HTMLElement, ctx: ChartsRenderContext): void {
  const { card, headerRight, body } = createChartCard(
    parent,
    t('charts.histogramHeading'),
    t('charts.histogramHint'),
    true
  )

  new SegmentedControl<HistogramBreakdownMode>(headerRight, {
    active: ctx.state.histogramMode,
    options: [
      { id: 'status', label: t('charts.byStatus') },
      { id: 'assignee', label: t('charts.byAssignee') }
    ],
    onChange: (mode) => {
      ctx.state.histogramMode = mode
      ctx.redraw()
    }
  })

  const buckets = ctx.data.weeklyHistogram
  const hasAny = buckets.some((b) => b.activeTotal > 0 || b.doneInWeek > 0)
  if (!hasAny) {
    body.createDiv({ cls: 'pm-overview-muted', text: t('charts.emptyNoScheduled') })
    return
  }

  const chartHost = body.createDiv('pm-charts-svg-host')
  const maxVal = Math.max(
    1,
    buckets.reduce((m, b) => Math.max(m, b.activeTotal, b.doneInWeek), 0)
  )

  const width = Math.max(560, buckets.length * 46 + 64)
  const height = 220
  const padL = 36
  const padR = 16
  const padT = 20
  const padB = 34
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const colW = plotW / Math.max(1, buckets.length)
  const barW = Math.min(30, Math.max(12, colW * 0.62))

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'pm-charts-svg',
    preserveAspectRatio: 'xMidYMid meet'
  })

  // Horizontal grid lines
  const gridSteps = Math.min(4, maxVal)
  for (let i = 0; i <= gridSteps; i++) {
    const val = Math.round((maxVal * i) / gridSteps)
    const y = padT + plotH - (val / maxVal) * plotH
    svg.appendChild(
      svgEl('line', {
        x1: padL,
        y1: y,
        x2: width - padR,
        y2: y,
        class: 'pm-charts-gridline'
      })
    )
    const label = svgEl('text', {
      x: padL - 6,
      y: y + 3,
      'text-anchor': 'end',
      class: 'pm-charts-axis-label'
    })
    label.textContent = String(val)
    svg.appendChild(label)
  }

  const orderedAssignees = ctx.data.histogramAssignees
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i]
    const cx = padL + i * colW + colW / 2
    const x = cx - barW / 2
    const selected = ctx.state.selectedWeekStart === bucket.weekStart

    if (bucket.isCurrentWeek) {
      svg.appendChild(
        svgEl('rect', {
          x: padL + i * colW + 2,
          y: padT - 4,
          width: Math.max(2, colW - 4),
          height: plotH + 8,
          rx: 4,
          class: 'pm-charts-current-band'
        })
      )
    }

    const group = svgEl('g', {
      class: `pm-charts-bar-group${selected ? ' is-selected' : ''}`
    })

    const segments = buildHistogramSegments(bucket, ctx.state.histogramMode, orderedAssignees)
    let curY = padT + plotH
    for (const seg of segments) {
      if (seg.value <= 0) continue
      const h = (seg.value / maxVal) * plotH
      curY -= h
      const rect = svgEl('rect', {
        x,
        y: curY,
        width: barW,
        height: Math.max(1, h),
        rx: 2,
        fill: seg.color,
        class: 'pm-charts-bar'
      })
      group.appendChild(rect)
    }

    if (bucket.activeTotal === 0) {
      group.appendChild(
        svgEl('rect', {
          x,
          y: padT + plotH - 2,
          width: barW,
          height: 2,
          fill: 'var(--background-modifier-border)'
        })
      )
    }

    if (bucket.activeTotal > 0) {
      const topLabel = svgEl('text', {
        x: cx,
        y: Math.max(11, curY - 4),
        'text-anchor': 'middle',
        class: 'pm-charts-bar-value'
      })
      topLabel.textContent =
        bucket.overloadDays > 0 ? `${bucket.activeTotal}⚡` : String(bucket.activeTotal)
      group.appendChild(topLabel)
    }

    // Completed thin dot marker in the week
    if (bucket.doneInWeek > 0) {
      const doneY = padT + plotH - (bucket.doneInWeek / maxVal) * plotH
      group.appendChild(
        svgEl('circle', {
          cx,
          cy: doneY,
          r: 3.5,
          fill: 'var(--color-green, #22c55e)',
          stroke: 'var(--background-primary)',
          'stroke-width': 1.5
        })
      )
    }

    // Click hit area covering whole column
    const hit = svgEl('rect', {
      x: padL + i * colW,
      y: padT,
      width: colW,
      height: plotH,
      fill: 'transparent',
      class: 'pm-charts-hit'
    })
    group.appendChild(hit)

    attachTooltip(chartHost, group, () => {
      const rangeText = t('charts.weekRange', {
        start: formatDateShort(bucket.weekStart),
        end: formatDateShort(bucket.weekEnd)
      })
      const lines = [
        bucket.isCurrentWeek ? `${rangeText} (${t('charts.currentWeek')})` : rangeText,
        `${t('charts.active')}: ${bucket.activeTotal} (${t('charts.onTrack')}: ${bucket.activeOnTrack}, ${t('charts.atRisk')}: ${bucket.activeAtRisk})`
      ]
      if (bucket.doneInWeek > 0) {
        lines.push(`${t('charts.completedInWeek')}: ${bucket.doneInWeek}`)
      }
      if (bucket.overloadDays > 0) {
        lines.push(`⚡ ${t('charts.overloadWeek')}`)
      }
      if (ctx.state.histogramMode === 'assignee') {
        for (const name of orderedAssignees) {
          const cnt = bucket.byAssignee[name] ?? 0
          if (cnt > 0) lines.push(`• ${displayAssignee(name)}: ${cnt}`)
        }
      }
      return lines
    })

    group.addEventListener('click', () => {
      ctx.state.selectedWeekStart =
        ctx.state.selectedWeekStart === bucket.weekStart ? null : bucket.weekStart
      ctx.redraw()
    })

    svg.appendChild(group)

    // X-axis label (skip every other if crowded)
    if (buckets.length <= 16 || i % 2 === 0 || bucket.isCurrentWeek) {
      const xl = svgEl('text', {
        x: cx,
        y: height - 10,
        'text-anchor': 'middle',
        class: `pm-charts-axis-label${bucket.isCurrentWeek ? ' is-current' : ''}`
      })
      xl.textContent = bucket.label
      svg.appendChild(xl)
    }
  }

  chartHost.appendChild(svg)

  if (ctx.state.histogramMode === 'status') {
    renderLegend(body, [
      { label: t('charts.onTrack'), color: 'var(--interactive-accent, #6366f1)' },
      { label: t('charts.atRisk'), color: 'var(--color-red, #ef4444)' },
      { label: t('charts.completedInWeek'), color: 'var(--color-green, #22c55e)' }
    ])
  } else {
    renderLegend(
      body,
      orderedAssignees.map((name) => ({
        label: displayAssignee(name),
        color: colorForAssignee(name, orderedAssignees)
      }))
    )
  }

  if (ctx.state.selectedWeekStart) {
    const selectedBucket = buckets.find((b) => b.weekStart === ctx.state.selectedWeekStart)
    if (selectedBucket) {
      const range = t('charts.weekRange', {
        start: formatDateShort(selectedBucket.weekStart),
        end: formatDateShort(selectedBucket.weekEnd)
      })
      renderDrilldownPanel(card, range, selectedBucket.taskIds, ctx, () => {
        ctx.state.selectedWeekStart = null
        ctx.redraw()
      })
    }
  }
}

function buildHistogramSegments(
  bucket: WeeklyWorkloadBucket,
  mode: HistogramBreakdownMode,
  orderedAssignees: string[]
): { color: string; value: number }[] {
  if (mode === 'status') {
    return [
      { color: 'var(--interactive-accent, #6366f1)', value: bucket.activeOnTrack },
      { color: 'var(--color-red, #ef4444)', value: bucket.activeAtRisk }
    ]
  }
  return orderedAssignees.map((name) => ({
    color: colorForAssignee(name, orderedAssignees),
    value: bucket.byAssignee[name] ?? 0
  }))
}

function renderAssigneeDistributionCard(parent: HTMLElement, ctx: ChartsRenderContext): void {
  const { card, body } = createChartCard(
    parent,
    t('charts.assigneeHeading'),
    t('charts.assigneeHint')
  )

  const rows = ctx.data.assigneeDistribution
  if (rows.length === 0) {
    body.createDiv({ cls: 'pm-overview-muted', text: t('charts.noAssignees') })
    return
  }

  const maxTotal = Math.max(1, ...rows.map((r) => r.total))
  const list = body.createDiv('pm-charts-hbar-list')

  for (const row of rows) {
    renderAssigneeHBarRow(list, row, maxTotal, ctx)
  }

  renderLegend(body, [
    { label: t('charts.overdue'), color: 'var(--color-red, #ef4444)' },
    { label: t('charts.active'), color: 'var(--interactive-accent, #6366f1)' },
    { label: t('charts.done'), color: 'var(--color-green, #22c55e)' }
  ])

  if (ctx.state.selectedAssignee) {
    const selected = rows.find((r) => r.assignee === ctx.state.selectedAssignee)
    if (selected) {
      renderDrilldownPanel(
        card,
        displayAssignee(selected.assignee),
        selected.taskIds,
        ctx,
        () => {
          ctx.state.selectedAssignee = null
          ctx.redraw()
        }
      )
    }
  }
}

function renderAssigneeHBarRow(
  parent: HTMLElement,
  row: AssigneeChartRow,
  maxTotal: number,
  ctx: ChartsRenderContext
): void {
  const selected = ctx.state.selectedAssignee === row.assignee
  const item = parent.createDiv(`pm-charts-hbar-row${selected ? ' is-selected' : ''}`)

  const labelBox = item.createDiv('pm-charts-hbar-label')
  if (!row.isUnassigned) {
    new Avatar(labelBox).setName(row.assignee).setSize('sm')
  }
  labelBox.createSpan({
    cls: `pm-charts-hbar-name${row.isUnassigned ? ' is-unassigned' : ''}`,
    text: displayAssignee(row.assignee)
  })

  const trackWrap = item.createDiv('pm-charts-hbar-track-wrap')
  const track = trackWrap.createDiv('pm-charts-hbar-track')
  const trackPct = (row.total / maxTotal) * 100
  const fill = track.createDiv('pm-charts-hbar-fill')
  fill.style.width = `${Math.max(4, trackPct)}%`

  const appendSegment = (count: number, cls: string, titleText: string): void => {
    if (count <= 0) return
    const seg = fill.createDiv(`pm-charts-hbar-seg ${cls}`)
    seg.style.width = `${(count / row.total) * 100}%`
    seg.setAttribute('title', `${titleText}: ${count}`)
  }

  appendSegment(row.overdue, 'is-overdue', t('charts.overdue'))
  appendSegment(row.activeOnTrack, 'is-active', t('charts.active'))
  appendSegment(row.done, 'is-done', t('charts.done'))

  const stats = item.createDiv('pm-charts-hbar-stats')
  stats.createSpan({
    cls: 'pm-charts-hbar-count',
    text: `${row.overdue + row.activeOnTrack}/${row.total}`
  })
  if (!row.isUnassigned && row.overloadDaysCount > 0) {
    new Chip(stats)
      .setLabel(t('charts.maxConcurrent', { count: row.maxConcurrentTasks }))
      .setVariant('outline')
      .setColor('var(--color-orange, var(--color-red))')
      .setSize('sm')
  }

  item.addEventListener('click', () => {
    ctx.state.selectedAssignee =
      ctx.state.selectedAssignee === row.assignee ? null : row.assignee
    ctx.redraw()
  })
}

function renderBurnupCard(parent: HTMLElement, ctx: ChartsRenderContext): void {
  const { burnup } = ctx.data
  const paceNote =
    burnup.paceDelta > 0
      ? tn('charts.paceAhead', burnup.paceDelta)
      : burnup.paceDelta < 0
        ? tn('charts.paceBehind', -burnup.paceDelta)
        : t('charts.onPace')

  const { headerRight, body } = createChartCard(
    parent,
    t('charts.burnupHeading'),
    t('charts.burnupHint')
  )

  new Chip(headerRight)
    .setLabel(paceNote)
    .setVariant(burnup.paceDelta < 0 ? 'outline' : 'solid')
    .setColor(
      burnup.paceDelta < 0
        ? 'var(--color-orange, var(--color-red))'
        : 'var(--color-green, #22c55e)'
    )
    .setSize('sm')

  const points = burnup.points
  if (points.length === 0) {
    body.createDiv({ cls: 'pm-overview-muted', text: t('charts.emptyNoData') })
    return
  }

  const chartHost = body.createDiv('pm-charts-svg-host')
  const maxVal = Math.max(
    1,
    ...points.map((p) =>
      Math.max(p.totalScope, p.plannedDue, p.baselinePlannedDue ?? 0, p.actualCompleted ?? 0)
    )
  )

  const width = 460
  const height = 220
  const padL = 34
  const padR = 16
  const padT = 18
  const padB = 34
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  const xOf = (idx: number): number =>
    points.length <= 1 ? padL + plotW / 2 : padL + (idx / (points.length - 1)) * plotW
  const yOf = (val: number): number => padT + plotH - (val / maxVal) * plotH

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'pm-charts-svg',
    preserveAspectRatio: 'xMidYMid meet'
  })

  const gridSteps = Math.min(4, maxVal)
  for (let i = 0; i <= gridSteps; i++) {
    const val = Math.round((maxVal * i) / gridSteps)
    const y = yOf(val)
    svg.appendChild(
      svgEl('line', {
        x1: padL,
        y1: y,
        x2: width - padR,
        y2: y,
        class: 'pm-charts-gridline'
      })
    )
    const label = svgEl('text', {
      x: padL - 6,
      y: y + 3,
      'text-anchor': 'end',
      class: 'pm-charts-axis-label'
    })
    label.textContent = String(val)
    svg.appendChild(label)
  }

  const buildPath = (coords: { x: number; y: number }[]): string =>
    coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')

  // Total scope line (subtle dashed)
  const scopeCoords = points.map((p, i) => ({ x: xOf(i), y: yOf(p.totalScope) }))
  svg.appendChild(
    svgEl('path', {
      d: buildPath(scopeCoords),
      fill: 'none',
      stroke: 'var(--text-muted, #888)',
      'stroke-width': 1.5,
      'stroke-dasharray': '4 3'
    })
  )

  // Baseline planned line if available
  if (burnup.hasBaseline) {
    const baseCoords = points.map((p, i) => ({
      x: xOf(i),
      y: yOf(p.baselinePlannedDue ?? 0)
    }))
    svg.appendChild(
      svgEl('path', {
        d: buildPath(baseCoords),
        fill: 'none',
        stroke: 'var(--color-orange, #f97316)',
        'stroke-width': 1.5,
        'stroke-dasharray': '2 3'
      })
    )
  }

  // Planned line
  const plannedCoords = points.map((p, i) => ({ x: xOf(i), y: yOf(p.plannedDue) }))
  svg.appendChild(
    svgEl('path', {
      d: buildPath(plannedCoords),
      fill: 'none',
      stroke: 'var(--interactive-accent, #6366f1)',
      'stroke-width': 2
    })
  )

  // Actual completed line (only up to current week)
  const actualCoords = points
    .map((p, i) => (p.actualCompleted !== null ? { x: xOf(i), y: yOf(p.actualCompleted) } : null))
    .filter((pt): pt is { x: number; y: number } => pt !== null)

  if (actualCoords.length > 0) {
    // Soft green area fill under actual curve
    const last = actualCoords[actualCoords.length - 1]
    const first = actualCoords[0]
    const areaD = `${buildPath(actualCoords)} L ${last.x.toFixed(1)} ${padT + plotH} L ${first.x.toFixed(1)} ${padT + plotH} Z`
    svg.appendChild(
      svgEl('path', {
        d: areaD,
        fill: 'var(--color-green, #22c55e)',
        'fill-opacity': 0.14
      })
    )
    svg.appendChild(
      svgEl('path', {
        d: buildPath(actualCoords),
        fill: 'none',
        stroke: 'var(--color-green, #22c55e)',
        'stroke-width': 2.5
      })
    )
    svg.appendChild(
      svgEl('circle', {
        cx: last.x,
        cy: last.y,
        r: 4,
        fill: 'var(--color-green, #22c55e)',
        stroke: 'var(--background-primary)',
        'stroke-width': 1.5
      })
    )
  }

  // Hover columns per point + sparse X-axis labels
  const colSpan = points.length > 1 ? plotW / (points.length - 1) : plotW
  const labelStride = Math.max(1, Math.ceil(points.length / 6))
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const cx = xOf(i)
    const hit = svgEl('rect', {
      x: Math.max(padL, cx - colSpan / 2),
      y: padT,
      width: colSpan,
      height: plotH,
      fill: 'transparent',
      class: 'pm-charts-hit'
    })
    attachTooltip(chartHost, hit, () => burnupTooltipLines(p, burnup.hasBaseline))
    svg.appendChild(hit)

    if (i % labelStride === 0 || i === points.length - 1) {
      const xl = svgEl('text', {
        x: cx,
        y: height - 10,
        'text-anchor': 'middle',
        class: 'pm-charts-axis-label'
      })
      xl.textContent = p.label
      svg.appendChild(xl)
    }
  }

  chartHost.appendChild(svg)

  const legendItems = [
    { label: t('charts.totalScope'), color: 'var(--text-muted, #888)', dashed: true },
    { label: t('charts.planned'), color: 'var(--interactive-accent, #6366f1)' },
    { label: t('charts.actualCompleted'), color: 'var(--color-green, #22c55e)' }
  ]
  if (burnup.hasBaseline) {
    legendItems.splice(2, 0, {
      label: t('charts.baselinePlanned'),
      color: 'var(--color-orange, #f97316)',
      dashed: true
    })
  }
  renderLegend(body, legendItems)
}

function burnupTooltipLines(p: BurnupPoint, hasBaseline: boolean): string[] {
  const lines = [
    t('charts.weekRange', {
      start: formatDateShort(p.weekStart),
      end: formatDateShort(p.weekEnd)
    }),
    `${t('charts.totalScope')}: ${p.totalScope}`,
    `${t('charts.planned')}: ${p.plannedDue}`
  ]
  if (hasBaseline && p.baselinePlannedDue !== null) {
    lines.push(`${t('charts.baselinePlanned')}: ${p.baselinePlannedDue}`)
  }
  if (p.actualCompleted !== null) {
    lines.push(`${t('charts.actualCompleted')}: ${p.actualCompleted}`)
  }
  return lines
}

function slackMeta(key: SlackBucketKey): { label: string; color: string } {
  switch (key) {
    case 'overdue':
      return { label: t('charts.overdue'), color: 'var(--color-red, #ef4444)' }
    case 'critical':
      return { label: t('charts.critical'), color: 'var(--color-orange, #f97316)' }
    case 'nearCritical':
      return { label: t('charts.nearCritical'), color: 'var(--color-yellow, #eab308)' }
    case 'comfortable':
      return { label: t('charts.comfortable'), color: 'var(--color-green, #22c55e)' }
    case 'unscheduled':
      return { label: t('charts.unscheduled'), color: 'var(--text-faint, #9ca3af)' }
  }
}

function renderSlackProfileCard(parent: HTMLElement, ctx: ChartsRenderContext): void {
  const { card, body } = createChartCard(
    parent,
    t('charts.slackHeading'),
    t('charts.slackHint')
  )

  const { buckets, totalActive } = ctx.data.slackProfile
  if (totalActive === 0) {
    body.createDiv({ cls: 'pm-overview-muted', text: t('dashboard.noPendingSteps') })
    return
  }

  // Interactive proportional segmented bar
  const segBar = body.createDiv('pm-charts-slack-bar')
  for (const bucket of buckets) {
    if (bucket.count === 0) continue
    const meta = slackMeta(bucket.key)
    const seg = segBar.createDiv(
      `pm-charts-slack-seg${ctx.state.selectedSlackBucket === bucket.key ? ' is-selected' : ''}`
    )
    seg.style.width = `${(bucket.count / totalActive) * 100}%`
    seg.style.backgroundColor = meta.color
    seg.setAttribute('title', `${meta.label}: ${bucket.count}`)
    seg.addEventListener('click', () => {
      ctx.state.selectedSlackBucket =
        ctx.state.selectedSlackBucket === bucket.key ? null : bucket.key
      ctx.redraw()
    })
  }

  // Clickable breakdown rows
  const rows = body.createDiv('pm-charts-slack-list')
  for (const bucket of buckets) {
    renderSlackBucketRow(rows, bucket, totalActive, ctx)
  }

  if (ctx.state.selectedSlackBucket) {
    const picked = buckets.find((b) => b.key === ctx.state.selectedSlackBucket)
    if (picked) {
      renderDrilldownPanel(
        card,
        slackMeta(picked.key).label,
        picked.taskIds,
        ctx,
        () => {
          ctx.state.selectedSlackBucket = null
          ctx.redraw()
        }
      )
    }
  }
}

function renderSlackBucketRow(
  parent: HTMLElement,
  bucket: SlackBucket,
  totalActive: number,
  ctx: ChartsRenderContext
): void {
  const meta = slackMeta(bucket.key)
  const selected = ctx.state.selectedSlackBucket === bucket.key
  const row = parent.createDiv(`pm-charts-slack-row${selected ? ' is-selected' : ''}`)

  const left = row.createDiv('pm-charts-slack-left')
  const dot = left.createSpan({ cls: 'pm-charts-status-dot' })
  dot.style.backgroundColor = meta.color
  left.createSpan({ text: meta.label })

  const barWrap = row.createDiv('pm-charts-slack-mini-track')
  const fill = barWrap.createDiv('pm-charts-slack-mini-fill')
  fill.style.width = `${totalActive > 0 ? (bucket.count / totalActive) * 100 : 0}%`
  fill.style.backgroundColor = meta.color

  const pct = totalActive > 0 ? Math.round((bucket.count / totalActive) * 100) : 0
  row.createSpan({
    cls: 'pm-charts-slack-count',
    text: `${bucket.count} (${pct}%)`
  })

  if (bucket.count > 0) {
    row.addEventListener('click', () => {
      ctx.state.selectedSlackBucket =
        ctx.state.selectedSlackBucket === bucket.key ? null : bucket.key
      ctx.redraw()
    })
  }
}

function renderBaselineVarianceCard(parent: HTMLElement, ctx: ChartsRenderContext): void {
  const bv = ctx.data.baselineVariance
  const { body } = createChartCard(
    parent,
    t('charts.baselineHeading'),
    t('charts.baselineHint', { count: bv.trackedCount })
  )

  const deviated = bv.items.filter((i) => i.deltaDays !== 0)
  if (deviated.length === 0) {
    body.createDiv({ cls: 'pm-overview-muted', text: t('charts.noDeadlineVariance') })
    return
  }

  const maxAbs = Math.max(1, ...deviated.map((i) => Math.abs(i.deltaDays)))
  const list = body.createDiv('pm-charts-variance-list')

  for (const item of deviated.slice(0, 8)) {
    const row = list.createDiv('pm-charts-variance-row')
    const titleEl = row.createSpan({ cls: 'pm-charts-variance-title', text: item.title })
    titleEl.setAttribute(
      'title',
      `${item.title}: ${formatDateShort(item.baselineDue)} → ${formatDateShort(item.currentDue)}`
    )

    const diverging = row.createDiv('pm-charts-variance-track')
    const leftSide = diverging.createDiv('pm-charts-variance-half is-left')
    diverging.createDiv('pm-charts-variance-axis')
    const rightSide = diverging.createDiv('pm-charts-variance-half is-right')

    const pct = (Math.abs(item.deltaDays) / maxAbs) * 100
    if (item.deltaDays < 0) {
      const bar = leftSide.createDiv('pm-charts-variance-bar is-ahead')
      bar.style.width = `${Math.max(8, pct)}%`
    } else {
      const bar = rightSide.createDiv('pm-charts-variance-bar is-late')
      bar.style.width = `${Math.max(8, pct)}%`
    }

    row.createSpan({
      cls: `pm-charts-variance-delta ${item.deltaDays > 0 ? 'is-late' : 'is-ahead'}`,
      text: item.deltaDays > 0 ? `+${item.deltaDays}d` : `${item.deltaDays}d`
    })

    row.addEventListener('click', () => {
      const task = ctx.data.taskLookup.get(item.taskId)
      if (!task) return
      openTaskModal(ctx.plugin, ctx.project, {
        task,
        onSave: async () => {
          ctx.redraw()
        }
      })
    })
  }

  renderLegend(body, [
    { label: t('charts.ahead'), color: 'var(--color-green, #22c55e)' },
    { label: t('charts.slipped'), color: 'var(--color-red, #ef4444)' }
  ])
}

function renderEffortCard(parent: HTMLElement, ctx: ChartsRenderContext): void {
  const { summary, effortByAssignee } = ctx.data
  const { body } = createChartCard(
    parent,
    t('charts.effortHeading'),
    t('charts.effortHint', {
      logged: summary.loggedHours,
      estimated: summary.estimatedHours
    })
  )

  const maxH = Math.max(
    1,
    ...effortByAssignee.map((r) => Math.max(r.estimatedHours, r.loggedHours))
  )

  const list = body.createDiv('pm-charts-effort-list')
  for (const row of effortByAssignee) {
    const item = list.createDiv('pm-charts-effort-row')
    const head = item.createDiv('pm-charts-effort-head')
    head.createSpan({ cls: 'pm-charts-effort-name', text: displayAssignee(row.assignee) })
    const over = row.estimatedHours > 0 && row.loggedHours > row.estimatedHours
    head.createSpan({
      cls: `pm-charts-effort-nums${over ? ' is-over' : ''}`,
      text: `${row.loggedHours}h / ${row.estimatedHours}h (${row.utilizationPct}%)`
    })

    const bars = item.createDiv('pm-charts-effort-bars')
    const estBar = bars.createDiv('pm-charts-effort-bar is-estimated')
    estBar.style.width = `${(row.estimatedHours / maxH) * 100}%`

    const logBar = bars.createDiv(`pm-charts-effort-bar is-logged${over ? ' is-over' : ''}`)
    logBar.style.width = `${(row.loggedHours / maxH) * 100}%`
  }

  renderLegend(body, [
    { label: t('charts.estimated'), color: 'var(--text-faint, #9ca3af)' },
    { label: t('charts.logged'), color: 'var(--interactive-accent, #6366f1)' },
    { label: t('charts.overEstimate'), color: 'var(--color-red, #ef4444)' }
  ])
}
