import { Checkbox } from '#primitives/Checkbox'
import { Chip } from '#primitives/Chip'
import { Popover } from '#primitives/Popover'
import { type NonWorkingDays, formatDateLong, parsePlainDate, t } from '@dotpm/core'
import { renderAddButton } from '../addButton'

export interface NonWorkingDaysProps {
  /** Edited in place. */
  days: NonWorkingDays
  /** The vault's holidays, `YYYY-MM-DD`, in order. */
  holidays: string[]
  onChange: () => void
  onHolidaysChange: (holidays: string[]) => void
  /** Optional link to open the active project's schedule settings. */
  onOpenProjectCalendar?: () => void
}

/** Whether the timeline leaves out weekends and holidays, and the holiday list itself. */
export function renderNonWorkingDaysPanel(
  parent: HTMLElement,
  props: NonWorkingDaysProps,
  close?: () => void
): void {
  const body = parent.createDiv('pm-days-pop')
  const { days } = props
  let holidays = [...props.holidays]
  let list: HTMLElement

  const toggle = (key: keyof NonWorkingDays, label: string, onUpdate: () => void): Checkbox => {
    const row = body.createEl('label', { cls: 'pm-group-row' })
    row.createSpan({ cls: 'pm-group-label', text: label })
    return new Checkbox(row).setChecked(!!days[key]).onChange((checked) => {
      if (checked) days[key] = true
      else Reflect.deleteProperty(days, key)
      onUpdate()
      props.onChange()
    })
  }

  const setHolidays = (next: string[]): void => {
    holidays = [...new Set(next)].sort()
    props.onHolidaysChange(holidays)
    renderList()
  }

  const render = (): void => {
    body.empty()
    const syncAll = (): void => {
      const count = Number(!!days.weekends) + Number(!!days.holidays) + Number(!!days.timeOff)
      allBox.setChecked(count === 3).setIndeterminate(count > 0 && count < 3)
    }
    const weekendBox = toggle('weekends', t('timeline.hideWeekends'), syncAll)
    const holidayBox = toggle('holidays', t('timeline.hideHolidays'), syncAll)
    const timeOffBox = toggle('timeOff', t('timeline.hideTimeOff'), syncAll)
    const allRow = body.createEl('label', { cls: 'pm-group-row pm-days-all' })
    allRow.createSpan({ cls: 'pm-group-label', text: t('timeline.hideAllNonWorking') })
    const allBox = new Checkbox(allRow).onChange((checked) => {
      for (const [key, box] of [
        ['weekends', weekendBox],
        ['holidays', holidayBox],
        ['timeOff', timeOffBox]
      ] as const) {
        if (checked) days[key] = true
        else Reflect.deleteProperty(days, key)
        box.setChecked(checked)
      }
      props.onChange()
    })
    syncAll()
    list = body.createDiv('pm-days-list')
    renderList()
    body.createDiv({ cls: 'pm-days-note', text: t('timeline.holidaysNote') })
    if (props.onOpenProjectCalendar) {
      const openProject = props.onOpenProjectCalendar
      const link = body.createEl('button', {
        type: 'button',
        cls: 'pm-days-project-link',
        text: t('timeline.configureProjectDays')
      })
      link.addEventListener('click', () => {
        close?.()
        openProject()
      })
    }
  }

  const renderList = (): void => {
    list.empty()
    for (const date of holidays) {
      new Chip(list)
        .setLabel(formatDateLong(date) || date)
        .setVariant('outline')
        .setSize('sm')
        .setRemovable(() => setHolidays(holidays.filter((d) => d !== date)), t('timeline.removeHoliday'))
        .el.addClass('pm-days-chip')
    }
    const add = renderAddButton(list, t('timeline.addHoliday'), () => {
      const input = list.createEl('input', { type: 'date', cls: 'pm-days-input' })
      add.replaceWith(input)
      input.focus()
      input.addEventListener('change', () => {
        if (parsePlainDate(input.value)) setHolidays([...holidays, input.value])
      })
      input.addEventListener('blur', () => {
        if (input.isConnected) renderList()
      })
    })
  }

  render()
}

/** The non-working days panel in a popover under `anchor`. */
export const openNonWorkingDaysPopover = (anchor: HTMLElement, props: NonWorkingDaysProps): Popover => {
  const pop = Popover.show({ anchor, width: 280 }, (el) => renderNonWorkingDaysPanel(el, props, () => pop.close()))
  return pop
}
