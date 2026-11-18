import type PMPlugin from '#main'
import {
  type Project,
  type Task,
  type TaskType,
  type Recurrence,
  collectAllAssignees,
  collectAllTags,
  flattenTasks,
  getDependencyCandidates,
  reaches,
  isTerminalStatus,
  priorityIcon,
  stringToColor,
  completionOutcome,
  computeDurationRisk,
  formatDateShort,
  getDependencySpec,
  pruneDependencyLinks,
  relativeDue,
  scheduleOptionsFor,
  type DependencyType,
  t
} from '@dotpm/core'
import {
  renderPropRow,
  renderSelectControl,
  renderDateControl,
  renderInputControl,
  renderMultiSelect,
  renderAddProperty,
  renderDepRow,
  type SelectItem,
  type HiddenProperty
} from '@dotpm/ui'
import { renderCustomFieldInput } from './CustomFieldInputs'
import { renderPersonPicker } from '#ui/PersonPicker'

export interface TaskFormFieldsContext {
  task: Task
  project: Project
  plugin: PMPlugin
  parentId: string | null
  setParentId: (id: string | null) => void
  rerender: () => void
  shownExtras: Set<string>
  /** Leaves the editor for the task a dependency names. */
  openTask: (path: string) => void
}

const typeOptions = (): SelectItem[] => [
  { id: 'task', label: t('taskForm.typeTask'), icon: 'square-check-big' },
  { id: 'subtask', label: t('taskForm.typeSubtask'), icon: 'git-branch' },
  { id: 'milestone', label: t('taskForm.typeMilestone'), icon: 'diamond' }
]

const repeatOptions = (): SelectItem[] => [
  { id: 'none', label: t('taskForm.repeatNone'), icon: 'repeat' },
  { id: 'daily', label: t('taskForm.repeatDaily'), icon: 'repeat' },
  { id: 'weekly', label: t('taskForm.repeatWeekly'), icon: 'repeat' },
  { id: 'monthly', label: t('taskForm.repeatMonthly'), icon: 'repeat' },
  { id: 'yearly', label: t('taskForm.repeatYearly'), icon: 'repeat' }
]

/**
 * The property grid. Core properties always show; the rest hide when empty behind "Add
 * property". Single-selects and dates re-render the form on change; multi-selects mutate
 * the task in place and refresh their own chips.
 */
