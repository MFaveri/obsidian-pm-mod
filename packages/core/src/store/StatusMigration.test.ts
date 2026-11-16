import { describe, expect, it } from 'vitest'
import type { StatusConfig } from '../types'
import { ensureSupersededStatus } from './StatusMigration'

const TODO: StatusConfig = { id: 'todo', label: 'To Do', color: '#888', icon: '', complete: false }

describe('superseded status migration', () => {
  it('adds the terminal replacement status', () => {
    const statuses = [TODO]
    expect(ensureSupersededStatus(statuses)).toBe(true)
    expect(statuses[1]).toEqual({
      id: 'superseded',
      label: 'Replaced',
      color: '#767491',
      icon: '',
      complete: true
    })
  })

  it('migrates the previous experimental status', () => {
    const statuses: StatusConfig[] = [
      TODO,
      { id: 'superseded', label: 'Substituída', color: '#767491', icon: 'replace', complete: true }
    ]
    expect(ensureSupersededStatus(statuses)).toBe(true)
    expect(statuses[1]).toMatchObject({ label: 'Replaced', icon: '', complete: true })
  })

  it('does not overwrite a custom status with the same id', () => {
    const statuses: StatusConfig[] = [
      TODO,
      { id: 'superseded', label: 'Custom', color: '#123456', icon: '', complete: true }
    ]
    expect(ensureSupersededStatus(statuses)).toBe(false)
    expect(statuses[1].label).toBe('Custom')
  })
})
