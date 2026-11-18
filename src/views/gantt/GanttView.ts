import type { Scope } from 'obsidian'
import type PMPlugin from '#main'
import {
  type CriticalPathResult,
  type GanttGranularity,
  type GanttRowItem,
  type NonWorkingDays,
  type Project,
  type Task,
  type TaskQuery,
  type ViewFields,
  buildGanttRows,
  flattenTasks,
  makeTask,
  shownFields,
  computeScopeWorkload,
  Temporal,
  today,
  t
} from '@dotpm/core'
import { personKeyer, type ProjectScope } from '#store'
import {
  drawRowHover,
  renderAddButton,
  svgEl,
  type GanttDayKind,
  type TimelineCfg,
  buildTimelineConfig,
  clampZoom,
  dateToX,
  nonWorkingDay,
  xToDate,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  LABEL_WIDTH
} from '@dotpm/ui'
import { openAddTask } from '../addTask'
import type { SubView } from '../SubView'
import { collapsedGanttProjectPaths, collapsedTaskIds } from '../collapse'
import { makeDragState } from './GanttDragHandler'
import type { DragState } from './GanttDragHandler'
import { makeLinkState, cancelLink } from './GanttLinkHandler'
import type { LinkState } from './GanttLinkHandler'
import {
  drawSummaryBar,
  renderTimelineHeader,
  renderGridLines,
  renderTodayLine,
  renderTaskBar,
  renderDependencyArrows,
  renderMilestoneLabels
} from './GanttRenderer'
import type { RendererContext } from './GanttRenderer'
import { renderProjectLabel, renderTaskLabel } from './TaskLabelRenderer'

export class GanttView implements SubView {
  private scrollEl!: HTMLElement
  private svgEl!: SVGSVGElement
  private headerSvgEl!: SVGSVGElement
  private rows: GanttRowItem<Project>[] = []
  private criticalPath: CriticalPathResult = {
    projectFinish: '',
    tasks: {},
    criticalTaskIds: [],
    criticalEdges: [],
    cycles: []
  }
  /** Read from settings once per render pass. */
  private collapsedIds: ReadonlySet<string> = new Set()
  private collapsedProjectPaths: ReadonlySet<string> = new Set()
  private overloadedTaskIds: ReadonlySet<string> = new Set()
  private cfg!: TimelineCfg
  private drag: DragState = makeDragState()
  private link: LinkState = makeLinkState()
  private labelWidth: number = LABEL_WIDTH

  getLabelWidth(): number {
    return this.labelWidth
  }
  setLabelWidth(w: number): void {
    this.labelWidth = w
  }
  private cleanupFns: (() => void)[] = []
  /** `anchorDate` lands `offset` px from the left edge; without one, at the edge. */
  private pendingScroll: { top: number; anchorDate: Temporal.PlainDate; offset?: number } | null = null
  private zoomFrame: number | null = null

  constructor(
    private container: HTMLElement,
    private scope: ProjectScope,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    private query: TaskQuery,
    private granularity: GanttGranularity,
    private keyScope: Scope,
    private fields: ViewFields,
    private zoom: number,
    private nonWorkingDays: NonWorkingDays,
    private showCriticalPath: boolean,
    private showBaseline: boolean,
    /** Ctrl+scroll changed the zoom. */
    private onZoom: (zoom: number) => void,
    private showWorkload = false
  ) {}

  getShowWorkload(): boolean {
    return this.showWorkload
  }
  setShowWorkload(show: boolean): void {
    this.showWorkload = show
    this.render()
  }
  toggleWorkload(): void {
    this.setShowWorkload(!this.showWorkload)
  }

  /** Redraws at `zoom`, keeping the date at `clientX` (or the middle of the chart) where it was. */
  setZoom(zoom: number, clientX?: number): void {
    if (!this.scrollEl) return
    const rect = this.scrollEl.getBoundingClientRect()
    const offset = clientX === undefined ? this.scrollEl.clientWidth / 2 : clientX - rect.left
    this.pendingScroll = {
      top: this.scrollEl.scrollTop,
      anchorDate: xToDate(this.cfg, this.scrollEl.scrollLeft + offset),
      offset
    }
    this.zoom = zoom
    this.render()
  }

