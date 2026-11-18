import {
  type CriticalPathTaskInfo,
  type ScheduleOptions,
  type Task,
  computeBaselineVariance,
  computeDurationRisk,
  t
} from '@dotpm/core'
import { setTooltip } from '#platform'

export type ScheduleMetricKind = 'duration' | 'slack' | 'baseline'

export interface ScheduleMetricCellProps {
  kind: ScheduleMetricKind
  task: Task
  scheduleOptions: ScheduleOptions
  criticalInfo?: CriticalPathTaskInfo
}

/**
 * Shared read-only metric cell for Duration, Slack/CPM, and Baseline variance across both
 * the interactive Obsidian table and the exported static HTML table.
 */
export class ScheduleMetricCell {
  el: HTMLTableCellElement

  constructor(parentRow: HTMLElement, props: ScheduleMetricCellProps) {
    this.el = parentRow.createEl('td', { cls: `pm-table-cell pm-table-cell-${props.kind}` })
    renderMetricContent(this.el, props)
  }
}

function renderMetricContent(cell: HTMLElement, props: ScheduleMetricCellProps): void {
  const { kind, task, scheduleOptions, criticalInfo } = props
  if (kind === 'duration') {
    if (task.type === 'milestone' || task.durationDays === undefined || task.durationDays < 1) {
      cell.createSpan({ cls: 'pm-table-cell-muted', text: '—' })
      return
    }
    const days = `${Math.floor(task.durationDays)}d`
    const risk = computeDurationRisk(task, scheduleOptions)
    if (!risk) {
      cell.createSpan({ text: days })
      return
    }
    const badge = cell.createSpan({ cls: 'pm-metric-badge pm-metric-badge--warn', text: `${days} (!)` })
    setTooltip(
      badge,
      t('table.durationRiskHint', { available: risk.availableDays, required: risk.requiredDays })
    )
    return
  }

  if (kind === 'slack') {
    if (!criticalInfo) {
      cell.createSpan({ cls: 'pm-table-cell-muted', text: '—' })
      return
    }
    if (criticalInfo.critical) {
      cell.createSpan({ cls: 'pm-metric-badge pm-metric-badge--critical', text: t('table.criticalBadge') })
      return
    }
    cell.createSpan({ text: `${criticalInfo.slackDays}d` })
    return
  }

  const variance = computeBaselineVariance(task, scheduleOptions)
  if (!variance) {
    cell.createSpan({ cls: 'pm-table-cell-muted', text: '—' })
    return
  }
  if (variance.dueDeltaDays === 0) {
    cell.createSpan({ cls: 'pm-metric-badge pm-metric-badge--ok', text: t('table.onTime') })
  } else if (variance.dueDeltaDays > 0) {
    cell.createSpan({ cls: 'pm-metric-badge pm-metric-badge--warn', text: `+${variance.dueDeltaDays}d` })
  } else {
    cell.createSpan({ cls: 'pm-metric-badge pm-metric-badge--ok', text: `${variance.dueDeltaDays}d` })
  }
}
