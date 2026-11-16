import { App, ButtonComponent, Modal, Notice } from 'obsidian'
import type PMPlugin from '#main'
import {
  makeTask,
  type Project,
  type Task,
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
    const dependents = this.plugin.index.dependents(this.source.id)

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

    const existingRow = contentEl.createDiv('pm-replace-field pm-hidden')
    existingRow.createEl('label', { text: t('replace.existingTask') })
    const existingSelect = existingRow.createEl('select')
    existingSelect.createEl('option', { value: '', text: t('replace.selectTask') })
    for (const task of candidates) existingSelect.createEl('option', { value: task.id, text: task.title })

    let duplicateSubtasks = false
    if (this.source.subtasks.length > 0) {
      const duplicateRow = contentEl.createEl('label', { cls: 'pm-replace-checkbox' })
      const duplicateCheckbox = duplicateRow.createEl('input', { type: 'checkbox' })
      duplicateRow.createSpan({
        text: tn('replace.duplicateSubtasks', this.source.subtasks.length)
      })
      duplicateCheckbox.addEventListener('change', () => {
        duplicateSubtasks = duplicateCheckbox.checked
      })
    }

    const preview = contentEl.createDiv('pm-replace-preview')
    preview.createEl('h3', { text: t('replace.changesHeading') })
    preview.createEl('p', {
      text: this.source.dependencies.length
        ? t('replace.inheritedDeps', { count: this.source.dependencies.length })
        : t('replace.inheritedDepsNone')
    })
    preview.createEl('p', {
      text: dependents.length
        ? t('replace.dependentsToRedirect', { count: dependents.length })
        : t('replace.dependentsNone')
    })

    const showMode = (): void => {
      const existing = modeSelect.value === 'existing'
      newRow.toggleClass('pm-hidden', existing)
      existingRow.toggleClass('pm-hidden', !existing)
    }
    modeSelect.addEventListener('change', showMode)

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
        replacement = makeTask({
          title,
          status: getDefaultStatusId(config.statuses),
          priority: getDefaultPriorityId(config.priorities),
          start: '',
          due: ''
        })
      }

      submitting = true
      submitButton.setDisabled(true)
      try {
        await this.plugin.store.replaceTask(this.project, this.source.id, replacement, { duplicateSubtasks })
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
