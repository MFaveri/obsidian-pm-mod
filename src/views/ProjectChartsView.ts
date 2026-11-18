import { ButtonComponent, ItemView, Menu, WorkspaceLeaf } from 'obsidian'
import type PMPlugin from '#main'
import { addTabPageItems, refreshTabTitle } from '#ui/tab'
import type { ProjectRef } from '#store'
import {
  type ChartWindowMode,
  type Project,
  computeProjectCharts,
  t,
  tn
} from '@dotpm/core'
import { EmptyState, SegmentedControl, renderGlyph, safeAsync } from '@dotpm/ui'
import { type ChartsViewInteractionState, renderProjectChartsBody } from './ChartsRenderer'

export const PM_PROJECT_CHARTS_VIEW_TYPE = 'pm-project-charts'

export interface ProjectChartsState {
  filePath?: string
  window?: ChartWindowMode
  [key: string]: unknown
}

export class ProjectChartsView extends ItemView {
  plugin: PMPlugin
  private state: ProjectChartsState = {}
  private project: Project | null = null
  private container!: HTMLElement
  private treeSignature = ''
  private windowMode: ChartWindowMode = 'rolling12'
  private uiState: ChartsViewInteractionState = {
    histogramMode: 'status',
    selectedWeekStart: null,
    selectedAssignee: null,
    selectedSlackBucket: null
  }

  constructor(leaf: WorkspaceLeaf, plugin: PMPlugin) {
    super(leaf)
    this.plugin = plugin
    this.navigation = false
  }

  getViewType(): string {
    return PM_PROJECT_CHARTS_VIEW_TYPE
  }

  getDisplayText(): string {
    return this.project
      ? t('charts.viewLabel', { title: this.project.title })
      : t('charts.title')
  }

