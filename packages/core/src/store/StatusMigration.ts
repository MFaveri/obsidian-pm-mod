import { t } from '../i18n'
import { SUPERSEDED_STATUS, type StatusConfig } from '../types'

/** Add or migrate the built-in replacement-history status without touching customization. */
export function ensureSupersededStatus(statuses: StatusConfig[]): boolean {
  const localized = { ...SUPERSEDED_STATUS, label: t('status.superseded') }
  const existing = statuses.find((status) => status.id === SUPERSEDED_STATUS.id)
  if (!existing) {
    statuses.push(localized)
    return true
  }
  if (existing.label === 'Substituída' && existing.icon === 'replace' && existing.color === '#767491') {
    Object.assign(existing, localized)
    return true
  }
  return false
}
