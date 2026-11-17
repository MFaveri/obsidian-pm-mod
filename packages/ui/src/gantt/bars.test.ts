// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, makeTask } from '@dotpm/core'
import { svgEl } from '#dom'
import { buildTimelineConfig, HEADER_HEIGHT, ROW_HEIGHT } from './TimelineConfig'
import type { GanttCanvas } from './canvas'
import { drawDependencyArrows, drawMilestoneDiamond, drawSummaryBar, drawTaskBar } from './bars'

function makeCanvas(tasks = [makeTask({ id: 'a', start: '2026-04-01', due: '2026-04-10' })]): GanttCanvas {
  const svg = svgEl('svg', { width: 800, height: 400 })
  const headerSvgEl = svgEl('svg', { width: 800, height: HEADER_HEIGHT })
  return {
    svgEl: svg,
    headerSvgEl,
    cfg: buildTimelineConfig(tasks, 'day'),
    weekLabel: 'dateRange'
  }
}

describe('drawSummaryBar', () => {
  it('draws a project summary bar with progress and end caps', () => {
    const canvas = makeCanvas()
    const g = svgEl('g', {})
    canvas.svgEl.appendChild(g)

    const group = drawSummaryBar(
      g,
      canvas,
      {
        title: 'Project Alpha',
        color: '#3b82f6',
        start: '2026-04-01',
        due: '2026-04-05',
        progress: 50,
        done: 1,
        total: 2
      },
      0
    )

    expect(group).not.toBeNull()
    expect(group?.querySelector('.pm-gantt-summary-bar')).not.toBeNull()
    expect(group?.querySelector('.pm-gantt-summary-progress')).not.toBeNull()
    expect(group?.querySelectorAll('.pm-gantt-summary-cap')).toHaveLength(2)
  })

  it('returns null when the project has no dated tasks', () => {
    const canvas = makeCanvas()
    const g = svgEl('g', {})

    const group = drawSummaryBar(
      g,
      canvas,
      { title: 'Empty', color: '#3b82f6', start: '', due: '', progress: 0, done: 0, total: 0 },
      0
    )

    expect(group).toBeNull()
  })
})

describe('drawDependencyArrows with explicit row indices', () => {
  it('routes arrows using explicit visual row numbers across project header gaps', () => {
    const pred = makeTask({ id: 'pred', start: '2026-04-01', due: '2026-04-03' })
    const succ = makeTask({ id: 'succ', start: '2026-04-04', due: '2026-04-06', dependencies: ['pred'] })
    const canvas = makeCanvas([pred, succ])

    // Row 0 is project 1 header, row 1 is pred, row 2 is project 2 header, row 3 is succ.
    drawDependencyArrows(canvas, [
      { task: pred, depth: 1, row: 1 },
      { task: succ, depth: 1, row: 3 }
    ])

    const path = canvas.svgEl.querySelector('.pm-gantt-arrow')
    const d = path?.getAttribute('d') ?? ''
    const expectedFromY = HEADER_HEIGHT + 1 * ROW_HEIGHT + ROW_HEIGHT / 2
    const expectedToY = HEADER_HEIGHT + 3 * ROW_HEIGHT + ROW_HEIGHT / 2

    expect(d).toContain(` ${expectedFromY} C `)
    expect(d.endsWith(` ${expectedToY}`)).toBe(true)
  })

  it('styles critical arrows, bars, and milestones when highlight is active', () => {
    const pred = makeTask({ id: 'pred', start: '2026-04-01', due: '2026-04-03' })
    const side = makeTask({ id: 'side', start: '2026-04-01', due: '2026-04-02' })
    const mile = makeTask({
      id: 'mile',
      type: 'milestone',
      start: '',
      due: '2026-04-04',
      dependencies: ['pred', 'side']
    })
    const canvas = makeCanvas([pred, side, mile])
    const barsG = svgEl('g', {})
    canvas.svgEl.appendChild(barsG)

    const critBar = drawTaskBar(barsG, canvas, DEFAULT_STATUSES, pred, 0, '#3b82f6', '', {
      critical: true,
      slackDays: 0,
      highlight: true
    })
    const slackBar = drawTaskBar(barsG, canvas, DEFAULT_STATUSES, side, 1, '#3b82f6', '', {
      critical: false,
      slackDays: 1,
      highlight: true
    })
    const diamond = drawMilestoneDiamond(barsG, canvas, mile, 2, '#f59e0b', {
      critical: true,
      slackDays: 0,
      highlight: true
    })
    drawDependencyArrows(
      canvas,
      [
        { task: pred, depth: 0, row: 0 },
        { task: side, depth: 0, row: 1 },
        { task: mile, depth: 0, row: 2 }
      ],
      new Set(['pred->mile'])
    )

    expect(critBar?.rect.classList.contains('pm-gantt-bar--critical')).toBe(true)
    expect(critBar?.rect.querySelector('title')?.textContent).toContain('0d')
    expect(slackBar?.barGroup.classList.contains('pm-gantt-bar-group--dimmed')).toBe(true)
    expect(slackBar?.rect.querySelector('title')?.textContent).toContain('1')
    expect(diamond?.classList.contains('pm-gantt-milestone--critical')).toBe(true)
    expect(canvas.svgEl.querySelectorAll('.pm-gantt-arrow--critical')).toHaveLength(1)
    expect(canvas.svgEl.querySelectorAll('.pm-gantt-arrow--dimmed')).toHaveLength(1)
    expect(canvas.svgEl.querySelector('#pm-arrowhead-critical')).not.toBeNull()
  })
})