  getIcon(): string {
    return 'bar-chart-2'
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source)
    const project = this.project
    if (!project) return
    addTabPageItems(menu, this.plugin, this.leaf, project.filePath, [
      'overview',
      'tasks',
      'edit',
      'note'
    ])
  }

  async setState(state: ProjectChartsState, result: unknown): Promise<void> {
    const changed = state.filePath !== this.state.filePath
    this.state = state
    if (state.window === 'rolling12' || state.window === 'full') {
      this.windowMode = state.window
    }
    if (changed) {
      this.uiState = {
        histogramMode: 'status',
        selectedWeekStart: null,
        selectedAssignee: null,
        selectedSlackBucket: null
      }
    }
    if (changed || !this.project) await this.loadProject()
    await super.setState(state, result as import('obsidian').ViewStateResult)
  }

  getState(): ProjectChartsState {
    return {
      ...this.state,
      window: this.windowMode
    }
  }

  onOpen(): Promise<void> {
    this.containerEl.addClass('pm-view')
    this.contentEl.empty()
    this.contentEl.addClass('pm-root')
    this.container = this.contentEl.createDiv('pm-overview pm-charts-view')

    this.register(
      this.plugin.store.onProjectChanged((path) => {
        if (path !== this.project?.filePath) return
        void this.reloadAndRender()
      })
    )
    this.register(this.plugin.index.onNoteColorChange(() => this.render()))
    this.register(
      this.plugin.index.onChange(() => {
        if (this.project && this.treeSignature !== this.signTree(this.project)) {
          void this.reloadAndRender()
        }
      })
    )
    return Promise.resolve()
  }

  onClose(): Promise<void> {
    this.contentEl.empty()
    return Promise.resolve()
  }

  private async reloadAndRender(): Promise<void> {
    if (!this.state.filePath) return
    this.project = await this.plugin.store.loadProjectByPath(this.state.filePath)
    refreshTabTitle(this.leaf)
    if (!this.project) {
      this.renderMissing()
      return
    }
    this.render()
  }

  private async loadProject(): Promise<void> {
    const path = this.state.filePath
    this.project = path ? await this.plugin.store.loadProjectByPath(path) : null
    refreshTabTitle(this.leaf)
    if (!this.project) {
      this.renderMissing()
      return
    }
    this.render()
  }

  private signTree(project: Project): string {
    const parent = this.plugin.index.parentOf(project.filePath)?.path ?? ''
    const archived = this.plugin.index.isArchived(project.filePath) ? 'archived' : ''
    return `${parent}|${archived}|${project.updatedAt}`
  }

  private renderMissing(): void {
    this.container.empty()
    new EmptyState(this.container)
      .setIcon('📊')
      .setTitle(t('project.missingTitle'))
      .setBody(t('project.missingBody'))
  }

  render(): void {
    const project = this.project
    if (!project) return
    this.container.empty()
    this.treeSignature = this.signTree(project)

    const config = this.plugin.store.configFor(project)
    const data = computeProjectCharts(project, config, {
      holidays: this.plugin.settings.holidays,
      window: this.windowMode
    })

    this.renderBreadcrumbs(project)
    this.renderHeader(project, data.summary.doneTasks, data.summary.totalTasks)

    renderProjectChartsBody(this.container, {
      plugin: this.plugin,
      project,
      config,
      data,
      state: this.uiState,
      redraw: () => this.render()
    })
  }

  private renderBreadcrumbs(project: Project): void {
    const chain: ProjectRef[] = []
    for (
      let ref = this.plugin.index.parentOf(project.filePath);
      ref;
      ref = this.plugin.index.parentOf(ref.path)
    ) {
      chain.unshift(ref)
    }
    const bar = this.container.createDiv('pm-overview-crumbs')
    for (const crumb of chain) {
      const link = bar.createSpan({ cls: 'pm-overview-crumb', text: crumb.title })
      link.addEventListener(
        'click',
        safeAsync(() => this.plugin.router.openProjectOverview(crumb.path, this.leaf))
      )
      bar.createSpan({ cls: 'pm-overview-crumb-sep', text: '/' })
    }
    const selfLink = bar.createSpan({ cls: 'pm-overview-crumb', text: project.title })
    selfLink.addEventListener(
      'click',
      safeAsync(() => this.plugin.router.openProjectOverview(project.filePath, this.leaf))
    )
    bar.createSpan({ cls: 'pm-overview-crumb-sep', text: '/' })
    bar.createSpan({ text: t('charts.title') })
  }

  private renderHeader(project: Project, done: number, total: number): void {
    const header = this.container.createDiv('pm-overview-header pm-charts-header')
    const tile = header.createDiv({ cls: 'pm-overview-icon' })
    tile.style.setProperty('--pm-overview-tint', project.color)
    renderGlyph(tile, { icon: project.icon, color: project.color })

    const identity = header.createDiv('pm-overview-identity')
    identity.createDiv({
      cls: 'pm-overview-title',
      text: `${project.title} · ${t('charts.title')}`
    })
    identity.createDiv({
      cls: 'pm-overview-subline',
      text: `${t('charts.subtitle')} · ${tn('overview.tasksDone', total, { done })}`
    })

    const controls = header.createDiv('pm-charts-header-actions')
    new SegmentedControl<ChartWindowMode>(controls, {
      active: this.windowMode,
      options: [
        { id: 'rolling12', label: t('charts.windowRolling') },
        { id: 'full', label: t('charts.windowFull') }
      ],
      onChange: (mode) => {
        this.windowMode = mode
        this.state.window = mode
        this.uiState.selectedWeekStart = null
        this.render()
      }
    })

    new ButtonComponent(controls)
      .setButtonText(t('project.openOverview'))
      .onClick(safeAsync(() => this.plugin.router.openProjectOverview(project.filePath, this.leaf)))

    new ButtonComponent(controls)
      .setButtonText(t('project.openTasks'))
      .setCta()
      .onClick(
        safeAsync(() => this.plugin.router.openScope({ kind: 'project', path: project.filePath }, this.leaf))
      )
  }
}