  /** Ctrl+scroll (pinch on a trackpad) zooms around the pointer, one redraw per frame. */
  private handleZoomWheel(e: WheelEvent): void {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const next = clampZoom(this.zoom * Math.exp(-e.deltaY / 300))
    if (next === this.zoom) return
    this.zoom = next
    const clientX = e.clientX
    if (this.zoomFrame !== null) return
    this.zoomFrame = window.requestAnimationFrame(() => {
      this.zoomFrame = null
      this.setZoom(this.zoom, clientX)
      this.onZoom(this.zoom)
    })
  }

  destroy(): void {
    if (this.zoomFrame !== null) window.cancelAnimationFrame(this.zoomFrame)
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
  }

  getScrollPosition(): { top: number; anchorDate: Temporal.PlainDate } {
    const top = this.scrollEl?.scrollTop ?? 0
    const anchorDate = this.scrollEl ? xToDate(this.cfg, this.scrollEl.scrollLeft) : today()
    return { top, anchorDate }
  }

  setPendingScroll(pos: { top: number; anchorDate: Temporal.PlainDate }): void {
    this.pendingScroll = pos
  }

  refresh(): void {
    this.pendingScroll = this.getScrollPosition()
    this.render()
  }

  render(): void {
    this.cleanupFns.forEach((fn) => fn())
    this.cleanupFns = []
    cancelLink(this.link)
    this.container.empty()
    this.container.addClass('pm-gantt-view')

    this.collapsedIds = collapsedTaskIds(this.plugin.settings, this.scope.projects)
    this.collapsedProjectPaths = collapsedGanttProjectPaths(this.plugin.settings, this.scope.projects)
    const filterCtx = this.scope.filterContext(personKeyer(this.plugin.app))
    const { rows, timelineTasks } = buildGanttRows({
      projects: this.scope.projects,
      isMulti: this.scope.isMulti,
      query: this.query,
      statusesOf: (project) => this.plugin.store.configFor(project).statuses,
      filterContextOf: () => filterCtx,
      collapsedTaskIds: this.collapsedIds,
      collapsedProjectPaths: this.collapsedProjectPaths
    })
    this.rows = rows
    const extraWorkdays = this.scope.projects.flatMap((p) => this.plugin.store.configFor(p).extraWorkdays)
    const extraNonWorkdays = this.scope.projects.flatMap((p) => this.plugin.store.configFor(p).extraNonWorkdays)
    const primaryCfg = !this.scope.isMulti && this.scope.primary
      ? this.plugin.store.configFor(this.scope.primary)
      : null
    const workingWeekdays = primaryCfg?.workingWeekdays
    this.criticalPath = this.scope.criticalPath(this.plugin.settings.holidays, this.externalPredecessors())
    const workloadResult = computeScopeWorkload(this.scope.tasks(), this.scope.config.statuses, {
      workingWeekdays,
      holidays: this.plugin.settings.holidays,
      extraWorkdays,
      extraNonWorkdays
    })
    this.overloadedTaskIds = workloadResult.overloadedTaskIds
    this.cfg = buildTimelineConfig(timelineTasks, this.granularity, {
      zoom: this.zoom,
      isHidden: nonWorkingDay(this.nonWorkingDays, this.plugin.settings.holidays, {
        workingWeekdays,
        extraWorkdays,
        extraNonWorkdays
      }),
      minWidth: this.container.clientWidth - this.labelWidth,
      includeBaseline: this.showBaseline
    })

    this.renderGantt()
  }

  private externalPredecessors(): Task[] {
    const seen = new Set<string>()
    const externals: Task[] = []
    const queue: string[] = []
    for (const p of this.scope.projects) {
      for (const ft of flattenTasks(p.tasks)) {
        for (const depId of ft.task.dependencies) queue.push(depId)
      }
    }
    while (queue.length > 0) {
      const id = queue.shift()
      if (!id || seen.has(id) || this.scope.taskById(id)) continue
      seen.add(id)
      const ref = this.plugin.index.task(id)
      if (!ref) continue
      externals.push(
        makeTask({
          id: ref.id,
          title: ref.title,
          status: ref.status,
          start: ref.start,
          due: ref.due,
          completed: ref.completed,
          dependencies: ref.dependencies,
          replacedBy: ref.replacedBy,
          archived: ref.archived
        })
      )
      if (ref.replacedBy) queue.push(ref.replacedBy)
    }
    return externals
  }

