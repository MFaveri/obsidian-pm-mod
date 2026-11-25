import { Menu } from 'obsidian'
import type PMPlugin from '#main'
import { nextTierName, normalizeTier, t } from '@dotpm/core'
import { safeAsync } from '@dotpm/ui'
import { promptText } from './ModalFactory'

/**
 * Opens a menu listing every configured/used project tier plus a "New tier…" option.
 * Calls `onPick` with the selected (or newly created) tier name.
 */
export function openProjectTierMenu(
  e: MouseEvent,
  plugin: PMPlugin,
  currentTier: string | undefined,
  onPick: (tier: string) => Promise<void> | void
): void {
  e.stopPropagation()
  const current = normalizeTier(currentTier)
  const tiers = plugin.index.allProjectTiers()
  const menu = new Menu()

  for (const tier of tiers) {
    menu.addItem((item) =>
      item
        .setTitle(tier)
        .setChecked(tier === current)
        .onClick(safeAsync(async () => onPick(tier)))
    )
  }

  menu.addSeparator()
  menu.addItem((item) =>
    item
      .setTitle(t('project.newTier'))
      .setIcon('plus')
      .onClick(
        safeAsync(async () => {
          const suggested = nextTierName(tiers)
          const raw = await promptText(plugin.app, t('project.newTierName'), suggested, suggested)
          if (!raw) return
          const created = normalizeTier(raw)
          if (!plugin.settings.projectTiers.includes(created)) {
            plugin.settings.projectTiers.push(created)
            await plugin.saveSettings()
          }
          await onPick(created)
        })
      )
  )

  menu.showAtMouseEvent(e)
}
