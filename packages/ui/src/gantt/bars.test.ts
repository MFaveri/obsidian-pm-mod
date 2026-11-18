// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUSES, Temporal, makeTask } from '@dotpm/core'
import { svgEl } from '#dom'
import { buildTimelineConfig, dateToX, HEADER_HEIGHT, ROW_HEIGHT } from './TimelineConfig'
import type { GanttCanvas } from './canvas'
import { drawDependencyArrows, drawMilestoneDiamond, drawSummaryBar, drawTaskBar } from './bars'
import { renderGridLines } from './canvas'
import { renderTimelineHeader } from './header'

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

describe('baseline drawing', () => {
  it('draws baseline track under slipped bars and ghost diamond for milestones', () => {
    const task = makeTask({
      id: 't1',
      title: 'T1',
      start: '2026-04-03',
      due: '2026-04-06',
      baselineStart: '2026-04-01',
      baselineDue: '2026-04-04'
    })
    const mile = makeTask({
      id: 'm1',
      type: 'milestone',
      start: '',
      due: '2026-04-05',
      baselineDue: '2026-04-07'
    })
    const canvas = makeCanvas([task, mile])
    const barsG = svgEl('g', {})
    canvas.svgEl.appendChild(barsG)

    const bar = drawTaskBar(barsG, canvas, DEFAULT_STATUSES, task, 0, '#3b82f6', '', undefined, {
      baselineStart: '2026-04-01',
      baselineDue: '2026-04-04',
      startDeltaDays: 2,
      dueDeltaDays: 2,
      showBar: true
    })
    drawMilestoneDiamond(barsG, canvas, mile, 1, '#f59e0b', undefined, {
      baselineStart: '2026-04-07',
      baselineDue: '2026-04-07',
      startDeltaDays: -2,
      dueDeltaDays: -2,
      showBar: true
    })
    drawSummaryBar(
      barsG,
      canvas,
      {
        title: 'P',
        color: '#3b82f6',
        start: '2026-04-03',
        due: '2026-04-06',
        baselineStart: '2026-04-01',
        baselineDue: '2026-04-04',
        progress: 20,
        done: 0,
        total: 1
      },
      2,
      true
    )

    expect(bar?.barGroup.querySelector('.pm-gantt-baseline-bar--late')).not.toBeNull()
    expect(bar?.rect.querySelector('title')?.textContent).toContain('+2d')
    expect(barsG.querySelector('.pm-gantt-baseline-milestone--ahead')).not.toBeNull()
    expect(barsG.querySelectorAll('.pm-gantt-baseline-bar')).toHaveLength(2)
  })
})

describe('calendar day shading', () => {
  it('shades time-off, off-week, and extra-working days distinctly in grid and header', () => {
    const tasks = [makeTask({ id: 'a', start: '2026-11-18', due: '2026-11-24' })]
    const canvas = makeCanvas(tasks)
    canvas.dayKind = (d) => {
      const iso = d.toString()
      if (iso === '2026-11-18') return 'time-off'
      if (iso === '2026-11-21') return 'extra-working'
      return d.dayOfWeek >= 6 ? 'off-week' : 'working'
    }

    renderTimelineHeader(canvas)
    renderGridLines(canvas, 2)

    expect(canvas.svgEl.querySelectorAll('.pm-gantt-timeoff').length).toBeGreaterThanOrEqual(1)
    expect(canvas.svgEl.querySelectorAll('.pm-gantt-extra-workday').length).toBeGreaterThanOrEqual(1)
    expect(canvas.headerSvgEl.querySelectorAll('.pm-gantt-timeoff-header').length).toBeGreaterThanOrEqual(1)
    expect(canvas.headerSvgEl.querySelectorAll('.pm-gantt-extra-workday-header').length).toBeGreaterThanOrEqual(1)
  })
})

describe('mandatory duration risk overlay', () => {
  it('draws a risk stroke, overflow extension bar, and duration tooltip when window is short', () => {
    const t = makeTask({
      id: 'd1',
      start: '2026-04-02',
      due: '2026-04-04',
      durationDays: 5
    })
    const canvas = makeCanvas([t])
    const g = svgEl('g', {})
    canvas.svgEl.appendChild(g)

    const drawn = drawTaskBar(g, canvas, DEFAULT_STATUSES, t, 0, '#3b82f6', '', undefined, undefined, {
      requiredDays: 5,
      availableDays: 3,
      shortfallDays: 2,
      projectedDue: '2026-04-06'
    })

    expect(drawn?.rect.getAttribute('class')).toContain('pm-gantt-bar--duration-risk')
    const overflow = drawn?.barGroup.querySelector('.pm-gantt-duration-overflow')
    expect(overflow).not.toBeNull()
    expect(Number(overflow?.getAttribute('width'))).toBeGreaterThan(0)
    const tip = drawn?.rect.querySelector('title')?.textContent ?? ''
    expect(tip).toContain('Duration: 5d')
    expect(tip).toContain('3d / 5d')
  })

  it('draws SS and FF dependency arrows with matching edge anchors and badges', () => {
    const a = makeTask({ id: 'a', start: '2026-04-02', due: '2026-04-05' })
    const b = makeTask({
      id: 'b',
      start: '2026-04-04',
      due: '2026-04-07',
      dependencies: ['a'],
      dependencyLinks: { a: { type: 'SS', lagDays: 2 } }
    })
    const c = makeTask({
      id: 'c',
      start: '2026-04-03',
      due: '2026-04-05',
      dependencies: ['a'],
      dependencyLinks: { a: { type: 'FF' } }
    })
    const canvas = makeCanvas([a, b, c])
    drawDependencyArrows(canvas, [
      { task: a, depth: 0 },
      { task: b, depth: 0 },
      { task: c, depth: 0 }
    ])

    const paths = Array.from(canvas.svgEl.querySelectorAll('.pm-gantt-arrow'))
    expect(paths).toHaveLength(2)
    // SS links start-to-start (anchors on a.start), FF links finish-to-finish (anchors on a.due + 1)
    const ssD = paths[0]?.getAttribute('d') ?? ''
    const ffD = paths[1]?.getAttribute('d') ?? ''
    const expectedSsFromX = dateToX(canvas.cfg, Temporal.PlainDate.from('2026-04-02'))
    const expectedFfFromX = dateToX(canvas.cfg, Temporal.PlainDate.from('2026-04-06'))
    expect(ssD.startsWith(`M ${expectedSsFromX} `)).toBe(true)
    expect(ffD.startsWith(`M ${expectedFfFromX} `)).toBe(true)
    const badges = Array.from(canvas.svgEl.querySelectorAll('.pm-gantt-arrow-badge')).map((el) => el.textContent)
    expect(badges).toEqual(['SS +2d', 'FF'])
  })
})