  private renderGantt(): void {
    const wrapper = this.container.createDiv('pm-gantt-wrapper')

    const leftPanel = wrapper.createDiv('pm-gantt-left')
    leftPanel.style.width = `${this.labelWidth}px`
    leftPanel.style.minWidth = `${this.labelWidth}px`
    const leftHeader = leftPanel.createDiv('pm-gantt-left-header')
    leftHeader.style.height = `${HEADER_HEIGHT}px`
    leftHeader.createSpan({ text: t('columns.task'), cls: 'pm-gantt-left-header-label' })
    const leftBody = leftPanel.createDiv('pm-gantt-left-body')

    const resizeHandle = wrapper.createDiv('pm-gantt-resize-handle')
    let resizing = false
    let startX = 0
    let startWidth = 0
    resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      resizing = true
      startX = e.clientX
      startWidth = this.labelWidth
      activeDocument.body.addClass('pm-resize-active')
    })
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing) return
      const newWidth = Math.max(150, Math.min(600, startWidth + (e.clientX - startX)))
      this.labelWidth = newWidth
      leftPanel.style.width = `${newWidth}px`
      leftPanel.style.minWidth = `${newWidth}px`
    }
    const onMouseUp = () => {
      if (!resizing) return
      resizing = false
      activeDocument.body.removeClass('pm-resize-active')
    }
    activeDocument.addEventListener('mousemove', onMouseMove)
    activeDocument.addEventListener('mouseup', onMouseUp)
    this.cleanupFns.push(() => {
      activeDocument.removeEventListener('mousemove', onMouseMove)
      activeDocument.removeEventListener('mouseup', onMouseUp)
    })

    const rightPanel = wrapper.createDiv('pm-gantt-right')
    this.scrollEl = rightPanel
    rightPanel.addEventListener('wheel', (e) => this.handleZoomWheel(e), { passive: false })

    // The header has its own SVG in a sticky wrapper: it shares the body's horizontal
    // scroll but pins to the top, so the time period stays visible as rows scroll.
    const headerSticky = rightPanel.createDiv('pm-gantt-header-sticky')
    headerSticky.style.width = `${this.cfg.totalWidth}px`
    headerSticky.style.height = `${HEADER_HEIGHT}px`
    this.headerSvgEl = svgEl('svg', {
      width: this.cfg.totalWidth,
      height: HEADER_HEIGHT,
      class: 'pm-gantt-header-svg'
    })
    headerSticky.appendChild(this.headerSvgEl)

    const svgContainer = rightPanel.createDiv('pm-gantt-svg-container')
    svgContainer.style.width = `${this.cfg.totalWidth}px`
    // Tuck the body's top band (still drawn at y=HEADER_HEIGHT) under the sticky header.
    svgContainer.style.marginTop = `-${HEADER_HEIGHT}px`

    const totalRows = this.rows.length
    const svgHeight = HEADER_HEIGHT + (totalRows + 1) * ROW_HEIGHT // +1 for add-task row

    this.svgEl = svgEl('svg', {
      width: this.cfg.totalWidth,
      height: svgHeight,
      class: 'pm-gantt-svg'
    })
    svgContainer.appendChild(this.svgEl)

    const undo = () => {
      if (this.drag.isDragging) return
      void this.plugin.undoLastAction()
      return false
    }
    const redo = () => {
      if (this.drag.isDragging) return
      void this.plugin.redoLastAction()
      return false
    }
    const keyHandlers = [
      this.keyScope.register([], 'Escape', () => {
        if (this.link.active) cancelLink(this.link)
      }),
      this.keyScope.register(['Mod'], 'z', undo),
      this.keyScope.register(['Mod', 'Shift'], 'z', redo),
      this.keyScope.register(['Mod'], 'y', redo)
    ]
    this.cleanupFns.push(() => {
      for (const handler of keyHandlers) this.keyScope.unregister(handler)
    })

    const ctx = this.makeRendererContext()
    renderTimelineHeader(ctx)
    renderGridLines(ctx, totalRows)
    renderTodayLine(ctx, svgHeight)
    this.renderTaskRows(leftBody, ctx)
    renderDependencyArrows(ctx)
    renderMilestoneLabels(ctx)
    this.attachHoverTooltip(wrapper)

    // The left panel is overflow:hidden, so its wheel events would be swallowed.
    const onLeftWheel = (e: WheelEvent) => {
      rightPanel.scrollTop += e.deltaY
      rightPanel.scrollLeft += e.deltaX
      e.preventDefault()
    }
    leftPanel.addEventListener('wheel', onLeftWheel, { passive: false })
    this.cleanupFns.push(() => leftPanel.removeEventListener('wheel', onLeftWheel))

    const addRow = leftBody.createDiv('pm-gantt-label-row pm-gantt-add-row')
    addRow.style.height = `${ROW_HEIGHT}px`
    renderAddButton(addRow, t('task.add'), (e) => {
      openAddTask(this.plugin, this.scope, { event: e, onSave: () => this.onRefresh() })
    })

    // The right panel's horizontal scrollbar eats into its viewport height, letting it
    // scroll further than the left body; without this spacer the rows desync at the bottom.
    const leftSpacer = leftBody.createDiv()
    leftSpacer.addClass('pm-no-shrink')
    const syncSpacer = () => {
      const hScrollbarH = rightPanel.offsetHeight - rightPanel.clientHeight
      leftSpacer.style.height = `${hScrollbarH}px`
    }

    rightPanel.addEventListener('scroll', () => {
      syncSpacer()
      leftBody.scrollTop = rightPanel.scrollTop
    })

    window.requestAnimationFrame(() => {
      syncSpacer()
      if (this.pendingScroll) {
        this.scrollEl.scrollTop = this.pendingScroll.top
        const { anchorDate, offset = 0 } = this.pendingScroll
        this.scrollEl.scrollLeft = Math.max(0, dateToX(this.cfg, anchorDate) - offset)
        this.pendingScroll = null
      } else {
        this.scrollToToday()
      }
    })
  }

  private renderTaskRows(leftBody: HTMLElement, ctx: RendererContext): void {
    const barsGroup = svgEl('g', { class: 'pm-gantt-bars' })
    this.svgEl.appendChild(barsGroup)

    const labelCtx = {
      plugin: this.plugin,
      scope: this.scope,
      statuses: this.scope.config.statuses,
      collapsedIds: this.collapsedIds,
      criticalPath: this.criticalPath,
      showCriticalPath: this.showCriticalPath,
      showWorkload: this.showWorkload,
      overloadedTaskIds: this.overloadedTaskIds,
      onRefresh: this.onRefresh
    }

    for (const item of this.rows) {
      if (item.kind === 'project') {
        renderProjectLabel(
          leftBody,
          item.project,
          item.summary,
          this.collapsedProjectPaths.has(item.project.filePath),
          labelCtx
        )
        drawRowHover(barsGroup, ctx, item.rowIndex)
        drawSummaryBar(
          barsGroup,
          ctx,
          {
            title: item.project.title,
            color: item.project.color,
            ...item.summary
          },
          item.rowIndex,
          this.showBaseline
        )
      } else {
        renderTaskLabel(leftBody, item.task, item.depth, item.rowIndex, labelCtx)
        renderTaskBar(barsGroup, item.task, item.rowIndex, item.depth, ctx)
      }
    }
  }

  private makeRendererContext(): RendererContext {
    const extraWorkdaySet = new Set(
      this.scope.projects.flatMap((p) => this.plugin.store.configFor(p).extraWorkdays)
    )
    const extraNonWorkdaySet = new Set(
      this.scope.projects.flatMap((p) => this.plugin.store.configFor(p).extraNonWorkdays)
    )
    const holidaySet = new Set(this.plugin.settings.holidays)
    const primaryWeekdays = !this.scope.isMulti && this.scope.primary
      ? this.plugin.store.configFor(this.scope.primary).workingWeekdays
      : this.plugin.settings.workingWeekdays
    const weekdaySet = new Set(primaryWeekdays)
    const dayKind = (date: Temporal.PlainDate): GanttDayKind => {
      const iso = date.toString()
      if (extraNonWorkdaySet.has(iso)) return 'time-off'
      if (extraWorkdaySet.has(iso)) return 'extra-working'
      if (holidaySet.has(iso)) return 'time-off'
      return weekdaySet.has(date.dayOfWeek) ? 'working' : 'off-week'
    }

    return {
      svgEl: this.svgEl,
      headerSvgEl: this.headerSvgEl,
      cfg: this.cfg,
      weekLabel: this.plugin.settings.ganttWeekLabel,
      dayKind,
      plugin: this.plugin,
      scope: this.scope,
      statuses: this.scope.config.statuses,
      labelFields: shownFields(this.fields, 'gantt', this.scope.fieldCatalog()).filter((id) => id !== 'title'),
      labelSource: {
        statuses: this.scope.config.statuses,
        priorities: this.scope.config.priorities,
        customFields: this.scope.customFields()
      },
      taskRows: this.rows
        .filter((item): item is Extract<GanttRowItem<Project>, { kind: 'task' }> => item.kind === 'task')
        .map((item) => ({ task: item.task, depth: item.depth, row: item.rowIndex })),
      totalRows: this.rows.length,
      criticalPath: this.criticalPath,
      showCriticalPath: this.showCriticalPath,
      showBaseline: this.showBaseline,
      showWorkload: this.showWorkload,
      overloadedTaskIds: this.overloadedTaskIds,
      collapsedIds: this.collapsedIds,
      scheduleOptionsOf: (taskId: string) => {
        const cfg = this.scope.configOf(taskId)
        return {
          workdaysOnly: cfg.scheduleWorkdaysOnly,
          workingWeekdays: cfg.workingWeekdays,
          holidays: this.plugin.settings.holidays,
          extraWorkdays: cfg.extraWorkdays,
          extraNonWorkdays: cfg.extraNonWorkdays
        }
      },
      drag: this.drag,
      link: this.link,
      onRefresh: this.onRefresh,
      cleanupFns: this.cleanupFns
    }
  }

  scrollToToday(): void {
    if (!this.scrollEl) return
    const x = dateToX(this.cfg, today())
    const center = x - this.scrollEl.clientWidth / 2
    this.scrollEl.scrollLeft = Math.max(0, center)
  }

  private attachHoverTooltip(wrapper: HTMLElement): void {
    const tooltips = new WeakMap<Element, string>()
    for (const target of Array.from(
      this.svgEl.querySelectorAll('.pm-gantt-bar-group, .pm-gantt-milestone, .pm-gantt-summary-group')
    )) {
      const titleEl = target.querySelector('title')
      const text = titleEl?.textContent?.trim()
      if (!text) continue
      tooltips.set(target, text)
      titleEl?.remove()
    }

    const tooltipEl = wrapper.createDiv('pm-gantt-tooltip pm-hidden')
    let currentTarget: Element | null = null

    const hide = (): void => {
      currentTarget = null
      tooltipEl.addClass('pm-hidden')
    }

    const position = (e: MouseEvent): void => {
      const rect = wrapper.getBoundingClientRect()
      const pad = 12
      let x = e.clientX - rect.left + pad
      let y = e.clientY - rect.top + pad
      const maxX = Math.max(8, rect.width - tooltipEl.offsetWidth - 8)
      const maxY = Math.max(8, rect.height - tooltipEl.offsetHeight - 8)
      if (x > maxX) x = Math.max(8, e.clientX - rect.left - tooltipEl.offsetWidth - pad)
      if (y > maxY) y = Math.max(8, e.clientY - rect.top - tooltipEl.offsetHeight - pad)
      tooltipEl.style.left = `${x}px`
      tooltipEl.style.top = `${y}px`
    }

    const onMove = (e: MouseEvent): void => {
      if (this.drag.isDragging || this.link.active) {
        hide()
        return
      }
      const hit = (e.target as Element | null)?.closest(
        '.pm-gantt-bar-group, .pm-gantt-milestone, .pm-gantt-summary-group'
      )
      const text = hit ? tooltips.get(hit) : undefined
      if (!hit || !text) {
        hide()
        return
      }
      if (currentTarget !== hit) {
        currentTarget = hit
        tooltipEl.empty()
        const lines = text.split('\n')
        lines.forEach((line, idx) => {
          tooltipEl.createDiv({
            text: line,
            cls: idx === 0 ? 'pm-gantt-tooltip-title' : 'pm-gantt-tooltip-line'
          })
        })
        tooltipEl.removeClass('pm-hidden')
      }
      position(e)
    }

    this.svgEl.addEventListener('mousemove', onMove)
    this.svgEl.addEventListener('mouseleave', hide)
    this.svgEl.addEventListener('mousedown', hide)
    this.scrollEl.addEventListener('scroll', hide)
    this.cleanupFns.push(() => {
      this.svgEl.removeEventListener('mousemove', onMove)
      this.svgEl.removeEventListener('mouseleave', hide)
      this.svgEl.removeEventListener('mousedown', hide)
      this.scrollEl.removeEventListener('scroll', hide)
    })
  }
}