export function renderTaskFormFields(container: HTMLElement, ctx: TaskFormFieldsContext): void {
  const { task, project, plugin, rerender, shownExtras } = ctx
  const { statuses, priorities, priorityIcons, customFields } = plugin.store.configFor(project)
  const selectableStatuses =
    task.status === 'superseded'
      ? statuses.filter((status) => status.id === 'superseded')
      : statuses.filter((status) => status.id !== 'superseded')
  const grid = container.createDiv('pm-prop-grid')

  renderPropRow(
    grid,
    t('taskForm.type'),
    () => {
      const cell = createDiv('pm-prop-value')
      renderSelectControl({
        container: cell,
        value: task.type,
        options: typeOptions(),
        onChange: (id) => {
          task.type = id as TaskType
          if (id === 'milestone') {
            task.start = ''
            task.progress = 0
          }
          if (id !== 'subtask') ctx.setParentId(null)
          rerender()
        }
      })
      return cell
    },
    'shapes'
  )

  // The parent picker shares the type row and shows only for subtasks; an empty cell holds
  // the column otherwise, so switching type never reflows the grid.
  if (task.type === 'subtask') {
    renderPropRow(
      grid,
      t('taskForm.parentTask'),
      () => {
        const cell = createDiv('pm-prop-value')
        const parents = flattenTasks(project.tasks)
          .map((f) => f.task)
          .filter((other) => other.id !== task.id)
        renderSelectControl({
          container: cell,
          value: ctx.parentId,
          options: [
            { id: '', label: t('common.noParent') },
            ...parents.map((other) => ({ id: other.id, label: other.title }))
          ],
          placeholder: t('taskForm.selectParent'),
          search: true,
          searchPlaceholder: t('taskForm.searchTasks'),
          width: 230,
          onChange: (id) => {
            ctx.setParentId(id || null)
            rerender()
          }
        })
        return cell
      },
      'corner-up-right'
    )
  } else {
    grid.createDiv()
  }

  renderPropRow(
    grid,
    t('taskForm.status'),
    () => {
      const cell = createDiv('pm-prop-value')
      renderSelectControl({
        container: cell,
        value: task.status,
        options: selectableStatuses.map((s) => ({
          id: s.id,
          label: s.label,
          color: s.color,
          icon: s.icon || undefined
        })),
        onChange: (id) => {
          task.status = id
          rerender()
        }
      })
      return cell
    },
    'circle-dot'
  )

  const historyLinks: Array<{ label: string; id: string | undefined; icon: string }> = [
    { label: t('taskForm.replacedBy'), id: task.replacedBy, icon: 'arrow-right' },
    { label: t('taskForm.replaces'), id: task.replaces, icon: 'arrow-left' }
  ]
  for (const history of historyLinks) {
    if (!history.id) continue
    const historyId = history.id
    const linked = plugin.index.task(historyId)
    renderPropRow(
      grid,
      history.label,
      () => {
        const cell = createDiv('pm-prop-value')
        renderDepRow(cell, {
          id: historyId,
          title: linked?.title ?? historyId,
          link: linked ? { path: linked.path, open: () => ctx.openTask(linked.path) } : undefined
        })
        return cell
      },
      history.icon
    )
  }

  renderPropRow(
    grid,
    t('taskForm.priority'),
    () => {
      const cell = createDiv('pm-prop-value')
      renderSelectControl({
        container: cell,
        value: task.priority,
        options: priorities.map((p) => ({
          id: p.id,
          label: p.label,
          color: p.color,
          icon: priorityIcon(priorities, p.id, priorityIcons)
        })),
        onChange: (id) => {
          task.priority = id
          rerender()
        }
      })
      return cell
    },
    'flag'
  )

  renderPropRow(
    grid,
    task.type === 'milestone' ? t('taskForm.date') : t('taskForm.due'),
    () => {
      const cell = createDiv('pm-prop-value')
      renderDateControl({
        container: cell,
        value: task.due,
        emptyLabel: t('taskForm.setDueDate'),
        hint: isTerminalStatus(task.status, statuses) ? null : relativeDue(task.due),
        onChange: (v) => {
          task.due = v
          rerender()
        }
      })
      return cell
    },
    'calendar-clock'
  )

  // Start shares the dates row with Due. Milestones have no start, so an empty cell holds
  // the slot and Assignees still leads the next row.
  if (task.type !== 'milestone') {
    renderPropRow(
      grid,
      t('taskForm.start'),
      () => {
        const cell = createDiv('pm-prop-value')
        renderDateControl({
          container: cell,
          value: task.start,
          emptyLabel: t('taskForm.setStart'),
          onChange: (v) => {
            task.start = v
            rerender()
          }
        })
        return cell
      },
      'play'
    )
  } else {
    grid.createDiv()
  }

  renderPropRow(
    grid,
    t('taskForm.assignees'),
    () => {
      const cell = createDiv('pm-prop-value')
      renderPersonPicker({
        container: cell,
        plugin,
        sourcePath: task.filePath ?? project.filePath,
        extra: () => [...project.teamMembers, ...collectAllAssignees(project.tasks)],
        addLabel: t('taskForm.assign'),
        selected: () => task.assignees,
        add: (value) => {
          if (!task.assignees.includes(value)) task.assignees.push(value)
        },
        remove: (value) => {
          task.assignees = task.assignees.filter((a) => a !== value)
        }
      })
      return cell
    },
    'users'
  )

  if (task.completed || isTerminalStatus(task.status, statuses)) {
    renderPropRow(
      grid,
      t('taskForm.completed'),
      () => {
        const cell = createDiv('pm-prop-value')
        renderDateControl({
          container: cell,
          value: task.completed,
          emptyLabel: t('taskForm.setDate'),
          hint: completionOutcome(task.due, task.completed),
          onChange: (v) => {
            task.completed = v
            rerender()
          }
        })
        return cell
      },
      'circle-check-big'
    )
  }

  if (task.type !== 'milestone') {
    renderPropRow(
      grid,
      t('taskForm.progress'),
      () => {
        const cell = createDiv('pm-prop-value')
        renderInputControl({
          container: cell,
          value: String(task.progress),
          inputType: 'number',
          suffix: '%',
          number: { min: 0, max: 100 },
          onChange: (v) => {
            task.progress = Number(v)
            rerender()
          }
        })
        return cell
      },
      'percent'
    )
  }

  if (task.type !== 'milestone') {
    renderPropRow(
      grid,
      t('taskForm.durationDays'),
      () => {
        const cell = createDiv('pm-prop-value pm-prop-duration-cell')
        renderInputControl({
          container: cell,
          value: task.durationDays !== undefined ? String(task.durationDays) : '',
          placeholder: t('taskForm.durationDaysPlaceholder'),
          inputType: 'number',
          suffix: 'd',
          number: { min: 1 },
          onChange: (v) => {
            const parsed = Number(v)
            task.durationDays = v.trim() !== '' && Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined
            rerender()
          }
        })
        const opts = scheduleOptionsFor(plugin.store.configFor(project), plugin.settings.holidays)
        const risk = computeDurationRisk(task, opts)
        if (risk) {
          const warn = cell.createDiv('pm-duration-risk')
          warn.createSpan({
            text: t('taskForm.durationRisk', {
              available: risk.availableDays,
              required: risk.requiredDays,
              projectedDue: formatDateShort(risk.projectedDue)
            })
          })
          const adjustBtn = warn.createEl('button', {
            cls: 'pm-duration-risk-btn',
            text: t('taskForm.adjustDueToDuration'),
            attr: { type: 'button' }
          })
          adjustBtn.addEventListener('click', () => {
            task.due = risk.projectedDue
            rerender()
          })
        }
        return cell
      },
      'clock'
    )
  }

  if (task.recurrence || shownExtras.has('repeat')) {
    renderPropRow(
      grid,
      t('taskForm.repeat'),
      () => {
        const cell = createDiv('pm-prop-value')
        renderSelectControl({
          container: cell,
          value: task.recurrence?.interval ?? 'none',
          options: repeatOptions(),
          onChange: (id) => {
            if (id === 'none') {
              task.recurrence = undefined
            } else {
              task.recurrence = {
                interval: id as Recurrence['interval'],
                every: task.recurrence?.every ?? 1,
                endDate: task.recurrence?.endDate
              }
            }
            rerender()
          }
        })
        return cell
      },
      'repeat'
    )
  }

  const tagsRow = renderPropRow(
    grid,
    t('taskForm.tags'),
    () => {
      const cell = createDiv('pm-prop-value')
      const projectTags = collectAllTags(project.tasks)
      renderMultiSelect({
        container: cell,
        search: true,
        addLabel: t('taskForm.addTags'),
        placeholder: t('taskForm.findOrCreate'),
        tag: true,
        colorFor: plugin.settings.showTagColors ? (tag) => stringToColor(tag) : undefined,
        selected: () => task.tags,
        options: () => projectTags.map((tag) => ({ id: tag, label: tag })),
        add: (id) => {
          if (!task.tags.includes(id)) task.tags.push(id)
        },
        remove: (id) => {
          task.tags = task.tags.filter((tag) => tag !== id)
        },
        create: (label) => {
          if (!task.tags.includes(label)) task.tags.push(label)
        }
      })
      return cell
    },
    'tag'
  )
  tagsRow.addClass('pm-prop-row--wide')

  if (task.dependencies.length > 0 || shownExtras.has('depends')) {
    const ownTasks = flattenTasks(project.tasks)
      .map((f) => f.task)
      .filter((other) => other.id !== task.id)
    const ownIds = new Set(ownTasks.map((other) => other.id))
    const ownCandidateIds = new Set(
      getDependencyCandidates(project.tasks, task.id, statuses).map((candidate) => candidate.id)
    )
    // Tasks in other projects can be depended on too, so the picker offers active foreign tasks
    // while preserving any historical ids already selected for removal.
    const foreign = plugin.index
      .allTaskRefs()
      .filter(
        (ref) =>
          ref.id !== task.id && !ownIds.has(ref.id) && ref.status !== 'superseded' && !ref.replacedBy && !ref.archived
      )
      .map((ref) => ({
        id: ref.id,
        label: ref.projectPath
          ? `${ref.title}  ·  ${plugin.index.projectRef(ref.projectPath)?.title ?? ''}`.trimEnd()
          : ref.title
      }))
    const candidateIds = new Set([...ownCandidateIds, ...foreign.map((ref) => ref.id)])
    const allTasks: { id: string; label: string }[] = [
      ...ownTasks.map((other) => ({ id: other.id, label: other.title })),
      ...foreign
    ]
    const titleOf = (id: string) => allTasks.find((entry) => entry.id === id)?.label ?? id
    const depRow = renderPropRow(
      grid,
      t('taskForm.dependsOn'),
      () => {
        const cell = createDiv('pm-prop-value')
        renderMultiSelect({
          container: cell,
          search: true,
          addLabel: t('taskForm.addDependency'),
          addLabelMore: t('common.addAnother'),
          placeholder: t('taskForm.searchTasks'),
          depsList: true,
          labelFor: titleOf,
          linkFor: (id) => {
            const path = plugin.index.task(id)?.path
            return path ? { path, open: () => ctx.openTask(path) } : null
          },
          selected: () => task.dependencies.filter((id) => allTasks.some((entry) => entry.id === id)),
          options: () => {
            // Built once per open, not once per candidate. A predecessor chain can leave
            // this project and come back, so every candidate is checked against the vault.
            const edges = plugin.index.dependentsMap()
            return allTasks.filter(
              (entry) =>
                task.dependencies.includes(entry.id) ||
                (candidateIds.has(entry.id) && !reaches(edges, task.id, entry.id))
            )
          },
          add: (id) => {
            if (!task.dependencies.includes(id)) task.dependencies.push(id)
          },
          renderDepExtra: (row, depId) => {
            const spec = getDependencySpec(task, depId)
            const typeSel = row.createEl('select', { cls: 'pm-dep-type', attr: { title: t(`taskForm.depType${spec.type}`) } })
            for (const optType of ['FS', 'SS', 'FF'] as const) {
              const opt = typeSel.createEl('option', { value: optType, text: optType })
              if (optType === spec.type) opt.selected = true
            }
            const lagInput = row.createEl('input', {
              cls: 'pm-dep-lag',
              attr: {
                type: 'number',
                step: '1',
                value: String(spec.lagDays),
                title: t('taskForm.depLagDays')
              }
            })
            row.createSpan({ cls: 'pm-dep-lag-unit', text: 'd' })

            const commitSpec = () => {
              const type = (typeSel.value as DependencyType) ?? 'FS'
              const parsed = Number(lagInput.value)
              const lagDays = lagInput.value.trim() !== '' && Number.isFinite(parsed) ? Math.trunc(parsed) : 0
              typeSel.setAttribute('title', t(`taskForm.depType${type}`))
              const next = { ...task.dependencyLinks, [depId]: { type, lagDays } }
              task.dependencyLinks = pruneDependencyLinks(task.dependencies, next)
            }
            typeSel.addEventListener('change', commitSpec)
            lagInput.addEventListener('change', commitSpec)
          },
          remove: (id) => {
            task.dependencies = task.dependencies.filter((d) => d !== id)
            task.dependencyLinks = pruneDependencyLinks(task.dependencies, task.dependencyLinks)
          }
        })
        return cell
      },
      'link-2'
    )
    depRow.addClass('pm-prop-row--wide')
  }

  // The other side of a dependency, which is otherwise only visible from the task that
  // declared it, and invisible altogether when that task is in another project.
  const blocks = plugin.index.dependents(task.id)
  if (blocks.length) {
    const blocksRow = renderPropRow(
      grid,
      t('taskForm.blocks'),
      () => {
        const cell = createDiv('pm-prop-value')
        const list = cell.createDiv('pm-prop-deps')
        for (const ref of blocks) {
          const owner = ref.projectPath ? plugin.index.projectRef(ref.projectPath) : null
          renderDepRow(list, {
            id: ref.id,
            title: ref.title,
            tooltip: owner ? t('taskForm.inProject', { title: owner.title }) : undefined,
            link: { path: ref.path, open: () => ctx.openTask(ref.path) }
          })
        }
        return cell
      },
      'link-2'
    )
    blocksRow.addClass('pm-prop-row--wide')
  }

  const hidden: HiddenProperty[] = []
  if (!task.recurrence && !shownExtras.has('repeat')) {
    hidden.push({ id: 'repeat', label: t('taskForm.repeat'), icon: 'repeat' })
  }
  if (task.dependencies.length === 0 && !shownExtras.has('depends')) {
    hidden.push({ id: 'depends', label: t('taskForm.dependsOn'), icon: 'link-2' })
  }
  if (hidden.length > 0) {
    const addCell = grid.createDiv('pm-prop-add-cell')
    renderAddProperty(addCell, hidden, (id) => {
      shownExtras.add(id)
      rerender()
    })
  }

  if (customFields.length > 0) {
    const cfSection = container.createDiv('pm-modal-section')
    cfSection.createEl('h4', { text: t('settings.customFields.name'), cls: 'pm-modal-section-title' })
    const cfGrid = cfSection.createDiv('pm-prop-grid')
    for (const cf of customFields) {
      renderPropRow(cfGrid, cf.name, () => renderCustomFieldInput(cf, task, project, plugin, rerender))
    }
  }
}
