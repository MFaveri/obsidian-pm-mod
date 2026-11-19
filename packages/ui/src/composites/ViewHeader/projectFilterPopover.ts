import { Popover } from '#primitives/Popover'
import { type ProjectListFilter, type ProjectProgress, PROJECT_PROGRESS, countProjectFilters, t } from '@dotpm/core'
import { renderPopHead, renderPopSearch } from '../popoverParts'
import { renderOptionRow } from '../properties/optionList'

export interface ProjectFilterOption {
  path: string
  title: string
  note?: string
}

export interface ProjectFilterProps {
  /** Edited in place. */
  filter: ProjectListFilter
  /** How many projects are at each stage, for the counts beside them. */
  progress: Record<ProjectProgress, number>
  tags: { tag: string; count: number }[]
  /** Available projects to filter by; omitted when the caller does not expose a project checklist here. */
  projects?: ProjectFilterOption[]
  onChange: () => void
  /** False leaves Clear all out, for a host that has its own. */
  showClear?: boolean
}

export interface ProjectSelectProps {
  /** Edited in place. */
  filter: ProjectListFilter
  projects: ProjectFilterOption[]
  onChange: () => void
}

const progressLabel = (stage: ProjectProgress): string =>
  ({
    'not-started': t('projectFilter.notStarted'),
    'in-progress': t('projectFilter.inProgress'),
    complete: t('projectFilter.complete')
  })[stage]

/** `list` with `value` added, or taken out when it was there; undefined once empty. */
const toggleFilterValue = <T extends string>(list: T[] | undefined, value: T): T[] | undefined => {
  const next = list?.includes(value) ? list.filter((entry) => entry !== value) : [...(list ?? []), value]
  return next.length ? next : undefined
}

const cleanFilter = (filter: ProjectListFilter): void => {
  if (!filter.projects) Reflect.deleteProperty(filter, 'projects')
  if (!filter.tags) Reflect.deleteProperty(filter, 'tags')
  if (!filter.progress) Reflect.deleteProperty(filter, 'progress')
}

/** The project list's filter: progress stages, tags, and individual projects. */
export function renderProjectFilterPanel(parent: HTMLElement, props: ProjectFilterProps): void {
  const body = parent.createDiv('pm-project-filter')
  const { filter } = props

  const changed = (): void => {
    cleanFilter(filter)
    render()
    props.onChange()
  }

  const render = (): void => {
    body.empty()
    renderPopHead(body, {
      title: t('columns.progress'),
      action:
        props.showClear === false
          ? undefined
          : {
              label: t('filter.clearAll'),
              disabled: countProjectFilters(filter) === 0,
              onClick: () => {
                filter.projects = undefined
                filter.tags = undefined
                filter.progress = undefined
                changed()
              }
            }
    })
    for (const stage of PROJECT_PROGRESS) {
      renderOptionRow(body, {
        label: progressLabel(stage),
        note: String(props.progress[stage]),
        selected: filter.progress?.includes(stage) ?? false,
        onPick: () => {
          filter.progress = toggleFilterValue(filter.progress, stage)
          changed()
        }
      })
    }

    renderPopHead(body, { title: t('taskForm.tags'), section: true })
    if (!props.tags.length) body.createDiv({ cls: 'pm-pop-empty', text: t('projectFilter.noTags') })
    for (const { tag, count } of props.tags) {
      renderOptionRow(body, {
        label: `#${tag}`,
        note: String(count),
        selected: filter.tags?.includes(tag) ?? false,
        onPick: () => {
          filter.tags = toggleFilterValue(filter.tags, tag)
          changed()
        }
      })
    }

    if (props.projects?.length) {
      renderPopHead(body, { title: t('header.projects'), section: true })
      const list = body.createDiv('pm-pop-list')
      for (const project of props.projects) {
        renderOptionRow(list, {
          label: project.title,
          note: project.note,
          selected: filter.projects?.includes(project.path) ?? false,
          onPick: () => {
            filter.projects = toggleFilterValue(filter.projects, project.path)
            changed()
          }
        })
      }
    }
  }

  render()
}

/** A focused checklist of projects for choosing which (and how many) projects are shown. */
export function renderProjectSelectPanel(parent: HTMLElement, props: ProjectSelectProps): void {
  const body = parent.createDiv('pm-project-select')
  const { filter } = props
  let query = ''
  let headEl: HTMLElement | null = null

  const clearSelection = (): void => {
    if (!filter.projects?.length) return
    filter.projects = undefined
    cleanFilter(filter)
    renderHead()
    renderList()
    props.onChange()
  }

  const renderHead = (): void => {
    const nextHead = renderPopHead(body, {
      title: t('header.projects'),
      action: filter.projects?.length
        ? {
            label: t('common.clear'),
            onClick: clearSelection
          }
        : undefined
    })
    if (headEl) {
      headEl.replaceWith(nextHead)
    }
    headEl = nextHead
  }

  renderHead()
  if (props.projects.length > 6) {
    const input = renderPopSearch(body, t('header.search'), () => {
      query = input.value
      renderList()
    })
  }
  const listEl = body.createDiv('pm-pop-list')

  const renderList = (): void => {
    listEl.empty()
    const needle = query.trim().toLowerCase()
    if (!needle) {
      renderOptionRow(listEl, {
        label: t('header.allProjects'),
        note: String(props.projects.length),
        selected: !filter.projects?.length,
        onPick: clearSelection
      })
    }
    const visible = needle
      ? props.projects.filter((project) => project.title.toLowerCase().includes(needle))
      : props.projects
    if (!visible.length) {
      listEl.createDiv({ cls: 'pm-pop-empty', text: t('list.noMatch') })
      return
    }
    for (const project of visible) {
      renderOptionRow(listEl, {
        label: project.title,
        note: project.note,
        selected: filter.projects?.includes(project.path) ?? false,
        onPick: () => {
          filter.projects = toggleFilterValue(filter.projects, project.path)
          cleanFilter(filter)
          renderHead()
          renderList()
          props.onChange()
        }
      })
    }
  }

  renderList()
}

/** The project filter panel in a popover under `anchor`. */
export const openProjectFilterPopover = (anchor: HTMLElement, props: ProjectFilterProps): Popover =>
  Popover.show({ anchor, width: 260 }, (el) => renderProjectFilterPanel(el, props))

/** The project selector panel in a popover under `anchor`. */
export const openProjectSelectPopover = (anchor: HTMLElement, props: ProjectSelectProps): Popover =>
  Popover.show({ anchor, width: 260 }, (el) => renderProjectSelectPanel(el, props))
