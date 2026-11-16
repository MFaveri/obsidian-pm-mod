import { SUPERSEDED_STATUS, type StatusConfig } from '../types'

/** Add or migrate the built-in replacement-history status without touching customization. */
export function ensureSupersededStatus(statuses: StatusConfig[]): boolean {
  const existing = statuses.find((status) => status.id === SUPERSEDED_STATUS.id)
  if (!existing) {
    statuses.push({ ...SUPERSEDED_STATUS })
    return true
  }
  if (existing.label === 'Substituída' && existing.icon === 'replace' && existing.color === '#767491') {
    Object.assign(existing, SUPERSEDED_STATUS)
    return true
  }
  return false
}
