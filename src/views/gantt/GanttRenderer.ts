import type PMPlugin from '#main'
import type { StatusConfig } from '@dotpm/core'
import type { ProjectScope } from '#store'
import type { GanttCanvas, GanttRow, LabelSource } from '@dotpm/ui'
import type { DragState } from './GanttDragHandler'
import type { LinkState } from './GanttLinkHandler'

export { drawSummaryBar, renderGridLines, renderTodayLine, renderTimelineHeader } from '@dotpm/ui'
export { renderTaskBar, renderMilestoneLabels, renderDependencyArrows } from './GanttTaskBarRenderer'

/** The drawing surfaces plus everything the interactive layer needs to edit through them. */
export interface RendererContext extends GanttCanvas {
  plugin: PMPlugin
  scope: ProjectScope
  /** Resolved once per render pass. */
  statuses: StatusConfig[]
  /** The timeline label fields past the title, in order. */
  labelFields: string[]
  labelSource: LabelSource
  taskRows: GanttRow[]
  totalRows: number
  drag: DragState
  link: LinkState
  onRefresh: () => Promise<void>
  cleanupFns: (() => void)[]
}
