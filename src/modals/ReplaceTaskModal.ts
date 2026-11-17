import { App, ButtonComponent, Modal, Notice } from 'obsidian'
import type PMPlugin from '#main'
import {
  makeTask,
  type Project,
  type Task,
  excludeSupersededTasks,
  getReplacementCandidates,
  flattenTasks,
  getDefaultPriorityId,
  getDefaultStatusId,
  t,
  tn
} from '@dotpm/core'

export class ReplaceTaskModal extends Modal {
  constructor(
    app: App,
    private plugin: PMPlugin,
    private project: Project,
    private source: Task,
    private onComplete: (replacement: Task) => void | Promise<void>
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl } = this
    this.modalEl.addClass('pm-replace-modal')
    contentEl.createEl('h2', { text: t('replace.title') })
    contentEl.createEl('p', {
      text: t('replace.intro', { title: this.source.title }),
      cls: 'pm-replace-intro'
    })

    const config = this.plugin.store.configFor(this.project)
    const allTasks = flattenTasks(this.project.tasks).map((entry) => entry.task)
    const candidates = getReplacementCandidates(this.source, allTasks, config.statuses)
    const localDependentIds = allTasks
      .filter((task) => task.id !== this.source.id && task.dependencies.includes(this.source.id))
      .map((task) => task.id)
    const externalDependentIds = this.plugin.index
      .dependents(this.source.id)
      .filter((ref) => ref.projectPath !== this.project.filePath)
      .map((ref) => ref.id)
    const dependentIds = new Set([...localDependentIds, ...externalDependentIds])
    const activeSubtasks = excludeSupersededTasks(this.source.subtasks)

    const modeRow = contentEl.createDiv('pm-replace-field')
    modeRow.createEl('label', { text: t('replace.replacement') })
    const modeSelect = modeRow.createEl('select')
    modeSelect.createEl('option', { value: 'new', text: t('replace.createNew') })
    modeSelect.createEl('option', { value: 'existing', text: t('replace.useExisting') })

    const newRow = contentEl.createDiv('pm-replace-field')
    newRow.createEl('label', { text: t('replace.newTaskTitle') })
    const titleInput = newRow.createEl('input', {
      type: 'text',
      value: t('replace.replacementTitle', { title: this.source.title }),
      cls: 'pm-replace-input'
    })

    const datesRow = contentEl.createDiv('pm-replace-dates')
    let startInput: HTMLInputElement | null = null
    if (this.source.type !== 'milestone') {
      const startField = datesRow.createDiv('pm-replace-field')
      startField.createEl('label', { text: t('taskForm.start') })
      startInput = startField.createEl('input', {
        type: 'date',
        value: this.source.start
      })
    }
    const dueField = datesRow.createDiv('pm-replace-field')
    dueField.createEl('label', {
      text: this.source.type === 'milestone' ? t('taskForm.date') : t('taskForm.due')
    })
    const dueInput = dueField.createEl('input', {
      type: 'date',
      value: this.source.due
    })

    const existingRow = contentEl.createDiv('pm-replace-field pm-hidden')
    existingRow.createEl('label', { text: t('replace.existingTask') })
    const existingSelect = existingRow.createEl('select')
    existingSelect.createEl('option', { value: '', text: t('replace.selectTask') })
    for (const task of candidates) existingSelect.createEl('option', { value: task.id, text: task.title })

    let duplicateSubtasks = false
    if (activeSubtasks.length > 0) {
      const duplicateRow = contentEl.createEl('label', { cls: 'pm-replace-checkbox' })
      const duplicateCheckbox = duplicateRow.createEl('input', { type: 'checkbox' })
      duplicateRow.createSpan({
        text: tn('replace.duplicateSubtasks', activeSubtasks.length)
      })
      duplicateCheckbox.addEventListener('change', () => {
        duplicateSubtasks = duplicateCheckbox.checked
      })
    }

    const preview = contentEl.createDiv('pm-replace-preview')
    preview.createEl('h3', { text: t('replace.changesHeading') })
    const depsPreview = preview.createEl('p')
    const dependentsPreview = preview.createEl('p')

    const updatePreview = (): void => {
      const selected =
        modeSelect.value === 'existing' ? candidates.find((task) => task.id === existingSelect.value) : undefined
      const inheritedCount = selected
        ? this.source.dependencies.filter((id) => !selected.dependencies.includes(id)).length
        : this.source.dependencies.length
      depsPreview.setText(
        inheritedCount ? t('replace.inheritedDeps', { count: inheritedCount }) : t('replace.inheritedDepsNone')
      )
      const redirectedCount = [...dependentIds].filter((id) => id !== selected?.id).length
      dependentsPreview.setText(
        redirectedCount ? t('replace.dependentsToRedirect', { count: redirectedCount }) : t('replace.dependentsNone')
      )
    }

    const showMode = (): void => {
      const existing = modeSelect.value === 'existing'
      newRow.toggleClass('pm-hidden', existing)
      datesRow.toggleClass('pm-hidden', existing)
      existingRow.toggleClass('pm-hidden', !existing)
      updatePreview()
    }
    modeSelect.addEventListener('change', showMode)
    existingSelect.addEventListener('change', updatePreview)
    updatePreview()

    const errorEl = contentEl.createDiv('pm-replace-error')
    const buttons = contentEl.createDiv('pm-modal-btn-row')
    let submitting = false
    new ButtonComponent(buttons).setButtonText(t('common.cancel')).onClick(() => this.close())
    const submitButton = new ButtonComponent(buttons).setButtonText(t('replace.submit')).setCta()
    submitButton.onClick(async () => {
      if (submitting) return
      errorEl.empty()
      let replacement: Task | undefined
      if (modeSelect.value === 'existing') {
        replacement = candidates.find((task) => task.id === existingSelect.value)
        if (!replacement) {
          errorEl.setText(t('replace.selectExisting'))
          return
        }
      } else {
        const title = titleInput.value.trim()
        if (!title) {
          errorEl.setText(t('replace.enterTitle'))
          titleInput.focus()
          return
        }
        const rawStart = startInput?.value ?? ''
        const rawDue = dueInput.value ?? ''
        const start = this.source.type === 'milestone' ? '' : rawStart
        const due = start && rawDue && rawDue < start ? start : rawDue
        replacement = makeTask({
          title,
          type: this.source.type,
          status: getDefaultStatusId(config.statuses),
          priority: getDefaultPriorityId(config.priorities),
          start,
          due
        })
      }

      submitting = true
      submitButton.setDisabled(true)
      try {
        await this.plugin.store.replaceTask(this.project, this.source.id, replacement, { duplicateSubtasks })
        await this.plugin.store.scheduleAfterChange(this.project, replacement.id)
        new Notice(t('replace.replacedNotice', { source: this.source.title, replacement: replacement.title }))
        this.close()
        void (async () => {
          try {
            await this.onComplete(replacement)
          } catch (error) {
            console.error('[PM] View refresh after replacement failed', error)
            new Notice(t('replace.viewRefreshFailed'))
          }
        })()
      } catch (error) {
        submitting = false
        errorEl.setText(error instanceof Error ? error.message : t('replace.couldNotReplace'))
        submitButton.setDisabled(false)
      }
    })

    window.setTimeout(() => titleInput.focus(), 10)
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
